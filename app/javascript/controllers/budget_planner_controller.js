import { Controller } from "@hotwired/stimulus";
import * as d3 from "d3";
import { drawPlannerChart, plannerChartTooltip } from "utils/planner_chart";

const UNCATEGORIZED = "uncategorized";
const DIRECT = ":direct";
const STORE = {
  hidden: "budgetPlanner.panelHidden",
  sort: "budgetPlanner.sort",
  chart: "budgetPlanner.chart",
};
const LONG_PRESS_MS = 550;

// Connects to data-controller="budget-planner"
//
// Spending is kept per leaf category and month. Every node sums its leaves
// month by month, so a node's average and median are taken over its own
// monthly totals — summing children's medians would not give the parent's.
//
// With a plan selected, the hierarchy, names, colours and icons come from
// the plan (see BudgetPlan) and everything on the page follows it. Changing
// categories with no plan selected starts one. Excluded categories stay on
// the page but are left out of totals, averages and the chart.
export default class extends Controller {
  static targets = [
    "circles",
    "history",
    "historyTitle",
    "excludedNote",
    "panel",
    "panelCard",
    "chartsColumn",
    "expandPanel",
    "budgetTotal",
    "incomeSlot",
    "remaining",
    "remainingRow",
    "apply",
    "planId",
    "draftSummary",
    "draftStatus",
    "newGroupName",
    "planSelect",
    "newPlanForm",
    "newPlanName",
    "newPlanFrom",
    "newPlanButton",
    "sortSelect",
    "customRange",
    "customRangeButton",
    "removeDialog",
    "removeTitle",
    "removeChildrenNote",
    "removeTargetFields",
    "removeTargetLabel",
    "removeTarget",
    "removeNewNameField",
    "removeNewName",
    "removeError",
    "appearance",
    "appearanceTitle",
    "appearanceColors",
    "appearanceColorNote",
    "iconSprites",
    "chartCard",
    "chartControl",
    "enlargeButton",
    "growthInput",
    "growthOutput",
    "chartChips",
    "chartOverview",
    "chartNote",
    "chartKey",
  ];
  static values = {
    history: Object,
    plan: Object,
    draft: Object,
    labels: Object,
    colors: Array,
  };

