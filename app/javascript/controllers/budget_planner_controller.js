import { Controller } from "@hotwired/stimulus";
import * as d3 from "d3";

const UNCATEGORIZED = "uncategorized";
const WIDE_KEY = "budgetPlanner.wide";

// Connects to data-controller="budget-planner"
//
// Spending is kept per leaf category and month. Every node sums its leaves
// month by month, so a node's average and median are taken over its own
// monthly totals — summing children's medians would not give the parent's.
//
// In draft mode the hierarchy comes from the family's draft: `parents` maps a
// category id to its new parent (a category id, a new group's key, or null)
// and `groups` are new top-level groups. Everything on the page follows it.
export default class extends Controller {
  static targets = [
    "circles",
    "history",
    "historyTitle",
    "panel",
    "budgetTotal",
    "incomeSlot",
    "remaining",
    "remainingRow",
    "apply",
    "chartsColumn",
    "panelCard",
    "modeButton",
    "draftStatus",
    "widthToggle",
    "draftTools",
    "newGroupName",
    "applyGrouping",
    "draftSummary",
  ];
  static values = {
    history: Object,
    plan: Object,
    draft: Object,
    labels: Object,
    draftUrl: String,
    colors: Array,
  };

  // Amount per top-level node id (category, group key or UNCATEGORIZED).
  // Kept here so redrawing the panel keeps edits.
  #amounts = new Map();
  #edited = new Set();
  #expectedIncome = 0;
  #hidden = new Set();
  #selected = null;
  #mode = "live";
  #draft = { parents: {}, groups: [] };
  #wide = false;
  #saveTimer = null;
  #resizeObserver = null;

  connect() {
    this.#draft = {
      parents: { ...(this.draftValue.parents || {}) },
      groups: [...(this.draftValue.groups || [])],
    };
    this.#mode = this.#canDraft && this.#draftChanged ? "draft" : "live";
    this.#wide = this.#readWide();

