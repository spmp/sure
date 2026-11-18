import { Controller } from "@hotwired/stimulus";
import * as d3 from "d3";

const UNCATEGORIZED = "uncategorized";

// Connects to data-controller="budget-planner"
//
// Spending is kept per leaf category and month. Every node sums its leaves
// month by month, so a node's average and median are taken over its own
// monthly totals — summing children's medians would not give the parent's.
export default class extends Controller {
  static targets = ["circles", "history", "historyTitle", "panel"];
  static values = { history: Object, labels: Object };

  #hidden = new Set();
  #selected = null;
  #resizeObserver = null;

  connect() {
    this.#draw();
    this.#resizeObserver = new ResizeObserver(() => this.#drawCharts());
    this.#resizeObserver.observe(this.circlesTarget);
  }

  disconnect() {
    this.#resizeObserver?.disconnect();
  }

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
    return (this.labelsValue[key] || key).replace(
      /%\{(\w+)\}/g,
      (_, name) => vars[name] ?? "",
    );
  }

  // Top-level nodes for the live hierarchy, each with leaf children. A
  // parent's own transactions become a "(direct)" leaf so its circle's
  // size matches its total.
  get #tree() {
    const { categories, spending, uncategorized } = this.historyValue;
    const zeros = () => new Array(this.#periodCount).fill(0);
    const children = d3.group(categories, (c) => c.parent_id);

    const tops = (children.get(null) || []).map((parent) => {
      const leaves = [];
      if (spending[parent.id]) {
        leaves.push({
          id: `${parent.id}:direct`,
          name: this.#label("direct", { name: parent.name }),
          color: parent.color,
          series: spending[parent.id],
        });
      }
      for (const child of children.get(parent.id) || []) {
        leaves.push({
          id: child.id,
          name: child.name,
          color: child.color,
          series: spending[child.id] || zeros(),
        });
      }
      return { id: parent.id, name: parent.name, color: parent.color, leaves };
    });

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

    const active = tree.filter((top) => top.total > 0);
    const inactive = tree.filter((top) => top.total <= 0);

    const list = document.createElement("ul");
    list.className = "divide-y divide-subdued";
    for (const top of active) {
      list.append(this.#row(top, money, 0));
      if (this.#isSingle(top)) continue;
      for (const leaf of top.leaves.filter((l) => l.total > 0)) {
        list.append(this.#row(leaf, money, 1));
      }
    }
    panel.append(list);

    const totalSpend = this.#stats(
      d3.range(this.#periodCount).map((i) =>
        d3.sum(
          active.filter((t) => !this.#hidden.has(t.id)),
          (t) => t.series[i],
        ),
      ),
    );
    panel.append(this.#summaryRow(this.#label("total"), totalSpend, money));

    const incomeRows = this.#incomeRows;
    if (incomeRows.length) {
      panel.append(this.#heading(this.#label("income")));
      const incomeList = document.createElement("ul");
      incomeList.className = "divide-y divide-subdued";
      for (const row of incomeRows)
        incomeList.append(this.#row(row, money, 0, false));
      panel.append(incomeList);
      const totalIncome = this.#stats(
        d3
          .range(this.#periodCount)
          .map((i) => d3.sum(incomeRows, (r) => r.series[i])),
      );
      panel.append(this.#summaryRow(this.#label("total"), totalIncome, money));
    }

    const incomeIds = new Set(Object.keys(this.historyValue.income));
    const unused = [
      ...inactive.filter((top) => !incomeIds.has(top.id)),
      ...active.flatMap((top) => top.leaves.filter((l) => l.total <= 0)),
    ];
    if (unused.length) {
      panel.append(this.#heading(this.#label("inactive")));
      const p = document.createElement("p");
      p.className = "text-xs text-subdued";
      p.textContent = unused.map((n) => n.name).join(", ");
      panel.append(p);
    }
  }

  #row(node, money, depth, hideable = true) {
    const hidden = this.#hidden.has(node.id);
    const li = document.createElement("li");
    li.className = `flex items-center gap-2 py-2 ${depth ? "pl-5" : ""} ${hidden ? "opacity-50" : ""}`;
    if (depth === 0 && node.id === this.#selected)
      li.classList.add("bg-surface-inset");

    const dot = document.createElement("span");
    dot.className = "w-2.5 h-2.5 rounded-full shrink-0";
    dot.style.backgroundColor = node.color;

    const name = document.createElement(
      depth === 0 && hideable ? "button" : "span",
    );
    name.className = `min-w-0 flex-1 truncate text-left ${depth ? "text-secondary" : "text-primary font-medium"}`;
    name.textContent = node.name;
    if (name.tagName === "BUTTON") {
      name.type = "button";
      name.dataset.nodeId = node.id;
      name.dataset.action = "budget-planner#select";
      name.setAttribute("aria-pressed", String(node.id === this.#selected));
    }

    const values = document.createElement("span");
    values.className = "shrink-0 tabular-nums text-secondary whitespace-nowrap";
    values.textContent = `${money.format(node.average)} · ${money.format(node.median)}`;

    li.append(dot, name, values);

    if (hideable) {
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "shrink-0 text-xs text-subdued hover:text-primary";
      toggle.dataset.nodeId = node.id;
      toggle.dataset.action = "budget-planner#toggleHidden";
      toggle.setAttribute("aria-pressed", String(hidden));
      toggle.textContent = hidden ? this.#label("show") : this.#label("hide");
      li.append(toggle);
    }
    return li;
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