  // Amount per top-level node id (category, group key or UNCATEGORIZED).
  #amounts = new Map();
  // Amounts the user chose (typed or reset from the menu); Fill leaves them.
  #edited = new Set();
  #expectedIncome = 0;
  #plan = null;
  #liveExcluded = new Set();
  #hidden = new Set();
  #selected = null;
  #removing = null;
  #panelHidden = false;
  #sort = "spending";
  #saveTimer = null;
  #creatingPlan = null;
  #menu = null;
  #menuReturnFocus = null;
  #appearanceFor = null;
  #resizeObserver = null;
  // Chart options (remembered per browser), the categories it shows, the
  // months in view and the hovered month.
  #chart = {
    view: "lines",
    rolling: false,
    fit: "yearly",
    fitFor: "focus",
    shade: "focus",
    cycles: true,
    colourAll: false,
    ahead: 0,
    growth: 0,
    compound: true,
  };
  #chartShown = null;
  #chartWindow = null;
  #chartHover = null;
  #enlarged = false;

  connect() {
    this.#plan = this.draftValue.plan
      ? structuredClone(this.draftValue.plan)
      : null;
    this.#panelHidden = this.#read(STORE.hidden) === "1";
    this.#sort = this.#read(STORE.sort) || "spending";
    if (this.hasSortSelectTarget) this.sortSelectTarget.value = this.#sort;

    this.#loadChartOptions();
    this.#startAmounts();
    this.#applyLayout();
    this.#draw();
    this.#resizeObserver = new ResizeObserver(() => this.#drawCharts());
    this.#resizeObserver.observe(this.circlesTarget);
    this.closeMenus = this.closeMenus.bind(this);
    document.addEventListener("pointerdown", this.closeMenus);
    document.addEventListener("keydown", this.closeMenus);
  }

  disconnect() {
    this.#resizeObserver?.disconnect();
    clearTimeout(this.#saveTimer);
    document.removeEventListener("pointerdown", this.closeMenus);
    document.removeEventListener("keydown", this.closeMenus);
    this.#closeMenu();
    plannerChartTooltip.remove();
  }

  // --- actions: page ---

  toggleCustomRange() {
    const hidden = this.customRangeTarget.classList.toggle("hidden");
    this.customRangeTarget.classList.toggle("flex", !hidden);
    this.customRangeButtonTarget.setAttribute("aria-expanded", String(!hidden));
  }

  choosePlan(event) {
    this.#visitWith({ plan: event.currentTarget.value });
  }

  changeSort(event) {
    this.#sort = event.currentTarget.value;
    this.#write(STORE.sort, this.#sort);
    this.#draw();
  }

  hidePanel() {
    this.#panelHidden = true;
    this.#write(STORE.hidden, "1");
    this.#applyLayout();
    this.#drawCharts();
  }

  showPanel() {
    this.#panelHidden = false;
    this.#write(STORE.hidden, "0");
    this.#applyLayout();
    this.#draw();
  }

  select(event) {
    const id = event.currentTarget.dataset.nodeId;
    this.#selected = this.#selected === id ? null : id;
    this.#draw();
  }

  // --- actions: plans ---

  toggleNewPlan() {
    const hidden = this.newPlanFormTarget.classList.toggle("hidden");
    this.newPlanButtonTarget.setAttribute("aria-expanded", String(!hidden));
    if (!hidden) this.newPlanNameTarget.focus();
  }

  async createPlan() {
    const input = this.newPlanNameTarget;
    const name = input.value.trim();
    input.setAttribute("aria-invalid", String(!name));
    if (!name) return;

    const from = this.newPlanFromTargets.find((radio) => radio.checked)?.value;
    const body = { name };
    if (from && from !== "current") body.copy_of_id = from;
    const result = await this.#request(
      "POST",
      this.draftValue.create_url,
      body,
    );
    if (result.ok) this.#visitWith({ plan: result.body.id });
    else this.#status(this.#saveError(result));
  }

  async renamePlan() {
    if (!this.#plan) return;
    const name = window
      .prompt(
        this.#label("menu.rename_prompt", { name: this.#plan.name }),
        this.#plan.name,
      )
      ?.trim();
    if (!name || name === this.#plan.name) return;

    const result = await this.#request("PATCH", this.#plan.url, {
      plan: { name },
    });
    if (!result.ok) {
      this.#status(this.#saveError(result));
      return;
    }
    this.#plan.name = name;
    const option = this.planSelectTarget.querySelector(
      `option[value="${this.#plan.id}"]`,
    );
    if (option) option.textContent = name;
    this.#status(this.#label("saved"));
  }

  async addGroup() {
    const input = this.newGroupNameTarget;
    const name = input.value.trim();
    const taken = this.#nameTaken(name);
    input.setAttribute("aria-invalid", String(!name || taken));
    if (!name || taken || !(await this.#ensurePlan())) return;

    this.#plan.groups.push({
      key: this.#newKey(),
      name,
      color:
        this.colorsValue[this.#plan.groups.length % this.colorsValue.length],
      icon: "folder",
    });
    input.value = "";
    this.#afterPlanChange();
  }

  // --- actions: amounts ---

  fill(event) {
    const source = event.currentTarget.dataset.source;
    for (const top of this.#listedTops(this.#tree)) {
      if (!this.#budgetable(top) || this.#edited.has(top.id)) continue;
      this.#amounts.set(top.id, this.#amountFrom(top, source));
    }
    this.#draw();
  }

  editAmount(event) {
    const input = event.currentTarget;
    this.#amounts.set(input.dataset.nodeId, this.#parse(input.value));
    this.#edited.add(input.dataset.nodeId);
    this.#markInvalid(input);
    this.#updateTotals();
    this.#scheduleChart();
  }

  editIncome(event) {
    this.#expectedIncome = this.#parse(event.currentTarget.value);
    this.#updateTotals();
  }

  // --- actions: colour and icon ---

  pickColor(event) {
    this.#setAppearance({ color: event.currentTarget.dataset.color });
  }

  pickIcon(event) {
    if (event.target.type === "radio")
      this.#setAppearance({ icon: event.target.value });
  }

  closeAppearance() {
    this.appearanceTarget.classList.add("hidden");
    this.#appearanceFor = null;
  }

  closeMenus(event) {
    if (event.type === "keydown" && event.key !== "Escape") return;
    const inside = (el) =>
      el && event.target instanceof Node && el.contains(event.target);
    if (
      event.type === "pointerdown" &&
      (inside(this.#menu) ||
        inside(this.appearanceTarget) ||
        inside(this.removeDialogTarget))
    )
      return;
    this.#closeMenu();
    this.closeAppearance();
    if (event.type === "keydown") {
      this.closeRemove();
      if (this.#enlarged) this.toggleEnlarge();
      if (
        this.hasNewPlanFormTarget &&
        !this.newPlanFormTarget.classList.contains("hidden")
      )
        this.toggleNewPlan();
    }
  }

  // --- actions: chart ---

  chartOption(event) {
    const { option, value } = event.currentTarget.dataset;
    const parsed =
      value === "true"
        ? true
        : value === "false"
          ? false
          : /^\d+$/.test(value)
            ? Number(value)
            : value;
    this.#chart[option] = parsed;
    this.#saveChartOptions();
    this.#drawChart();
  }

  chartGrowth(event) {
    this.#chart.growth = Number(event.currentTarget.value);
    this.#saveChartOptions();
    this.#drawChart();
  }

  chartPick(event) {
    const parents = this.#chartParents(this.#tree);
    const pick = event.currentTarget.dataset.pick;
    if (pick === "all") this.#chartShown = new Set(parents.map((p) => p.id));
    else if (pick === "none") this.#chartShown = new Set();
    else this.#chartShown = new Set(this.#topParents(parents));
    this.#drawChart();
  }

  toggleEnlarge() {
    this.#enlarged = !this.#enlarged;
    const card = this.chartCardTarget;
    for (const cls of ["fixed", "inset-4", "z-40", "overflow-y-auto"])
      card.classList.toggle(cls, this.#enlarged);
    this.enlargeButtonTarget.setAttribute(
      "aria-pressed",
      String(this.#enlarged),
    );
    this.#drawChart();
  }

  #loadChartOptions() {
    try {
      Object.assign(this.#chart, JSON.parse(this.#read(STORE.chart) || "{}"));
    } catch {}
  }

  #saveChartOptions() {
    this.#write(STORE.chart, JSON.stringify(this.#chart));
  }

  // --- plan state ---

  get #excluded() {
    return this.#plan ? new Set(this.#plan.excluded) : this.#liveExcluded;
  }

  get #categoriesById() {
    return new Map(this.historyValue.categories.map((c) => [c.id, c]));
  }

  #removed(id) {
    return Boolean(this.#plan && Object.hasOwn(this.#plan.removals, id));
  }

  #parentOf(id) {
    if (this.#plan && Object.hasOwn(this.#plan.parents, id))
      return this.#plan.parents[id];
    return this.#categoriesById.get(id)?.parent_id ?? null;
  }

  // Categories and the plan's new categories under `id`.
  #childrenOf(id) {
    const categories = this.historyValue.categories.filter(
      (c) => !this.#removed(c.id) && this.#parentOf(c.id) === id,
    );
    const created = (this.#plan?.groups || [])
      .filter((g) => this.#parentOf(g.key) === id)
      .map((g) => ({ id: g.key, parent_id: null, isNew: true }));
    return [...categories, ...created];
  }

  #group(key) {
    return this.#plan?.groups.find((g) => g.key === key);
  }

  // Name, colour and icon as the plan would leave them.
  #look(id) {
    const group = this.#group(id);
    if (group)
      return {
        name: group.name,
        color: group.color,
        icon: group.icon || "folder",
      };
    const category = this.#categoriesById.get(id);
    if (!category) return null;
    const override = this.#plan?.overrides[id] || {};
    return {
      name: override.name || category.name,
      color: override.color || category.color,
      icon: override.icon || category.icon,
    };
  }

  #nameTaken(name, exceptId = null) {
    const lower = name.toLowerCase();
    const names = this.historyValue.categories
      .filter((c) => c.id !== exceptId && !this.#removed(c.id))
      .map((c) => this.#look(c.id).name);
    const groups = (this.#plan?.groups || [])
      .filter((g) => g.key !== exceptId)
      .map((g) => g.name);
    return [...names, ...groups].some((n) => n.toLowerCase() === lower);
  }

  // Sure keeps two levels: only a category with no subcategories can go
  // under another, and only under a top-level one. Uncategorized only
  // holds the plan's new categories.
  #canMove(id, target) {
    const isNew = Boolean(this.#group(id));
    if (target === null) return true;
    if (target === id || this.#childrenOf(id).length > 0) return false;
    if (target === UNCATEGORIZED) return isNew;
    if (this.#group(target)) return this.#parentOf(target) === null;
    return (
      this.#categoriesById.has(target) &&
      !this.#removed(target) &&
      this.#parentOf(target) === null
    );
  }

  // Starts a plan the first time categories are changed with none selected.
  async #ensurePlan() {
    if (this.#plan) return true;
    if (!this.draftValue.can_edit) return false;
    this.#creatingPlan ||= this.#createDefaultPlan();
    const ok = await this.#creatingPlan;
    this.#creatingPlan = null;
    return ok;
  }

  async #createDefaultPlan() {
    this.#status(this.#label("creating_plan"));
    const taken = new Set(
      this.draftValue.plans.map((p) => p.name.toLowerCase()),
    );
    const base = this.#label("default_plan_name");
    let name = base;
    for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${base} ${n}`;

    const result = await this.#request("POST", this.draftValue.create_url, {
      name,
    });
    if (!result.ok) {
      this.#status(this.#saveError(result));
      return false;
    }
    this.#plan = { ...result.body, excluded: [...this.#liveExcluded] };
    this.planSelectTarget.append(new Option(name, this.#plan.id, true, true));
    const url = new URL(window.location.href);
    url.searchParams.set("plan", this.#plan.id);
    window.history.replaceState(window.history.state, "", url);
    return true;
  }

  async #changePlan(change) {
    if (!(await this.#ensurePlan())) return;
    change(this.#plan);
    this.#afterPlanChange();
  }

  #afterPlanChange() {
    this.#syncAmounts();
    this.#draw();
    this.#scheduleSave();
  }

  #scheduleSave() {
    if (!this.#plan) return;
    clearTimeout(this.#saveTimer);
    this.#status(this.#label("saving"));
    this.#saveTimer = setTimeout(() => this.#save(), 500);
  }

  async #save() {
    const { parents, groups, overrides, excluded, removals } = this.#plan;
    const result = await this.#request("PATCH", this.#plan.url, {
      plan: { parents, groups, overrides, excluded, removals },
    });
    this.#status(result.ok ? this.#label("saved") : this.#saveError(result));
  }

  async #request(method, url, body) {
    const token = document.querySelector('meta[name="csrf-token"]')?.content;
    try {
      const response = await fetch(url, {
        method,
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "X-CSRF-Token": token,
        },
        body: JSON.stringify(body),
      });
      const json = await response.json().catch(() => ({}));
      return { ok: response.ok, status: response.statusText, body: json };
    } catch (error) {
      return { ok: false, status: error.message, body: {} };
    }
  }

  #saveError(result) {
    return this.#label("save_failed", {
      error: (result.body.errors || [result.status]).join(", "),
    });
  }

  #status(text) {
    if (this.hasDraftStatusTarget) this.draftStatusTarget.textContent = text;
  }

  #visitWith(params) {
    const url = new URL(window.location.href);
    for (const [key, value] of Object.entries(params))
      url.searchParams.set(key, value);
    if (window.Turbo) window.Turbo.visit(url.toString());
    else window.location.assign(url);
  }

  #newKey() {
    const bytes = crypto.getRandomValues(new Uint8Array(4));
    return `new-${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
  }

  #read(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }

  #write(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {}
  }

  #applyLayout() {
    const card = this.panelCardTarget;
    card.style.display = this.#panelHidden ? "none" : "";
    this.expandPanelTarget.classList.toggle("hidden", !this.#panelHidden);
    this.expandPanelTarget.classList.toggle("flex", this.#panelHidden);

    const charts = this.chartsColumnTarget.classList;
    charts.toggle("@4xl:col-span-5", this.#panelHidden);
    charts.toggle("@4xl:col-span-3", !this.#panelHidden);
  }

  #updatePlanSummary() {
    if (this.hasPlanIdTarget) this.planIdTarget.value = this.#plan?.id || "";
    if (!this.hasDraftSummaryTarget) return;

    const plan = this.#plan;
    const counts = plan && {
      moves: Object.keys(plan.parents).length,
      groups: plan.groups.length,
      renames: Object.keys(plan.overrides).length,
      removals: Object.keys(plan.removals).length,
    };
    const changes = counts
      ? Object.entries(counts)
          .filter(([, count]) => count > 0)
          .map(([key, count]) => this.#label(`changes.${key}`, { count }))
      : [];
    this.draftSummaryTarget.classList.toggle("hidden", changes.length === 0);
    this.draftSummaryTarget.textContent = this.#label("plan_summary", {
      changes: changes.join(", "),
    });
  }

  // --- amounts ---

  #startAmounts() {
    const plan = this.planValue;
    for (const top of this.#listedTops(this.#tree)) {
      if (!this.#budgetable(top)) continue;
      this.#amounts.set(
        top.id,
        this.#amountFrom(top, plan.initialized ? "current" : "average"),
      );
    }
    this.#expectedIncome = Math.round(
      plan.expected_income ?? d3.sum(this.#includedIncome, (r) => r.average),
    );
  }

  #currentAmount(id) {
    const plan = this.planValue;
    if (id === UNCATEGORIZED) return plan.uncategorized;
    return plan.amounts[id] ?? plan.own_amounts?.[id] ?? null;
  }

  // "current" falls back to the average for a top whose contents the plan
  // changed (its current amount was for something else) or that has none.
  #amountFrom(top, source) {
    if (source === "current") {
      const current = this.#currentAmount(top.id);
      return Math.round(
        current != null && !top.changed ? current : top.average,
      );
    }
    return Math.round(top[source] || 0);
  }

  // After the plan changes: new tops get an amount, tops whose contents
  // changed follow their new average unless chosen, and nodes that are no
  // longer top-level drop out.
  #syncAmounts() {
    const tops = this.#listedTops(this.#tree).filter((t) =>
      this.#budgetable(t),
    );
    const ids = new Set(tops.map((t) => t.id));
    for (const id of [...this.#amounts.keys()])
      if (!ids.has(id)) this.#amounts.delete(id);
    for (const top of tops) {
      if (
        this.#amounts.has(top.id) &&
        (this.#edited.has(top.id) || !top.changed)
      )
        continue;
      this.#amounts.set(top.id, this.#amountFrom(top, "current"));
    }
  }

  #budgetable(top) {
    return (
      top.id === UNCATEGORIZED ||
      Boolean(this.#group(top.id)) ||
      this.#categoriesById.has(top.id)
    );
  }

  #parse(value) {
    const number = Number.parseFloat(String(value).replace(/[^0-9.-]/g, ""));
    return Number.isFinite(number) ? number : 0;
  }

  // Subcategories that keep their place keep their own amount, which the
  // parent's must cover. Moved ones will share their new parent's budget.
  #minimum(id) {
    const own = this.planValue.own_amounts || {};
    return d3.sum(
      this.historyValue.categories.filter(
        (c) =>
          c.parent_id === id &&
          this.#parentOf(c.id) === id &&
          !this.#removed(c.id),
      ),
      (c) => own[c.id] || 0,
    );
  }

  #markInvalid(input) {
    const id = input.dataset.nodeId;
    const invalid = this.#amounts.get(id) < this.#minimum(id);
    input.setAttribute("aria-invalid", String(invalid));
    input.classList.toggle("text-destructive", invalid);
    input
      .closest("li")
      ?.querySelector("[data-minimum-note]")
      ?.classList.toggle("hidden", !invalid);
  }

  // Top-level categories without an input keep their current amount.
  #budgetTotal() {
    const unlisted = this.historyValue.categories
      .filter(
        (c) =>
          !this.#removed(c.id) &&
          this.#parentOf(c.id) === null &&
          !this.#amounts.has(c.id),
      )
      .reduce((sum, c) => sum + (this.#currentAmount(c.id) || 0), 0);
    return d3.sum([...this.#amounts.values()]) + unlisted;
  }

  #updateTotals() {
    const money = this.#money;
    const total = this.#budgetTotal();
    const remaining = this.#expectedIncome - total;
    this.budgetTotalTarget.textContent = money.format(total);
    this.remainingTarget.textContent = money.format(remaining);
    const row = this.remainingRowTarget.classList;
    row.toggle("bg-success/10", remaining >= 0);
    row.toggle("text-success", remaining >= 0);
    row.toggle("bg-destructive/10", remaining < 0);
    row.toggle("text-destructive", remaining < 0);

    if (this.hasApplyTarget) {
      this.applyTarget.disabled =
        Boolean(this.#plan?.stale) ||
        [...this.#amounts].some(([id, amount]) => amount < this.#minimum(id));
    }
    this.#updatePlanSummary();
  }

  // --- data ---

  get #periodCount() {
    return this.historyValue.periods.length;
  }

  get #money() {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: this.historyValue.currency,
      maximumFractionDigits: 0,
    });
  }

  #label(key, vars = {}) {
    const text = key
      .split(".")
      .reduce((node, part) => node?.[part], this.labelsValue);
    return String(text ?? key).replace(
      /%\{(\w+)\}/g,
      (_, name) => vars[name] ?? "",
    );
  }

  #zeros() {
    return new Array(this.#periodCount).fill(0);
  }

  // A category's own spending plus that of categories the plan removes by
  // moving their transactions to it.
  #spendingOf(id) {
    const { spending } = this.historyValue;
    let series = spending[id];
    for (const [source, target] of Object.entries(this.#plan?.removals || {})) {
      if (target !== id || !spending[source]) continue;
      series = (series || this.#zeros()).map((v, i) => v + spending[source][i]);
    }
    return series;
  }

  // Top-level nodes, each with leaf children. A category's own transactions
  // become a "(direct)" leaf so its circle's size matches its total. Each
  // node has `series` (all spending) and `analysis` (without excluded).
  get #tree() {
    const { categories, spending, uncategorized } = this.historyValue;
    const excluded = this.#excluded;

    const tops = categories
      .filter((c) => !this.#removed(c.id) && this.#parentOf(c.id) === null)
      .map((c) => ({ id: c.id, ...this.#look(c.id) }));
    for (const group of this.#plan?.groups || []) {
      if (this.#parentOf(group.key) === null)
        tops.push({ id: group.key, ...this.#look(group.key), group: true });
    }

    for (const top of tops) {
      const live = this.#categoriesById.get(top.id);
      const own = this.#spendingOf(top.id);
      top.leaves = [];
      if (own) {
        top.leaves.push({
          id: `${top.id}${DIRECT}`,
          name: this.#label("direct", { name: top.name }),
          color: top.color,
          icon: top.icon,
          series: own,
        });
      }
      const children = this.#childrenOf(top.id);
      for (const child of children) {
        const look = this.#look(child.id);
        top.leaves.push({
          id: child.id,
          name: look.name,
          icon: look.icon,
          color: top.color,
          series: this.#spendingOf(child.id) || this.#zeros(),
          group: Boolean(child.isNew),
          moved: !child.isNew && child.parent_id !== top.id,
        });
      }
      const liveChildren = categories.filter((c) => c.parent_id === top.id);
      top.moved = Boolean(live) && (live.parent_id ?? null) !== null;
      top.changed =
        Boolean(top.group) ||
        top.moved ||
        liveChildren.length !== children.length ||
        children.some((c) => c.isNew || c.parent_id !== top.id) ||
        Object.values(this.#plan?.removals || {}).includes(top.id);
    }

    // Uncategorized: transactions with no category, plus the plan's new
    // categories that haven't been given a parent yet.
    const waiting = this.#childrenOf(UNCATEGORIZED);
    if (spending[UNCATEGORIZED] || waiting.length) {
      const leaves = spending[UNCATEGORIZED]
        ? [
            {
              id: `${UNCATEGORIZED}${DIRECT}`,
              name: uncategorized.name,
              color: uncategorized.color,
              series: spending[UNCATEGORIZED],
            },
          ]
        : [];
      for (const child of waiting) {
        const look = this.#look(child.id);
        leaves.push({
          id: child.id,
          name: look.name,
          icon: look.icon,
          color: uncategorized.color,
          series: this.#spendingOf(child.id) || this.#zeros(),
          group: true,
        });
      }
      tops.push({
        id: UNCATEGORIZED,
        name: uncategorized.name,
        color: uncategorized.color,
        icon: "circle-dashed",
        leaves,
        changed: waiting.length > 0,
      });
    }

    for (const top of tops) {
      top.excluded = excluded.has(top.id);
      for (const leaf of top.leaves) {
        leaf.excluded = top.excluded || excluded.has(leaf.id);
        Object.assign(leaf, this.#stats(leaf.series));
      }
      top.series = this.#sumSeries(top.leaves);
      top.analysis = this.#sumSeries(
        top.leaves.filter((leaf) => !leaf.excluded),
      );
      Object.assign(top, this.#stats(top.series));
    }

    return tops;
  }

  #sumSeries(nodes) {
    return d3
      .range(this.#periodCount)
      .map((i) => d3.sum(nodes, (n) => n.series[i]));
  }

  // Every top-level node except categories that only hold income.
  #listedTops(tree) {
    const income = this.historyValue.income;
    return tree.filter((top) => top.total > 0 || !income[top.id]);
  }

  #sorted(nodes, depth) {
    const amount = (n) => this.#amounts.get(n.id) ?? -1;
    const compare = {
      name: (a, b) => a.name.localeCompare(b.name),
      budget: (a, b) =>
        (depth === 0 ? amount(b) - amount(a) : 0) || b.total - a.total,
      spending: (a, b) => b.total - a.total || a.name.localeCompare(b.name),
    }[this.#sort];
    return [...nodes].sort(compare);
  }

  #stats(series) {
    return {
      total: d3.sum(series),
      average: d3.mean(series) || 0,
      median: d3.median(series) || 0,
    };
  }

  get #incomeRows() {
    const { categories, income, uncategorized } = this.historyValue;
    const names = new Map(categories.map((c) => [c.id, c]));
    return Object.entries(income)
      .map(([id, series]) => {
        const category = names.get(id);
        return {
          id,
          name: category?.name || uncategorized.name,
          color: category?.color || uncategorized.color,
          icon: category?.icon || "circle-dashed",
          series,
          income: true,
          excluded: this.#excluded.has(id),
          ...this.#stats(series),
        };
      })
      .sort((a, b) => b.total - a.total);
  }

  get #includedIncome() {
    return this.#incomeRows.filter((row) => !row.excluded);
  }

  // --- drawing ---

  #draw() {
    const tree = this.#tree;
    if (!this.#panelHidden) this.#drawPanel(tree);
    else this.#updateTotals();
    this.#drawCharts(tree);
  }

  #drawCharts(tree = this.#tree) {
    this.#drawCircles(tree);
    this.#drawChart(tree);
    this.#drawExcludedNote(tree);
  }

  #drawExcludedNote(tree) {
    const nodes = this.#listedTops(tree)
      .flatMap((top) =>
        top.excluded ? [top] : top.leaves.filter((l) => l.excluded),
      )
      .concat(this.#incomeRows.filter((row) => row.excluded));
    this.excludedNoteTarget.classList.toggle("hidden", nodes.length === 0);
    if (!nodes.length) return;
    this.excludedNoteTarget.textContent = this.#label("excluded_note", {
      names: nodes.map((n) => n.name).join(", "),
      amount: this.#money.format(d3.sum(nodes, (n) => n.average)),
    });
  }

  #drawCircles(tree) {
    const container = this.circlesTarget;
    container.innerHTML = "";
    container.classList.remove("text-sm", "text-subdued");
    const size = container.clientWidth;
    if (!size) return;

    // A new group with no spending yet is drawn small and dashed, so there
    // is something to drop categories onto.
    const placeholder = (d3.mean(tree, (top) => top.total) || 1) * 0.15;
    const visible = tree
      .filter((top) => !this.#hidden.has(top.id))
      .map((top) => {
        if (this.#isSingle(top)) return { ...top, children: null };
        // Subcategories with no spending in the range still get a small
        // dashed circle, so they can be seen and dragged.
        const children = top.leaves
          .filter((leaf) => !this.#hidden.has(leaf.id))
          .map((leaf) =>
            leaf.total > 0
              ? leaf
              : { ...leaf, total: placeholder / 2, empty: true },
          );
        if (top.group && !children.length)
          return { ...top, children: null, total: placeholder, empty: true };
        return { ...top, children, total: d3.sum(children, (c) => c.total) };
      })
      .filter((top) => (top.children ? top.children.length : top.total > 0));

    if (!visible.length) {
      container.textContent = this.#label("empty");
      container.classList.add("text-sm", "text-subdued");
      return;
    }

    const root = d3
      .hierarchy({ children: visible })
      .sum((d) => (d.children ? 0 : d.total))
      .sort((a, b) => b.value - a.value);
    d3.pack().size([size, size]).padding(4)(root);
    // A lone child would fill its parent exactly; shrink it and move it down
    // so both circles and the parent's name show.
    for (const d of root.descendants()) {
      if (d.depth !== 1 || d.children?.length !== 1) continue;
      const [child] = d.children;
      child.r = d.r * 0.62;
      child.x = d.x;
      child.y = d.y + d.r * 0.3;
    }

    const svg = d3
      .select(container)
      .append("svg")
      .attr("viewBox", [0, 0, size, size])
      .attr("width", size)
      .attr("height", size)
      .attr("role", "img")
      .attr("aria-label", this.#label("spending"));

    const node = svg
      .selectAll("g")
      .data(root.descendants().slice(1))
      .join("g")
      .attr("transform", (d) => `translate(${d.x},${d.y})`)
      .attr("data-node-id", (d) => d.data.id);

    node
      .append("circle")
      .attr("r", (d) => d.r)
      .attr("fill", (d) => (d.data.excluded ? "currentColor" : d.data.color))
      .attr("class", (d) => (d.data.excluded ? "text-subdued" : null))
      .attr("fill-opacity", (d) => {
        if (d.children) return 0.12;
        return d.data.excluded ? 0.25 : 0.55;
      })
      .attr("stroke", (d) => (d.data.excluded ? "currentColor" : d.data.color))
      .attr("stroke-dasharray", (d) =>
        d.data.excluded || d.data.empty ? "4 3" : null,
      )
      .attr("stroke-width", (d) => (this.#isSelected(d) ? 3 : 1))
      .style("cursor", (d) => (d.depth === 1 ? "pointer" : null))
      .on("click", (_event, d) => {
        const top = d.depth === 1 ? d : d.parent;
        this.#selected = this.#selected === top.data.id ? null : top.data.id;
        this.#draw();
      })
      .on("contextmenu", (event, d) => {
        event.preventDefault();
        this.#openMenu(
          this.#nodeFor(tree, d.data.id),
          event.clientX,
          event.clientY,
          null,
        );
      })
      .append("title")
      .text(
        (d) =>
          `${d.data.name}: ${this.#money.format(d.data.average)} / ${this.#money.format(d.data.median)}`,
      );

    // Labels sit on their own layer above every circle, in full, with an
    // outline in the card's colour so they read over other circles. Parent
    // names always show; subcategory names show while the pointer is over
    // their parent, or while it's selected (a tap on a phone).
    const topOf = (d) => (d.depth === 1 ? d : d.parent);
    const halo = getComputedStyle(
      this.circlesTarget.closest(".bg-container") || this.circlesTarget,
    ).backgroundColor;
    const baseY = (d) =>
      d.depth === 1 && d.children ? d.y - d.r + 16 : d.y + 4;
    const labels = svg
      .append("g")
      .style("pointer-events", "none")
      .selectAll("text")
      .data(root.descendants().slice(1))
      .join("text")
      .attr("x", (d) => d.x)
      .attr("text-anchor", "middle")
      .attr("paint-order", "stroke")
      .attr("stroke", halo)
      .attr("stroke-width", 4)
      .attr("stroke-linejoin", "round")
      .attr("class", (d) =>
        d.depth === 1
          ? "fill-current text-primary text-xs font-medium"
          : "fill-current text-primary text-xs",
      )
      .text((d) => d.data.name);
    const showLabels = (top) => {
      const visible = (d) =>
        d.depth === 1 ||
        topOf(d) === top ||
        topOf(d).data.id === this.#selected;
      labels.style("display", (d) => (visible(d) ? null : "none"));
      // Move a label down a line while it overlaps one already placed.
      const placed = [];
      labels
        .filter(visible)
        .sort((a, b) => baseY(a) - baseY(b))
        .each(function (d) {
          const half = this.getComputedTextLength() / 2 + 2;
          let y = baseY(d);
          const overlaps = () =>
            placed.some(
              (p) =>
                p.x0 < d.x + half &&
                d.x - half < p.x1 &&
                p.y0 < y + 3 &&
                y - 11 < p.y1,
            );
          for (let tries = 0; overlaps() && tries < 8; tries++) y += 13;
          placed.push({
            x0: d.x - half,
            x1: d.x + half,
            y0: y - 11,
            y1: y + 3,
          });
          d3.select(this).attr("y", y);
        });
    };
    showLabels(null);
    node
      .on("mouseenter", (_event, d) => showLabels(topOf(d)))
      .on("mouseleave", () => showLabels(null));

    if (this.draftValue.can_edit && this.planValue.editable)
      this.#enableCircleDrag(node, root);
  }

  // Drag a subcategory, or a super category with no subcategories, onto a
  // super category to move it there; drop it outside every circle to make
  // it top-level. Anything else snaps back.
  #enableCircleDrag(node, root) {
    const tops = root.children || [];
    const movable = (d) =>
      (this.#categoriesById.has(d.data.id) ||
        Boolean(this.#group(d.data.id))) &&
      (d.depth === 2 || !d.children);
    const over = (x, y, d) =>
      tops.find(
        (t) =>
          t !== d &&
          (t.data.id !== UNCATEGORIZED || Boolean(this.#group(d.data.id))) &&
          Math.hypot(x - t.x, y - t.y) < t.r,
      );
    const circles = node.select("circle");

    node.filter(movable).call(
      d3
        .drag()
        .clickDistance(4)
        .on("start", function () {
          d3.select(this).raise().style("cursor", "grabbing");
        })
        .on("drag", function (event, d) {
          d3.select(this).attr("transform", `translate(${event.x},${event.y})`);
          const target = over(event.x, event.y, d);
          circles.attr("stroke-width", (c) => (c === target ? 3 : 1));
        })
        .on("end", (event, d) => {
          const target = over(event.x, event.y, d);
          const id = d.data.id;
          const destination = target ? target.data.id : null;
          const current = this.#parentOf(id);
          const insideOwn = target && target === d.parent;
          if (
            !insideOwn &&
            destination !== current &&
            this.#canMove(id, destination)
          )
            this.#move(id, destination);
          else this.#drawCharts();
        }),
    );
  }

  #nodeFor(tree, id) {
    for (const top of tree) {
      if (top.id === id) return { node: top, depth: 0 };
      const leaf = top.leaves.find((l) => l.id === id);
      if (leaf) return { node: leaf, depth: 1, parent: top };
    }
    return null;
  }

  // A top-level category with no subcategories: its own transactions are
  // its only leaf, so it is drawn and listed once rather than nested.
  #isSingle(top) {
    return top.leaves.length === 1 && top.leaves[0].id.endsWith(DIRECT);
  }

  #isSelected(d) {
    return d.depth === 1 && d.data.id === this.#selected;
  }

  // --- spending over time ---

  // Parent categories the chart can show: those listed, not excluded and
  // not hidden. Budget lines follow the amounts in the panel.
  #chartParents(tree) {
    return this.#listedTops(tree)
      .filter((top) => !top.excluded && !this.#hidden.has(top.id))
      .map((top) => ({
        id: top.id,
        name: top.name,
        color: top.color,
        series: top.analysis,
        total: top.total,
        budget: this.#amounts.has(top.id) ? this.#amounts.get(top.id) : null,
      }));
  }

  #topParents(parents) {
    return parents
      .filter((p) => p.total > 0)
      .sort((a, b) => b.total - a.total)
      .slice(0, 5)
      .map((p) => p.id);
  }

  // `hoverOnly`: just the hovered month changed, so the zoom strip stays.
  #scheduleChart(hoverOnly = false) {
    cancelAnimationFrame(this.chartFrame);
    this.chartFrame = requestAnimationFrame(() =>
      this.#drawChart(this.#tree, hoverOnly),
    );
  }

  #monthIndex(date) {
    const [year, month] = String(date).split("-").map(Number);
    return year * 12 + month - 1;
  }

  #drawChart(tree = this.#tree, hoverOnly = false) {
    const periods = this.historyValue.periods;
    const history = periods.length;
    const first = new Date(`${periods[0].start_date}T00:00:00`);
    const months = d3
      .range(history + 12)
      .map((i) => new Date(first.getFullYear(), first.getMonth() + i, 1));
    const parents = this.#chartParents(tree);
    this.#chartShown ??= new Set(this.#topParents(parents));
    if (!this.#chartWindow || this.#chartWindow[1] > history - 1)
      this.#chartWindow = [0, history - 1];
    // The selected category, or else the biggest one shown.
    const focus = parents.some((p) => p.id === this.#selected)
      ? this.#selected
      : (parents
          .filter((p) => this.#chartShown?.has(p.id))
          .sort((a, b) => b.total - a.total)[0]?.id ?? null);
    if (focus) this.#chartShown.add(focus);

    this.#syncChartControls();
    this.#renderChartChips(parents, focus);
    const selected = tree.find((top) => top.id === this.#selected);
    this.historyTitleTarget.textContent = selected
      ? selected.name
      : this.#label("all_categories");
    this.historyTitleTarget.style.color = selected ? selected.color : "";

    const options = {
      ...this.#chart,
      anchor:
        this.#monthIndex(this.planValue.start_date) -
        this.#monthIndex(periods[0].start_date),
    };
    const chart = drawPlannerChart(
      this.historyTarget,
      hoverOnly ? null : this.chartOverviewTarget,
      {
        view: this.#chart.view,
        months,
        history,
        parents,
        shown: this.#chartShown,
        focus,
        window: this.#chartWindow,
        options,
        hover: this.#chartHover,
        money: this.#money,
        labels: this.labelsValue,
        tall: this.#enlarged,
        onFocus: (id) => {
          this.#selected = id;
          this.#draw();
        },
        onHover: (index) => {
          if (this.#chartHover === index) return;
          this.#chartHover = index;
          this.#scheduleChart(true);
        },
        onWindow: (window) => {
          this.#chartWindow = window;
          this.#drawChart();
        },
      },
    );
    this.#drawChartNote(
      parents.find((p) => p.id === focus),
      chart,
      history,
    );
    this.#drawChartKey();
  }

  #syncChartControls() {
    for (const button of this.chartControlTargets) {
      const { option, value } = button.dataset;
      const active = String(this.#chart[option]) === value;
      button.classList.toggle("segmented-control__segment--active", active);
      button.setAttribute("aria-pressed", String(active));
    }
    if (this.hasGrowthInputTarget) {
      this.growthInputTarget.value = this.#chart.growth;
      this.growthOutputTarget.textContent = this.#label("growth_value", {
        value: this.#chart.growth,
      });
    }
  }

  #renderChartChips(parents, focus) {
    const shown = this.#chartShown;
    this.chartChipsTarget.replaceChildren(
      ...parents.map((p) => {
        const chip = document.createElement("button");
        chip.type = "button";
        const on = shown.has(p.id);
        chip.className = `inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs focus-ring ${on ? "border-secondary text-primary" : "border-subdued text-subdued"} ${p.id === focus ? "ring-2 ring-current" : ""}`;
        chip.setAttribute("aria-pressed", String(on));
        const swatch = document.createElement("span");
        swatch.className = "w-2.5 h-2.5 rounded-full bg-surface-inset";
        if (on) swatch.style.backgroundColor = p.color;
        chip.append(swatch, document.createTextNode(p.name));
        let last = 0;
        chip.addEventListener("click", (event) => {
          const now = Date.now();
          if (event.altKey || now - last < 350)
            this.#chartShown = new Set([p.id]);
          else if (shown.has(p.id)) shown.delete(p.id);
          else shown.add(p.id);
          last = now;
          if (this.#chartShown.has(p.id)) this.#selected = p.id;
          else if (this.#selected === p.id) this.#selected = null;
          this.#draw();
        });
        return chip;
      }),
    );
  }

  #drawChartNote(focus, chart, history) {
    const notes = [];
    const model = focus && chart.input.parents.find((p) => p.id === focus.id);
    if (model) {
      const cycle = model.cycle
        ? this.#label("chart.cycle", { months: model.cycle.length })
        : this.#label("chart.no_cycle");
      notes.push(
        this.#chart.fit === "off"
          ? this.#label("chart.focus_note_no_fit", { name: focus.name, cycle })
          : this.#label("chart.focus_note", {
              name: focus.name,
              cycle,
              direction: this.#label(
                model.model.slope >= 0 ? "chart.up" : "chart.down",
              ),
              amount: this.#money.format(Math.abs(model.model.slope * 12)),
            }),
      );
    }
    if (this.#chart.fit === "yearly" && history < 24)
      notes.push(this.#label("chart.yearly_needs_history"));
    const excluded = this.#listedTops(this.#tree).filter(
      (t) => t.excluded || this.#hidden.has(t.id),
    );
    if (excluded.length)
      notes.push(
        this.#label("chart.excluded_left_out", {
          names: excluded.map((t) => t.name).join(", "),
        }),
      );
    this.chartNoteTarget.textContent = notes.join(" ");
  }

  #drawChartKey() {
    const view = this.#chart.view;
    const items = {
      lines: ["actual", "fitted", "budget", "over", "under", "cycle"],
      percent: ["actual", "fitted"],
      multiples: ["actual", "fitted", "budget", "over", "under", "cycle"],
      grid: ["over", "under", "within", "no_budget", "cycle"],
    }[view];
    if (this.#chart.ahead) items.push("forecast");
    const swatch = {
      actual: "border-t-2 border-current text-primary w-5",
      fitted: "border-t-2 border-dotted border-current text-secondary w-5",
      budget: "border-t border-dashed border-current text-primary w-5",
      over: "h-2.5 w-4 rounded-sm bg-current text-destructive opacity-40",
      under: "h-2.5 w-4 rounded-sm bg-current text-success opacity-30",
      within: "h-2.5 w-4 rounded-sm bg-surface-inset",
      no_budget: "h-2.5 w-4 rounded-sm border border-dashed border-secondary",
      cycle: "h-3 border-l border-current text-subdued",
      forecast:
        "h-2.5 w-4 rounded-sm bg-surface-inset border border-dashed border-secondary",
    };
    this.chartKeyTarget.replaceChildren(
      ...items.map((key) => {
        const item = document.createElement("span");
        item.className = "inline-flex items-center gap-1.5";
        const mark = document.createElement("span");
        mark.className = `inline-block ${swatch[key]}`;
        item.append(
          mark,
          document.createTextNode(this.#label(`chart.key.${key}`)),
        );
        return item;
      }),
    );
  }

  // --- panel ---

  #drawPanel(tree) {
    const money = this.#money;
    const panel = this.panelTarget;
    panel.innerHTML = "";

    this.incomeSlotTarget.replaceChildren(
      this.#amountField(
        null,
        "plan[expected_income]",
        this.#expectedIncome,
        this.#label("income"),
      ),
    );

    const listed = this.#sorted(this.#listedTops(tree), 0);
    const list = document.createElement("ul");
    list.className = "divide-y divide-subdued";
    for (const top of listed) {
      list.append(this.#row(top, money, 0, top));
      if (this.#isSingle(top)) continue;
      for (const leaf of this.#sorted(top.leaves, 1))
        list.append(this.#row(leaf, money, 1, top));
    }
    for (const removed of this.#removedRows())
      list.append(this.#removedRow(removed));
    panel.append(list);

    const shown = listed.filter((t) => !this.#hidden.has(t.id));
    const analysis = d3
      .range(this.#periodCount)
      .map((i) => d3.sum(shown, (t) => t.analysis[i]));
    panel.append(
      this.#summaryRow(this.#label("total"), this.#stats(analysis), money),
    );

    const incomeRows = this.#incomeRows;
    if (incomeRows.length) {
      panel.append(this.#heading(this.#label("income")));
      const incomeList = document.createElement("ul");
      incomeList.className = "divide-y divide-subdued";
      for (const row of incomeRows)
        incomeList.append(this.#incomeRow(row, money));
      panel.append(incomeList);
      const totalIncome = this.#stats(
        d3
          .range(this.#periodCount)
          .map((i) => d3.sum(this.#includedIncome, (r) => r.series[i])),
      );
      panel.append(this.#summaryRow(this.#label("total"), totalIncome, money));
    }

    this.#updateTotals();
  }

  #removedRows() {
    return Object.keys(this.#plan?.removals || {})
      .map((id) => this.#categoriesById.get(id))
      .filter(Boolean);
  }

  #icon(name, color) {
    const sprite = this.iconSpritesTarget.querySelector(
      `[data-icon="${CSS.escape(name || "")}"] svg`,
    );
    const holder = document.createElement("span");
    holder.className =
      "w-5 h-5 shrink-0 inline-flex items-center justify-center";
    holder.style.color = color;
    holder.setAttribute("aria-hidden", "true");
    if (sprite) {
      holder.append(sprite.cloneNode(true));
    } else {
      const dot = document.createElement("span");
      dot.className = "w-2.5 h-2.5 rounded-full";
      dot.style.backgroundColor = color;
      holder.append(dot);
    }
    return holder;
  }

  #badge(text) {
    const badge = document.createElement("span");
    badge.className =
      "inline-block mt-0.5 mr-1 px-1.5 rounded text-xs bg-surface-inset text-secondary";
    badge.textContent = text;
    return badge;
  }

  #row(node, money, depth, top) {
    const hidden = this.#hidden.has(node.id);
    const li = document.createElement("li");
    li.className = `flex items-center gap-2 py-2 ${depth ? "pl-5" : ""} ${hidden || node.excluded ? "opacity-60" : ""}`;
    li.style.webkitTouchCallout = "none";
    if (depth === 0 && node.id === this.#selected)
      li.classList.add("bg-surface-inset");

    const name = document.createElement(depth === 0 ? "button" : "span");
    name.className = `block max-w-full min-w-0 truncate text-left ${depth ? "text-secondary" : "text-primary font-medium"}`;
    name.textContent = node.name;
    if (depth === 0) {
      name.type = "button";
      name.dataset.nodeId = node.id;
      name.dataset.action = "budget-planner#select";
      name.setAttribute("aria-pressed", String(node.id === this.#selected));
    }

    const values = document.createElement("span");
    values.className = "block text-xs tabular-nums text-subdued";
    values.textContent = `${money.format(node.average)} · ${money.format(node.median)}`;

    const text = document.createElement("div");
    text.className = "min-w-0 flex-1";
    text.append(name, values);
    const override = this.#plan?.overrides[node.id];
    if (node.group) text.append(this.#badge(this.#label("new_group")));
    if (node.moved) text.append(this.#badge(this.#label("moved")));
    if (override && Object.keys(override).length)
      text.append(this.#badge(this.#label("renamed")));
    if (node.excluded) text.append(this.#badge(this.#label("excluded")));

    li.append(this.#icon(node.icon, node.color), text);

    if (depth === 0 && this.#budgetable(node)) {
      const fieldName =
        node.id === UNCATEGORIZED
          ? "plan[uncategorized]"
          : `plan[categories][${node.id}]`;
      li.append(
        this.#amountField(
          node.id,
          fieldName,
          this.#amounts.get(node.id) ?? 0,
          this.#label("amount_label", { name: node.name }),
        ),
      );
      const minimum = this.#minimum(node.id);
      if (minimum > 0) {
        const note = document.createElement("span");
        note.dataset.minimumNote = "";
        note.className = "hidden block text-xs text-destructive";
        note.textContent = this.#label("below_minimum", {
          amount: money.format(minimum),
        });
        text.append(note);
      }
    }

    const target = { node, depth, parent: depth ? top : null };
    li.append(this.#menuButton(target));
    this.#bindContextMenu(li, target);
    if (this.draftValue.can_edit && this.planValue.editable) {
      if (this.#categoriesById.has(node.id) || this.#group(node.id))
        this.#makeDraggable(li, node.id);
      if (depth === 0) this.#makeDropTarget(li, node.id);
    }
    return li;
  }

  #removedRow(category) {
    const look = this.#look(category.id);
    const li = document.createElement("li");
    li.className = "flex items-center gap-2 py-2 opacity-60";
    const text = document.createElement("div");
    text.className = "min-w-0 flex-1";
    const name = document.createElement("span");
    name.className = "block truncate line-through text-secondary";
    name.textContent = look.name;
    text.append(name, this.#badge(this.#label("removed")));
    const into = this.#plan.removals[category.id];
    if (into) {
      const note = document.createElement("span");
      note.className = "text-xs text-subdued";
      note.textContent = `→ ${this.#look(into)?.name || ""}`;
      text.append(note);
    }
    li.append(this.#icon(look.icon, look.color), text);
    const target = {
      node: { id: category.id, name: look.name, removed: true },
      depth: 0,
    };
    li.append(this.#menuButton(target));
    this.#bindContextMenu(li, target);
    return li;
  }

  #incomeRow(row, money) {
    const li = document.createElement("li");
    li.className = `flex items-center gap-2 py-2 ${row.excluded ? "opacity-60" : ""}`;
    li.style.webkitTouchCallout = "none";
    const text = document.createElement("div");
    text.className = "min-w-0 flex-1";
    const name = document.createElement("span");
    name.className = "block truncate text-primary font-medium";
    name.textContent = row.name;
    const values = document.createElement("span");
    values.className = "block text-xs tabular-nums text-subdued";
    values.textContent = `${money.format(row.average)} · ${money.format(row.median)}`;
    text.append(name, values);
    if (row.excluded) text.append(this.#badge(this.#label("excluded")));
    li.append(this.#icon(row.icon, row.color), text);
    const target = { node: row, depth: 0 };
    li.append(this.#menuButton(target));
    this.#bindContextMenu(li, target);
    return li;
  }

  #amountField(id, name, value, label) {
    if (!this.planValue.editable) {
      const span = document.createElement("span");
      span.className = "shrink-0 tabular-nums font-medium text-primary";
      span.textContent = this.#money.format(value);
      return span;
    }

    const wrapper = document.createElement("div");
    wrapper.className = "form-field w-28 shrink-0";
    const input = document.createElement("input");
    input.type = "number";
    input.min = "0";
    input.step = "1";
    input.inputMode = "numeric";
    input.autocomplete = "off";
    input.name = name;
    input.value = value;
    if (name === "plan[expected_income]") input.id = "plan_expected_income";
    // No spin buttons: desktop browsers draw them, phones don't.
    input.className =
      "form-field__input text-right tabular-nums [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none";
    input.setAttribute("aria-label", label);
    if (id) {
      input.dataset.nodeId = id;
      input.dataset.action = "input->budget-planner#editAmount";
    } else {
      input.dataset.action = "input->budget-planner#editIncome";
    }
    wrapper.append(input);
    if (id) queueMicrotask(() => this.#markInvalid(input));
    return wrapper;
  }

  #summaryRow(label, stats, money) {
    const div = document.createElement("div");
    div.className =
      "flex items-center gap-2 py-2 border-t border-secondary font-medium text-primary";
    const name = document.createElement("span");
    name.textContent = label;
    const values = document.createElement("span");
    values.className = "ml-auto tabular-nums";
    values.textContent = `${money.format(stats.average)} · ${money.format(stats.median)}`;
    div.append(name, values);
    return div;
  }

  #heading(text) {
    const h = document.createElement("h3");
    h.className = "mt-4 mb-1 text-xs font-medium uppercase text-subdued";
    h.textContent = text;
    return h;
  }

  #makeDraggable(li, id) {
    li.draggable = true;
    li.classList.add("cursor-grab");
    li.addEventListener("dragstart", (event) => {
      event.dataTransfer.setData("text/plain", id);
      event.dataTransfer.effectAllowed = "move";
    });
  }

  #makeDropTarget(li, target) {
    li.addEventListener("dragover", (event) => {
      event.preventDefault();
      li.classList.add("bg-surface-inset");
    });
    li.addEventListener("dragleave", () =>
      li.classList.remove("bg-surface-inset"),
    );
    li.addEventListener("drop", (event) => {
      event.preventDefault();
      li.classList.remove("bg-surface-inset");
      const id = event.dataTransfer.getData("text/plain");
      if (id && this.#canMove(id, target)) this.#move(id, target);
    });
  }

  #move(id, target) {
    this.#changePlan((plan) => {
      const live = this.#categoriesById.get(id)?.parent_id ?? null;
      if (target === live) delete plan.parents[id];
      else plan.parents[id] = target;
    });
  }

  // --- row menu ---

  #menuButton(target) {
    const button = document.createElement("button");
    button.type = "button";
    button.className =
      "shrink-0 w-7 h-7 rounded-md text-secondary hover:bg-surface-inset focus-ring";
    button.textContent = "⋯";
    button.setAttribute("aria-haspopup", "menu");
    button.setAttribute(
      "aria-label",
      this.#label("more", { name: target.node.name }),
    );
    button.addEventListener("click", (event) => {
      const rect = event.currentTarget.getBoundingClientRect();
      this.#openMenu(target, rect.right, rect.bottom, event.currentTarget);
    });
    return button;
  }

  // Right-click on desktop; long-press on touch screens, where iOS Safari
  // doesn't fire contextmenu.
  #bindContextMenu(element, target) {
    element.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      this.#openMenu(target, event.clientX, event.clientY, null);
    });
    let timer = null;
    let pressed = false;
    const cancel = () => clearTimeout(timer);
    element.addEventListener(
      "touchstart",
      (event) => {
        const touch = event.touches[0];
        pressed = false;
        timer = setTimeout(() => {
          pressed = true;
          this.#openMenu(target, touch.clientX, touch.clientY, null);
        }, LONG_PRESS_MS);
      },
      { passive: true },
    );
    // The release after a long-press isn't a tap on the row.
    element.addEventListener(
      "click",
      (event) => {
        if (!pressed) return;
        pressed = false;
        event.preventDefault();
        event.stopPropagation();
      },
      { capture: true },
    );
    for (const type of ["touchend", "touchmove", "touchcancel"])
      element.addEventListener(type, cancel, { passive: true });
  }

  #openMenu(target, x, y, returnFocus) {
    if (!target) return;
    this.#closeMenu();
    const menu = document.createElement("div");
    menu.setAttribute("role", "menu");
    menu.setAttribute("aria-label", target.node.name);
    menu.className =
      "fixed z-50 w-60 max-w-[calc(100vw-2rem)] max-h-[70vh] overflow-y-auto p-1 bg-container rounded-xl shadow-border-xs text-sm";
    for (const item of this.#menuItems(target)) menu.append(item);
    this.element.append(menu);
    this.#menu = menu;
    this.#menuReturnFocus = returnFocus;

    const rect = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - rect.width - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - rect.height - 8))}px`;
    menu.addEventListener("keydown", (event) => this.#menuKeys(event));
    menu.querySelector("[role^=menuitem]:not([disabled])")?.focus();
  }

  #closeMenu() {
    if (!this.#menu) return;
    this.#menu.remove();
    this.#menu = null;
    this.#menuReturnFocus?.focus();
    this.#menuReturnFocus = null;
  }

  #menuKeys(event) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const items = [
      ...this.#menu.querySelectorAll("[role^=menuitem]:not([disabled])"),
    ];
    const index = items.indexOf(document.activeElement);
    const step = event.key === "ArrowDown" ? 1 : -1;
    items[(index + step + items.length) % items.length]?.focus();
  }

  #menuItem(
    text,
    action,
    { disabled = false, indent = false, checked = null } = {},
  ) {
    const button = document.createElement("button");
    button.type = "button";
    button.setAttribute(
      "role",
      checked === null ? "menuitem" : "menuitemradio",
    );
    if (checked !== null) button.setAttribute("aria-checked", String(checked));
    button.className = `w-full text-left px-3 py-1.5 rounded-lg hover:bg-surface-inset focus-ring disabled:opacity-50 disabled:cursor-not-allowed ${indent ? "pl-6" : ""} ${checked ? "font-medium" : ""}`;
    button.textContent = checked ? `✓ ${text}` : text;
    button.disabled = disabled;
    button.addEventListener("click", () => {
      this.#closeMenu();
      action();
    });
    return button;
  }

  #menuLabel(text) {
    const p = document.createElement("p");
    p.className = "px-3 pt-2 pb-1 text-xs text-subdued";
    p.textContent = text;
    return p;
  }

  #menuSeparator() {
    const hr = document.createElement("hr");
    hr.className = "my-1 border-secondary";
    return hr;
  }

  #menuItems({ node, depth }) {
    const id = node.id;
    if (node.removed) {
      return [
        this.#menuItem(this.#label("menu.undo_remove"), () =>
          this.#changePlan((plan) => {
            delete plan.removals[id];
          }),
        ),
      ];
    }

    if (node.income) {
      const excluded = this.#excluded.has(id);
      return [
        this.#menuItem(
          this.#label(excluded ? "menu.include" : "menu.exclude"),
          () => this.#toggleExcluded(id),
        ),
      ];
    }

    const items = [];
    const isCategory = this.#categoriesById.has(id);
    const isGroup = Boolean(this.#group(id));
    const isDirect = id.endsWith(DIRECT);
    const canPlan = this.draftValue.can_edit && this.planValue.editable;

    if (depth === 0 && this.#budgetable(node) && this.planValue.editable) {
      items.push(this.#menuLabel(this.#label("menu.reset_amount")));
      for (const source of ["current", "average", "median"]) {
        const amount = this.#money.format(this.#amountFrom(node, source));
        items.push(
          this.#menuItem(
            `${this.#label(`menu.${source}`)} · ${amount}`,
            () => this.#resetAmount(node, source),
            { indent: true },
          ),
        );
      }
      items.push(this.#menuSeparator());
    }

    if (canPlan && (isCategory || isGroup)) {
      items.push(
        this.#menuItem(this.#label("menu.rename"), () => this.#rename(node)),
      );
      items.push(
        this.#menuItem(this.#label("menu.appearance"), () =>
          this.#openAppearance(node, depth),
        ),
      );
      if (isCategory && this.#plan?.overrides[id]) {
        items.push(
          this.#menuItem(this.#label("menu.reset_appearance"), () =>
            this.#changePlan((plan) => {
              delete plan.overrides[id];
            }),
          ),
        );
      }
      items.push(
        this.#menuItem(this.#label("menu.remove"), () =>
          this.#startRemove(node),
        ),
      );
      items.push(this.#menuSeparator());
    }

    if (!isDirect) {
      const excluded = this.#excluded.has(id);
      items.push(
        this.#menuItem(
          this.#label(excluded ? "menu.include" : "menu.exclude"),
          () => this.#toggleExcluded(id),
        ),
      );
    }
    const hidden = this.#hidden.has(id);
    items.push(
      this.#menuItem(this.#label(hidden ? "menu.show" : "menu.hide"), () => {
        if (hidden) this.#hidden.delete(id);
        else this.#hidden.add(id);
        this.#draw();
      }),
    );
    return items;
  }

  // Removing: with nothing to move it happens straight away; otherwise a
  // dialog says where the subcategories go (top level) and asks where the
  // transactions go: another category or a new one.
  #startRemove(node) {
    const id = node.id;
    const category = this.#categoriesById.get(id);
    const children = this.#childrenOf(id);
    // Its own transactions plus any the plan is already moving into it.
    const count =
      (category?.transaction_count || 0) +
      d3.sum(
        this.#incoming(id),
        (source) => this.#categoriesById.get(source)?.transaction_count || 0,
      );
    if (!children.length && !count) {
      this.#remove(id, null);
      return;
    }

    this.#removing = { id, count, group: !category };
    this.removeTitleTarget.textContent = this.#label("remove.title", {
      name: node.name,
    });
    this.removeChildrenNoteTarget.textContent = children.length
      ? this.#label("remove.children", {
          names: children.map((c) => this.#look(c.id).name).join(", "),
        })
      : "";
    this.removeChildrenNoteTarget.classList.toggle("hidden", !children.length);
    this.removeTargetFieldsTarget.classList.toggle("hidden", !count);
    this.removeErrorTarget.textContent = "";

    if (count) {
      this.removeTargetLabelTarget.textContent = this.#label(
        "remove.transactions_label",
        { count },
      );
      const select = this.removeTargetTarget;
      select.replaceChildren(
        ...this.#transactionTargets(id).map((t) => new Option(t.name, t.id)),
        new Option(this.#label("remove.new_category"), "__new__"),
      );
      this.removeNewNameTarget.value = "";
      this.removeTargetChanged();
    }
    this.removeDialogTarget.classList.remove("hidden");
    const rect = this.removeDialogTarget.getBoundingClientRect();
    this.removeDialogTarget.style.left = `${Math.max(8, (window.innerWidth - rect.width) / 2)}px`;
    this.removeDialogTarget.style.top = `${Math.max(8, (window.innerHeight - rect.height) / 3)}px`;
    (count
      ? this.removeTargetTarget
      : this.removeDialogTarget.querySelector("button")
    )?.focus();
  }

  removeTargetChanged() {
    const isNew = this.removeTargetTarget.value === "__new__";
    this.removeNewNameFieldTarget.classList.toggle("hidden", !isNew);
    if (isNew) this.removeNewNameTarget.focus();
  }

  closeRemove() {
    this.removeDialogTarget.classList.add("hidden");
    this.#removing = null;
  }

  confirmRemove() {
    if (!this.#removing) return;
    const { id, count } = this.#removing;
    let target = null;
    let newGroup = null;

    if (count) {
      target = this.removeTargetTarget.value;
      if (target === "__new__") {
        const name = this.removeNewNameTarget.value.trim();
        const error = !name
          ? this.#label("remove.new_name_required")
          : this.#nameTaken(name, id) &&
            this.#label("remove.name_taken", { name });
        if (error) {
          this.removeErrorTarget.textContent = error;
          return;
        }
        newGroup = {
          key: this.#newKey(),
          name,
          color: this.#look(id).color,
          icon: this.#look(id).icon,
        };
        target = newGroup.key;
      }
    }

    this.closeRemove();
    this.#remove(id, target, newGroup);
  }

  // Categories the plan removes by moving their transactions into `id`.
  #incoming(id) {
    return Object.entries(this.#plan?.removals || {})
      .filter(([, target]) => target === id)
      .map(([source]) => source);
  }

  // Every category or new group the transactions could go to, by name.
  #transactionTargets(id) {
    return this.historyValue.categories
      .filter((c) => c.id !== id && !this.#removed(c.id))
      .map((c) => ({ id: c.id, name: this.#look(c.id).name }))
      .concat(
        (this.#plan?.groups || [])
          .filter((g) => g.key !== id)
          .map((g) => ({ id: g.key, name: g.name })),
      )
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  #remove(id, target, newGroup = null) {
    const children = this.#childrenOf(id).map((c) => c.id);
    const incoming = this.#incoming(id);
    this.#changePlan((plan) => {
      if (newGroup) {
        plan.groups.push(newGroup);
        plan.parents[newGroup.key] = UNCATEGORIZED;
      }
      // Transactions on their way into this category go where its own go.
      for (const source of incoming) plan.removals[source] = target;
      for (const child of children) {
        const live = this.#categoriesById.get(child)?.parent_id ?? null;
        if (live === null) delete plan.parents[child];
        else plan.parents[child] = null;
      }
      plan.excluded = plan.excluded.filter((e) => e !== id);
      if (this.#group(id)) {
        plan.groups = plan.groups.filter((g) => g.key !== id);
        delete plan.parents[id];
        return;
      }
      plan.removals[id] = target;
      delete plan.parents[id];
    });
  }

  #toggleExcluded(id) {
    const toggle = (set) => (set.has(id) ? set.delete(id) : set.add(id));
    if (!this.#plan) {
      toggle(this.#liveExcluded);
      this.#draw();
      return;
    }
    const set = new Set(this.#plan.excluded);
    toggle(set);
    this.#plan.excluded = [...set];
    this.#draw();
    this.#scheduleSave();
  }

  #resetAmount(node, source) {
    this.#amounts.set(node.id, this.#amountFrom(node, source));
    this.#edited.add(node.id);
    this.#draw();
  }

  #rename(node) {
    const name = window
      .prompt(this.#label("menu.rename_prompt", { name: node.name }), node.name)
      ?.trim();
    if (!name || name === node.name) return;
    if (this.#nameTaken(name, node.id)) {
      this.#status(this.#label("save_failed", { error: name }));
      return;
    }
    this.#editLook(node.id, { name });
  }

  #editLook(id, attributes) {
    this.#changePlan((plan) => {
      const group = plan.groups.find((g) => g.key === id);
      if (group) {
        Object.assign(group, attributes);
        return;
      }
      const category = this.#categoriesById.get(id);
      const override = { ...(plan.overrides[id] || {}) };
      for (const [key, value] of Object.entries(attributes)) {
        if (value === category[key]) delete override[key];
        else override[key] = value;
      }
      if (Object.keys(override).length) plan.overrides[id] = override;
      else delete plan.overrides[id];
    });
  }

  // --- colour and icon ---

  #openAppearance(node, depth) {
    this.#appearanceFor = node.id;
    const look = this.#look(node.id);
    const isChild = depth === 1 || this.#parentOf(node.id) !== null;
    this.appearanceTitleTarget.textContent = look.name;
    this.appearanceColorsTarget.classList.toggle("hidden", isChild);
    this.appearanceColorNoteTarget.classList.toggle("hidden", !isChild);
    for (const radio of this.appearanceTarget.querySelectorAll(
      "input[type=radio]",
    ))
      radio.checked = radio.value === look.icon;

    const panel = this.appearanceTarget;
    panel.classList.remove("hidden");
    const rect = panel.getBoundingClientRect();
    panel.style.left = `${Math.max(8, (window.innerWidth - rect.width) / 2)}px`;
    panel.style.top = `${Math.max(8, (window.innerHeight - rect.height) / 2)}px`;
    panel.querySelector("button, input")?.focus();
  }

  #setAppearance(attributes) {
    if (!this.#appearanceFor) return;
    this.#editLook(this.#appearanceFor, attributes);
  }
}