    this.#startAmounts();
    this.#applyChrome();
    this.#draw();
    this.#resizeObserver = new ResizeObserver(() => this.#drawCharts());
    this.#resizeObserver.observe(this.circlesTarget);
  }

  disconnect() {
    this.#resizeObserver?.disconnect();
    clearTimeout(this.#saveTimer);
  }

  // --- actions ---

  toggleHidden(event) {
    const id = event.currentTarget.dataset.nodeId;
    if (this.#hidden.has(id)) this.#hidden.delete(id);
    else this.#hidden.add(id);
    this.#draw();
  }

  select(event) {
    const id = event.currentTarget.dataset.nodeId;
    this.#selected = this.#selected === id ? null : id;
    this.#draw();
  }

  fill(event) {
    this.#edited.clear();
    this.#fillAmounts(event.currentTarget.dataset.source);
    this.#draw();
  }

  editAmount(event) {
    const input = event.currentTarget;
    this.#amounts.set(input.dataset.nodeId, this.#parse(input.value));
    this.#edited.add(input.dataset.nodeId);
    this.#markInvalid(input);
    this.#updateTotals();
  }

  editIncome(event) {
    this.#expectedIncome = this.#parse(event.currentTarget.value);
    this.#updateTotals();
  }

  setMode(event) {
    this.#mode = event.currentTarget.dataset.mode;
    this.#syncAmounts();
    this.#applyChrome();
    this.#draw();
  }

  toggleWidth() {
    this.#wide = !this.#wide;
    try {
      localStorage.setItem(WIDE_KEY, this.#wide ? "1" : "0");
    } catch {}
    this.#applyChrome();
    this.#draw();
  }

  addGroup() {
    const input = this.newGroupNameTarget;
    const name = input.value.trim();
    const taken = [
      ...this.historyValue.categories.map((c) => c.name),
      ...this.#draft.groups.map((g) => g.name),
    ].some((existing) => existing.toLowerCase() === name.toLowerCase());
    input.setAttribute("aria-invalid", String(!name || taken));
    if (!name || taken) return;

    const bytes = crypto.getRandomValues(new Uint8Array(4));
    const key = `new-${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
    const colors = this.colorsValue;
    this.#draft.groups.push({
      key,
      name,
      color: colors[this.#draft.groups.length % colors.length],
    });
    input.value = "";
    this.#afterDraftChange();
  }

  // --- draft ---

  get #canDraft() {
    return this.draftValue.can_edit && this.planValue.editable;
  }

  get #draftChanged() {
    return (
      Object.keys(this.#draft.parents).length > 0 ||
      this.#draft.groups.length > 0
    );
  }

  get #categoriesById() {
    return new Map(this.historyValue.categories.map((c) => [c.id, c]));
  }

  #parentOf(id) {
    const parents = this.#draft.parents;
    if (this.#mode === "draft" && Object.hasOwn(parents, id))
      return parents[id];
    return this.#categoriesById.get(id)?.parent_id ?? null;
  }

  #childrenOf(id) {
    return this.historyValue.categories.filter(
      (c) => this.#parentOf(c.id) === id,
    );
  }

  #moveCategory(id, target) {
    const live = this.#categoriesById.get(id)?.parent_id ?? null;
    if (target === live) delete this.#draft.parents[id];
    else this.#draft.parents[id] = target;
    this.#afterDraftChange();
  }

  #removeGroup(key) {
    this.#draft.groups = this.#draft.groups.filter((g) => g.key !== key);
    this.#amounts.delete(key);
    this.#afterDraftChange();
  }

  // A node can go under `target` only if it has no children itself and the
  // target is top-level: Sure keeps two levels.
  #canMove(id, target) {
    if (target === null) return true;
    if (target === id || this.#childrenOf(id).length > 0) return false;
    if (this.#draft.groups.some((g) => g.key === target)) return true;
    return this.#categoriesById.has(target) && this.#parentOf(target) === null;
  }

  #afterDraftChange() {
    this.#syncAmounts();
    this.#draw();
    this.#scheduleSave();
  }

  #scheduleSave() {
    clearTimeout(this.#saveTimer);
    this.#status(this.#label("saving"));
    this.#saveTimer = setTimeout(() => this.#save(), 500);
  }

  async #save() {
    const token = document.querySelector('meta[name="csrf-token"]')?.content;
    try {
      const response = await fetch(this.draftUrlValue, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "X-CSRF-Token": token,
        },
        body: JSON.stringify({ draft: this.#draft }),
      });
      const body = await response.json().catch(() => ({}));
      if (response.ok) this.#status(this.#label("saved"));
      else
        this.#status(
          this.#label("save_failed", {
            error: (body.errors || [response.statusText]).join(", "),
          }),
        );
    } catch (error) {
      this.#status(this.#label("save_failed", { error: error.message }));
    }
  }

  #status(text) {
    if (this.hasDraftStatusTarget) this.draftStatusTarget.textContent = text;
  }

  #readWide() {
    try {
      return localStorage.getItem(WIDE_KEY) === "1";
    } catch {
      return false;
    }
  }

  // Mode buttons, draft tools, panel width and the Apply wording.
  #applyChrome() {
    const draft = this.#mode === "draft";
    for (const button of this.modeButtonTargets) {
      const active = button.dataset.mode === this.#mode;
      button.classList.toggle("segmented-control__segment--active", active);
      button.setAttribute("aria-pressed", String(active));
    }
    if (this.hasDraftToolsTarget)
      this.draftToolsTarget.classList.toggle("hidden", !draft);
    if (!draft) this.#status("");

    this.chartsColumnTarget.classList.toggle("@4xl:col-span-3", !this.#wide);
    this.chartsColumnTarget.classList.toggle("@4xl:col-span-2", this.#wide);
    this.panelCardTarget.classList.toggle("@4xl:col-span-2", !this.#wide);
    this.panelCardTarget.classList.toggle("@4xl:col-span-3", this.#wide);
    if (this.hasWidthToggleTarget)
      this.widthToggleTarget.setAttribute("aria-pressed", String(this.#wide));
  }

  #updateDraftSummary() {
    const applying = this.#mode === "draft" && this.#draftChanged;
    if (this.hasApplyGroupingTarget)
      this.applyGroupingTarget.value = applying ? "1" : "0";
    if (!this.hasDraftSummaryTarget) return;

    this.draftSummaryTarget.classList.toggle("hidden", !applying);
    if (!applying) return;
    const moves = Object.keys(this.#draft.parents).length;
    const groups = this.#draft.groups.length;
    this.draftSummaryTarget.textContent = this.#label("draft_summary", {
      moves: this.#plural("moves", moves),
      groups: this.#plural("groups", groups),
    });
  }

  #plural(key, count) {
    const forms = this.labelsValue[key] || {};
    return (count === 1 ? forms.one : forms.other).replace("%{count}", count);
  }

  // --- amounts ---

  // A budget that already has amounts starts from them; a new one starts
  // from the history average.
  #startAmounts() {
    const plan = this.planValue;
    this.#fillAmounts(plan.initialized ? "current" : "average");
    this.#expectedIncome = Math.round(
      plan.expected_income ?? d3.sum(this.#incomeRows, (r) => r.average),
    );
  }

  #currentAmount(id) {
    const plan = this.planValue;
    if (id === UNCATEGORIZED) return plan.uncategorized;
    return plan.amounts[id] ?? plan.own_amounts?.[id] ?? 0;
  }

  #fillAmounts(source) {
    this.#amounts = new Map();
    for (const top of this.#listedTops(this.#tree)) {
      if (!this.#budgetable(top)) continue;
      const current = this.#currentAmount(top.id);
      const amount =
        source === "current" && current != null && !top.changed
          ? current
          : top[source === "current" ? "average" : source];
      this.#amounts.set(top.id, Math.round(amount || 0));
    }
  }

  // After the draft changes: new tops get an amount, tops whose contents
  // changed follow their new average unless the user typed one, and nodes
  // that are no longer top-level drop out.
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
      const current = this.#currentAmount(top.id);
      const amount = !top.changed && current ? current : top.average;
      this.#amounts.set(top.id, Math.round(amount || 0));
    }
  }

  #budgetable(top) {
    return (
      top.id === UNCATEGORIZED || top.group || this.#categoriesById.has(top.id)
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
        (c) => c.parent_id === id && this.#parentOf(c.id) === id,
      ),
      (c) => own[c.id] || 0,
    );
  }

  #markInvalid(input) {
    const id = input.dataset.nodeId;
    const invalid = this.#amounts.get(id) < this.#minimum(id);
    input.setAttribute("aria-invalid", String(invalid));
    input.classList.toggle("text-destructive", invalid);
    const note = input.closest("li")?.querySelector("[data-minimum-note]");
    note?.classList.toggle("hidden", !invalid);
  }

  // Top-level categories without an input keep their current amount, so
  // they still count towards the total.
  #budgetTotal() {
    const unlisted = this.historyValue.categories
      .filter((c) => this.#parentOf(c.id) === null && !this.#amounts.has(c.id))
      .reduce((sum, c) => sum + (this.#currentAmount(c.id) || 0), 0);
    return d3.sum([...this.#amounts.values()]) + unlisted;
  }

  #updateTotals() {
    const money = this.#money;
    const total = this.#budgetTotal();
    const remaining = this.#expectedIncome - total;
    this.budgetTotalTarget.textContent = money.format(total);
    this.remainingTarget.textContent = money.format(remaining);
    this.remainingRowTarget.classList.toggle("bg-success/10", remaining >= 0);
    this.remainingRowTarget.classList.toggle("text-success", remaining >= 0);
    this.remainingRowTarget.classList.toggle(
      "bg-destructive/10",
      remaining < 0,
    );
    this.remainingRowTarget.classList.toggle("text-destructive", remaining < 0);

    if (this.hasApplyTarget) {
      const invalid = [...this.#amounts].some(
        ([id, amount]) => amount < this.#minimum(id),
      );
      this.applyTarget.disabled = invalid;
    }
    this.#updateDraftSummary();
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
    input.className = "form-field__input text-right tabular-nums";
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
    return String(this.labelsValue[key] || key).replace(
      /%\{(\w+)\}/g,
      (_, name) => vars[name] ?? "",
    );
  }

  // Top-level nodes, each with leaf children. A category's own transactions
  // become a "(direct)" leaf so its circle's size matches its total.
  // Children are drawn in their parent's colour, as Sure stores them.
  get #tree() {
    const { categories, spending, uncategorized } = this.historyValue;
    const zeros = () => new Array(this.#periodCount).fill(0);
    const draft = this.#mode === "draft";

    const tops = categories
      .filter((c) => this.#parentOf(c.id) === null)
      .map((c) => ({ id: c.id, name: c.name, color: c.color }));
    if (draft) {
      for (const group of this.#draft.groups)
        tops.push({
          id: group.key,
          name: group.name,
          color: group.color,
          group: true,
        });
    }

    for (const top of tops) {
      top.leaves = [];
      if (spending[top.id]) {
        top.leaves.push({
          id: `${top.id}:direct`,
          name: this.#label("direct", { name: top.name }),
          color: top.color,
          series: spending[top.id],
        });
      }
      const liveChildren = categories.filter((c) => c.parent_id === top.id);
      const children = this.#childrenOf(top.id);
      for (const child of children) {
        top.leaves.push({
          id: child.id,
          categoryId: child.id,
          name: child.name,
          color: top.color,
          series: spending[child.id] || zeros(),
          moved: draft && child.parent_id !== top.id,
        });
      }
      top.moved =
        draft && !top.group && Object.hasOwn(this.#draft.parents, top.id);
      top.changed =
        top.group ||
        top.moved ||
        liveChildren.length !== children.length ||
        children.some((c) => c.parent_id !== top.id);
    }

    if (spending[UNCATEGORIZED]) {
      tops.push({
        id: UNCATEGORIZED,
        name: uncategorized.name,
        color: uncategorized.color,
        leaves: [
          {
            id: `${UNCATEGORIZED}:direct`,
            name: uncategorized.name,
            color: uncategorized.color,
            series: spending[UNCATEGORIZED],
          },
        ],
      });
    }

    for (const top of tops) {
      for (const leaf of top.leaves)
        Object.assign(leaf, this.#stats(leaf.series));
      top.series = d3
        .range(this.#periodCount)
        .map((i) => d3.sum(top.leaves, (leaf) => leaf.series[i]));
      Object.assign(top, this.#stats(top.series));
    }

    return tops.sort((a, b) => b.total - a.total);
  }

  // The tops that get a row: those with spending, and in draft mode every
  // spending category and group so anything can be moved.
  #listedTops(tree) {
    const income = this.historyValue.income;
    if (this.#mode !== "draft") return tree.filter((top) => top.total > 0);
    return tree.filter(
      (top) =>
        top.total > 0 ||
        top.group ||
        (!income[top.id] && top.id !== UNCATEGORIZED),
    );
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
          series,
          ...this.#stats(series),
        };
      })
      .sort((a, b) => b.total - a.total);
  }

  // --- drawing ---

  #draw() {
    const tree = this.#tree;
    this.#drawPanel(tree);
    this.#drawCharts(tree);
  }

  #drawCharts(tree = this.#tree) {
    this.#drawCircles(tree);
    this.#drawHistory(tree);
  }

  #drawCircles(tree) {
    const container = this.circlesTarget;
    container.innerHTML = "";
    const size = container.clientWidth;
    if (!size) return;

    const visible = tree
      .filter((top) => !this.#hidden.has(top.id))
      .map((top) => {
        if (this.#isSingle(top)) return { ...top, children: null };
        const children = top.leaves.filter(
          (leaf) => !this.#hidden.has(leaf.id) && leaf.total > 0,
        );
        return { ...top, children, total: d3.sum(children, (c) => c.total) };
      })
      .filter((top) => (top.children ? top.children.length : top.total > 0));

    if (!visible.length) {
      container.textContent = this.#label("empty");
      container.className += " text-sm text-subdued";
      return;
    }

    const root = d3
      .hierarchy({ children: visible })
      .sum((d) => (d.children ? 0 : d.total))
      .sort((a, b) => b.value - a.value);
    d3.pack().size([size, size]).padding(4)(root);

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
      .attr("transform", (d) => `translate(${d.x},${d.y})`);

    node
      .append("circle")
      .attr("r", (d) => d.r)
      .attr("fill", (d) => d.data.color)
      .attr("fill-opacity", (d) => (d.children ? 0.12 : 0.55))
      .attr("stroke", (d) => d.data.color)
      .attr("stroke-width", (d) => (this.#isSelected(d) ? 3 : 1))
      .style("cursor", (d) => (d.depth === 1 ? "pointer" : null))
      .on("click", (event, d) => {
        const top = d.depth === 1 ? d : d.parent;
        this.#selected = this.#selected === top.data.id ? null : top.data.id;
        this.#draw();
      })
      .append("title")
      .text(
        (d) =>
          `${d.data.name}: ${this.#money.format(d.data.average)} / ${this.#money.format(d.data.median)}`,
      );

    node
      .filter((d) => d.depth === 1 && d.r > 34)
      .append("text")
      .attr("text-anchor", "middle")
      .attr("y", (d) => (d.children ? -d.r + 16 : 4))
      .attr("class", "fill-current text-primary text-xs font-medium")
      .style("pointer-events", "none")
      .text((d) => d.data.name);
  }

  // A top-level category with no subcategories: its own transactions are
  // its only leaf, so it is drawn and listed once rather than nested.
  #isSingle(top) {
    return top.leaves.length === 1 && top.leaves[0].id.endsWith(":direct");
  }

  #isSelected(d) {
    return d.depth === 1 && d.data.id === this.#selected;
  }

  #drawHistory(tree) {
    const container = this.historyTarget;
    container.innerHTML = "";
    const width = container.clientWidth;
    const height = container.clientHeight || 224;
    if (!width) return;

    const selected = tree.find((top) => top.id === this.#selected);
    this.historyTitleTarget.textContent = selected
      ? selected.name
      : this.#label("all_categories");
    this.historyTitleTarget.style.color = selected ? selected.color : "";
    const shown = tree.filter((top) => !this.#hidden.has(top.id));
    const spend = selected
      ? selected.series
      : d3
          .range(this.#periodCount)
          .map((i) => d3.sum(shown, (t) => t.series[i]));
    const income = selected
      ? null
      : d3
          .range(this.#periodCount)
          .map((i) => d3.sum(this.#incomeRows, (r) => r.series[i]));

    const periods = this.historyValue.periods.map(
      (p) => new Date(p.start_date),
    );
    const margin = { top: 8, right: 8, bottom: 22, left: 56 };
    const x = d3
      .scaleBand()
      .domain(d3.range(periods.length))
      .range([margin.left, width - margin.right])
      .padding(0.3);
    const y = d3
      .scaleLinear()
      .domain([0, d3.max([...spend, ...(income || [])]) || 1])
      .nice()
      .range([height - margin.bottom, margin.top]);

    const svg = d3
      .select(container)
      .append("svg")
      .attr("width", width)
      .attr("height", height)
      .attr("role", "img")
      .attr(
        "aria-label",
        selected ? selected.name : this.#label("all_categories"),
      );

    svg
      .append("g")
      .attr("transform", `translate(0,${height - margin.bottom})`)
      .attr("class", "text-subdued")
      .call(
        d3
          .axisBottom(x)
          .tickFormat((i) => d3.timeFormat("%b")(periods[i]))
          .tickSizeOuter(0),
      );
    svg
      .append("g")
      .attr("transform", `translate(${margin.left},0)`)
      .attr("class", "text-subdued")
      .call(
        d3
          .axisLeft(y)
          .ticks(4)
          .tickFormat((v) => this.#money.format(v)),
      )
      .call((g) => g.select(".domain").remove());

    svg
      .append("g")
      .selectAll("rect")
      .data(spend)
      .join("rect")
      .attr("x", (_, i) => x(i))
      .attr("y", (v) => y(v))
      .attr("width", x.bandwidth())
      .attr("height", (v) => y(0) - y(v))
      .attr("rx", 2)
      .attr("fill", selected ? selected.color : "currentColor")
      .attr("class", selected ? null : "text-secondary")
      .append("title")
      .text(
        (v, i) =>
          `${d3.timeFormat("%b %Y")(periods[i])}: ${this.#money.format(v)}`,
      );

    if (income) {
      svg
        .append("path")
        .datum(income)
        .attr("fill", "none")
        .attr("stroke", "currentColor")
        .attr("stroke-width", 2)
        .attr("class", "text-success")
        .attr(
          "d",
          d3
            .line()
            .x((_, i) => x(i) + x.bandwidth() / 2)
            .y((v) => y(v)),
        );
    }
  }

  #drawPanel(tree) {
    const money = this.#money;
    const panel = this.panelTarget;
    panel.innerHTML = "";
    const draft = this.#mode === "draft";

    this.incomeSlotTarget.replaceChildren(
      this.#amountField(
        null,
        "plan[expected_income]",
        this.#expectedIncome,
        this.#label("income"),
      ),
    );

    const listed = this.#listedTops(tree);
    const list = document.createElement("ul");
    list.className = "divide-y divide-subdued";
    for (const top of listed) {
      list.append(this.#row(top, money, 0, true, tree));
      if (this.#isSingle(top) && !draft) continue;
      for (const leaf of top.leaves) {
        if (leaf.total <= 0 && !draft) continue;
        if (this.#isSingle(top) && leaf.id.endsWith(":direct")) continue;
        list.append(this.#row(leaf, money, 1, true, tree));
      }
    }
    panel.append(list);

    const shown = listed.filter((t) => !this.#hidden.has(t.id));
    const totalSpend = this.#stats(
      d3.range(this.#periodCount).map((i) => d3.sum(shown, (t) => t.series[i])),
    );
    panel.append(this.#summaryRow(this.#label("total"), totalSpend, money));

    const incomeRows = this.#incomeRows;
    if (incomeRows.length) {
      panel.append(this.#heading(this.#label("income")));
      const incomeList = document.createElement("ul");
      incomeList.className = "divide-y divide-subdued";
      for (const row of incomeRows)
        incomeList.append(this.#row(row, money, 0, false, tree));
      panel.append(incomeList);
      const totalIncome = this.#stats(
        d3
          .range(this.#periodCount)
          .map((i) => d3.sum(incomeRows, (r) => r.series[i])),
      );
      panel.append(this.#summaryRow(this.#label("total"), totalIncome, money));
    }

    if (!draft) {
      const listedIds = new Set(listed.map((t) => t.id));
      const unused = [
        ...tree.filter(
          (t) => !listedIds.has(t.id) && !this.historyValue.income[t.id],
        ),
        ...listed.flatMap((top) => top.leaves.filter((l) => l.total <= 0)),
      ];
      if (unused.length) {
        panel.append(this.#heading(this.#label("inactive")));
        const p = document.createElement("p");
        p.className = "text-xs text-subdued";
        p.textContent = unused.map((n) => n.name).join(", ");
        panel.append(p);
      }
    }

    this.#updateTotals();
  }

  #row(node, money, depth, spendingRow, tree) {
    const draft = this.#mode === "draft";
    const hidden = this.#hidden.has(node.id);
    const details = this.#wide ? "" : "@4xl:hidden";
    const li = document.createElement("li");
    li.className = `flex items-center gap-2 py-2 ${depth ? "pl-5" : ""} ${hidden ? "opacity-50" : ""}`;
    if (depth === 0 && node.id === this.#selected)
      li.classList.add("bg-surface-inset");

    const dot = document.createElement("span");
    dot.className = "w-2.5 h-2.5 rounded-full shrink-0";
    dot.style.backgroundColor = node.color;

    const name = document.createElement(
      depth === 0 && spendingRow ? "button" : "span",
    );
    name.className = `block max-w-full min-w-0 truncate text-left ${depth ? "text-secondary" : "text-primary font-medium"}`;
    name.textContent = node.name;
    if (name.tagName === "BUTTON") {
      name.type = "button";
      name.dataset.nodeId = node.id;
      name.dataset.action = "budget-planner#select";
      name.setAttribute("aria-pressed", String(node.id === this.#selected));
    }

    const values = document.createElement("span");
    values.className = `block text-xs tabular-nums text-subdued ${details}`;
    values.textContent = `${money.format(node.average)} · ${money.format(node.median)}`;

    const text = document.createElement("div");
    text.className = "min-w-0 flex-1";
    text.append(name, values);
    if (node.group || node.moved) {
      const badge = document.createElement("span");
      badge.className =
        "inline-block mt-0.5 px-1.5 rounded text-xs bg-surface-inset text-secondary";
      badge.textContent = node.group
        ? this.#label("new_group")
        : this.#label("moved");
      text.append(badge);
    }

    li.append(dot, text);

    const categoryId = this.#categoriesById.has(node.id) ? node.id : null;
    if (draft && spendingRow && categoryId) {
      li.append(this.#moveSelect(categoryId, node.name, tree));
      this.#makeDraggable(li, categoryId);
    }
    if (draft && depth === 0 && spendingRow) this.#makeDropTarget(li, node.id);

    if (depth === 0 && spendingRow && this.#budgetable(node)) {
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

    if (draft && node.group && node.leaves.length === 0) {
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "shrink-0 text-xs text-subdued hover:text-primary";
      remove.textContent = this.#label("remove_group");
      remove.addEventListener("click", () => this.#removeGroup(node.id));
      li.append(remove);
    }

    if (spendingRow) {
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = `shrink-0 text-xs text-subdued hover:text-primary ${details}`;
      toggle.dataset.nodeId = node.id;
      toggle.dataset.action = "budget-planner#toggleHidden";
      toggle.setAttribute("aria-pressed", String(hidden));
      toggle.textContent = hidden ? this.#label("show") : this.#label("hide");
      li.append(toggle);
    }
    return li;
  }

  #moveSelect(id, name, tree) {
    const wrapper = document.createElement("div");
    wrapper.className = "form-field w-32 shrink-0";
    const select = document.createElement("select");
    select.className = "form-field__input text-xs";
    select.setAttribute("aria-label", this.#label("move_to", { name }));

    const current = this.#parentOf(id);
    const options = [{ value: "", label: this.#label("top_level") }].concat(
      tree
        .filter((top) => top.id !== UNCATEGORIZED && top.id !== id)
        .map((top) => ({ value: top.id, label: top.name })),
    );
    for (const option of options) {
      const el = document.createElement("option");
      el.value = option.value;
      el.textContent = option.label;
      el.selected = option.value === (current ?? "");
      el.disabled = !el.selected && !this.#canMove(id, option.value || null);
      select.append(el);
    }
    select.addEventListener("change", () =>
      this.#moveCategory(id, select.value || null),
    );
    wrapper.append(select);
    return wrapper;
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
    if (target === UNCATEGORIZED) return;
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
      if (id && this.#canMove(id, target)) this.#moveCategory(id, target);
    });
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
}
