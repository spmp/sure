import * as d3 from "d3";
import {
  budgetAt,
  detectCycle,
  fitSpending,
  rolling,
} from "utils/spending_models";

// Draws the budget planner's "Spending over time" chart. Stateless: the
// planner passes what to draw and gets clicks and hovers back through
// callbacks, then calls drawPlannerChart again.
//
// input = {
//   view: "lines" | "percent" | "multiples" | "grid",
//   months: [Date], history: number,   // months.length >= history
//   parents: [{ id, name, color, series, budget }],  // budget: base amount or null
//   shown: Set, focus: id | null, window: [i0, i1] (history indexes),
//   options: { rolling, fit, fitFor, shade, cycles, colourAll, growth,
//              compound, ahead, anchor },
//   hover: index | null, money: Intl.NumberFormat, labels: {...},
//   onFocus(id), onHover(index | null), onWindow([i0, i1]),
// }
const VIEW_HEIGHT = { lines: 360, percent: 320 };

// "One each": how wide each small chart may get, and how tall it is.
const MULTIPLE_SIZES = {
  small: { column: "repeat(auto-fill, minmax(220px, 1fr))", height: 140 },
  medium: { column: "repeat(auto-fill, minmax(360px, 1fr))", height: 190 },
  large: { column: "minmax(0, 1fr)", height: 240 },
};

export function drawPlannerChart(container, overviewSvg, input) {
  const chart = new PlannerChart(input);
  if (overviewSvg) chart.drawOverview(overviewSvg);
  chart.draw(container);
  return chart;
}

class PlannerChart {
  constructor(input) {
    this.input = input;
    this.o = input.options;
    this.fmtTick = d3.timeFormat(input.history > 12 ? "%b %y" : "%b");
    this.fmtMonth = d3.timeFormat("%b %Y");
    for (const p of input.parents) {
      p.actual = this.o.rolling ? rolling(p.series) : p.series;
      p.model = fitSpending(p.series, (i) => input.months[i].getMonth());
      p.cycle = detectCycle(p.series);
    }
  }

  get shown() {
    return this.input.parents.filter((p) => this.input.shown.has(p.id));
  }

  // History indexes in the window, plus projected months when the window
  // reaches the latest month.
  get range() {
    const [i0, i1] = this.input.window;
    const end = i1 === this.input.history - 1 ? i1 + this.o.ahead : i1;
    return d3.range(i0, Math.min(end, this.input.months.length - 1) + 1);
  }

  fitted(p, i) {
    return p.model.at(i, this.o.fit === "trend" ? "trend" : "yearly");
  }

  budget(p, i) {
    if (p.budget == null) return null;
    return budgetAt(
      {
        base: p.budget,
        anchor: this.o.anchor,
        growth: this.o.growth,
        compound: this.o.compound,
      },
      i,
    );
  }

  // Actual spending in the past; the fitted forecast ahead.
  compared(p, i) {
    return i < this.input.history ? p.actual[i] : this.fitted(p, i);
  }

  fitFor(p) {
    return (
      this.o.fit !== "off" &&
      (this.o.fitFor === "all" || p.id === this.input.focus)
    );
  }

  // Over/under shows for every category, for the focused one, and for
  // any whose chip asks for it.
  shadeFor(p) {
    if (p.budget == null) return false;
    if (this.input.shaded?.has(p.id)) return true;
    return (
      this.o.shade === "all" ||
      (this.o.shade === "focus" && p.id === this.input.focus)
    );
  }

  overCount(p) {
    if (p.budget == null) return null;
    const months = this.range.filter((i) => i < this.input.history);
    return {
      over: months.filter((i) => p.actual[i] > this.budget(p, i)).length,
      of: months.length,
    };
  }

  label(key, vars = {}) {
    const text = key
      .split(".")
      .reduce((node, part) => node?.[part], this.input.labels);
    return String(text ?? key).replace(
      /%\{(\w+)\}/g,
      (_, name) => vars[name] ?? "",
    );
  }

  // --- overview strip: zoom and scroll ---

  drawOverview(svgEl) {
    const svg = d3.select(svgEl);
    svg.selectAll("*").remove();
    const { history, parents } = this.input;
    const width = svgEl.clientWidth || 600;
    const height = 48;
    svg.attr("viewBox", [0, 0, width, height]).attr("height", height);
    const x = d3
      .scaleBand()
      .domain(d3.range(history))
      .range([0, width])
      .padding(0.15);
    const totals = d3
      .range(history)
      .map((i) => d3.sum(parents, (p) => p.series[i]));
    const y = d3
      .scaleLinear()
      .domain([0, d3.max(totals) || 1])
      .range([height - 14, 4]);
    svg
      .append("g")
      .attr("class", "text-subdued")
      .selectAll("rect")
      .data(totals)
      .join("rect")
      .attr("x", (_, i) => x(i))
      .attr("width", x.bandwidth())
      .attr("y", (v) => y(v))
      .attr("height", (v) => y(0) - y(v))
      .attr("rx", 1.5)
      .attr("fill", "currentColor")
      .attr("fill-opacity", 0.35);
    svg
      .append("g")
      .selectAll("text")
      .data(
        d3
          .range(history)
          .filter((i) => this.input.months[i].getMonth() === 0 || i === 0),
      )
      .join("text")
      .attr("x", (i) => x(i))
      .attr("y", height - 2)
      .attr("font-size", 10)
      .attr("class", "fill-current text-subdued")
      .text((i) => this.input.months[i].getFullYear());

    const brush = d3
      .brushX()
      .extent([
        [0, 0],
        [width, height - 12],
      ])
      .on("end", (event) => {
        if (!event.selection || !event.sourceEvent) return;
        const [a, b] = event.selection;
        const i0 = Math.max(0, Math.round(a / x.step()));
        const i1 = Math.min(
          history - 1,
          Math.max(i0 + 1, Math.round(b / x.step()) - 1),
        );
        this.input.onWindow([i0, i1]);
      });
    const g = svg.append("g").call(brush);
    const [i0, i1] = this.input.window;
    g.call(brush.move, [x(i0), x(i1) + x.bandwidth()]);
    g.select(".selection")
      .attr("class", "selection text-primary")
      .attr("fill", "currentColor")
      .attr("fill-opacity", 0.08)
      .attr("stroke", "currentColor")
      .attr("stroke-opacity", 0.4);
  }

  // --- main drawing ---

  draw(container) {
    container.replaceChildren();
    const draw = {
      lines: () => this.drawLines(container),
      percent: () => this.drawPercent(container),
      multiples: () => this.drawMultiples(container),
      grid: () => this.drawGrid(container),
    }[this.input.view];
    if (!this.shown.length) {
      this.empty(container, this.label("chart.pick"));
      return;
    }
    draw();
  }

  empty(container, text) {
    const p = document.createElement("p");
    p.className = "text-sm text-subdued py-6";
    p.textContent = text;
    container.replaceChildren(p);
  }

  svgIn(el, width, height) {
    return d3
      .select(el)
      .append("svg")
      .attr("viewBox", [0, 0, width, height])
      .attr("width", "100%")
      .attr("height", height)
      .style("overflow", "visible");
  }

  xScale(width, margin) {
    return d3
      .scalePoint()
      .domain(this.range)
      .range([margin.left, width - margin.right]);
  }

  axes(svg, x, y, width, height, margin, yFormat, small = false) {
    const idx = this.range;
    const every = Math.ceil(
      idx.length /
        Math.max(
          2,
          Math.floor((width - margin.left - margin.right) / (small ? 90 : 70)),
        ),
    );
    svg
      .append("g")
      .attr("transform", `translate(0,${height - margin.bottom})`)
      .attr("class", "text-subdued")
      .call(
        d3
          .axisBottom(x)
          .tickValues(idx.filter((_, k) => k % every === 0))
          .tickFormat((i) => this.fmtTick(this.input.months[i]))
          .tickSizeOuter(0),
      )
      .call((g) => g.selectAll("text").attr("font-size", small ? 10 : 11))
      .call((g) => g.selectAll("line,path").attr("stroke-opacity", 0.4));
    svg
      .append("g")
      .attr("transform", `translate(${margin.left},0)`)
      .attr("class", "text-subdued")
      .call(
        d3
          .axisLeft(y)
          .ticks(small ? 3 : 4)
          .tickFormat(yFormat)
          .tickSize(-(width - margin.left - margin.right)),
      )
      .call((g) => g.select(".domain").remove())
      .call((g) => g.selectAll("line").attr("stroke-opacity", 0.15))
      .call((g) => g.selectAll("text").attr("font-size", small ? 10 : 11));
  }

  forecastBand(svg, x, width, height, margin) {
    const { history } = this.input;
    if (this.range[this.range.length - 1] < history) return;
    const x0 = (x(history - 1) + x(history)) / 2;
    const g = svg.append("g").attr("class", "text-primary");
    g.append("rect")
      .attr("x", x0)
      .attr("y", margin.top)
      .attr("width", width - margin.right - x0)
      .attr("height", height - margin.top - margin.bottom)
      .attr("fill", "currentColor")
      .attr("fill-opacity", 0.035);
    g.append("line")
      .attr("x1", x0)
      .attr("x2", x0)
      .attr("y1", margin.top)
      .attr("y2", height - margin.bottom)
      .attr("stroke", "currentColor")
      .attr("stroke-opacity", 0.35);
    g.append("text")
      .attr("x", x0 + 4)
      .attr("y", margin.top + 10)
      .attr("font-size", 10)
      .attr("class", "fill-current text-subdued")
      .text(this.label("chart.forecast"));
  }

  cycleLines(svg, x, height, margin, p) {
    if (!this.o.cycles || !p.cycle) return;
    const { length, start } = p.cycle;
    svg
      .append("g")
      .selectAll("line")
      .data(
        this.range.filter(
          (i) => (((i - start) % length) + length) % length === 0,
        ),
      )
      .join("line")
      .attr("x1", (i) => x(i))
      .attr("x2", (i) => x(i))
      .attr("y1", margin.top)
      .attr("y2", height - margin.bottom)
      .attr("stroke", p.color)
      .attr("stroke-opacity", 0.4);
  }

  hatch(svg, id) {
    const pattern = svg
      .append("defs")
      .append("pattern")
      .attr("id", id)
      .attr("class", "text-destructive")
      .attr("width", 6)
      .attr("height", 6)
      .attr("patternUnits", "userSpaceOnUse")
      .attr("patternTransform", "rotate(45)");
    pattern
      .append("rect")
      .attr("width", 6)
      .attr("height", 6)
      .attr("fill", "currentColor")
      .attr("fill-opacity", 0.14);
    pattern
      .append("line")
      .attr("y2", 6)
      .attr("stroke", "currentColor")
      .attr("stroke-width", 1.5);
  }

  // Over/under shading between what's compared and the budget; lighter in
  // the forecast, and dimmed for unfocused categories.
  budgetShading(svg, x, y, p, hatchId, strength = 1) {
    const { history } = this.input;
    const g = svg.append("g").attr("opacity", strength);
    const v = (i) => this.compared(p, i);
    const b = (i) => this.budget(p, i);
    const parts = [
      [this.range.filter((i) => i < history), 1],
      [this.range.filter((i) => i >= history - 1), 0.5],
    ];
    for (const [part, opacity] of parts) {
      if (part.length < 2) continue;
      g.append("path")
        .datum(part)
        .attr("opacity", opacity)
        .attr("fill", `url(#${hatchId})`)
        .attr(
          "d",
          d3
            .area()
            .x((i) => x(i))
            .y0((i) => y(b(i)))
            .y1((i) => y(Math.max(v(i), b(i)))),
        );
      g.append("path")
        .datum(part)
        .attr("opacity", opacity)
        .attr("class", "text-success")
        .attr("fill", "currentColor")
        .attr("fill-opacity", 0.22)
        .attr(
          "d",
          d3
            .area()
            .x((i) => x(i))
            .y0((i) => y(b(i)))
            .y1((i) => y(Math.min(v(i), b(i)))),
        );
    }
  }

  budgetLine(svg, x, y, p, { focus = false, colour = null } = {}) {
    svg
      .append("path")
      .datum(this.range)
      .attr("fill", "none")
      .attr("class", colour ? null : "text-primary")
      .attr("stroke", colour || "currentColor")
      .attr("stroke-width", focus ? 1.5 : 1)
      .attr("stroke-dasharray", "6 4")
      .attr(
        "d",
        d3
          .line()
          .x((i) => x(i))
          .y((i) => y(this.budget(p, i))),
      );
  }

  lineColour(p) {
    return p.id === this.input.focus || this.o.colourAll ? p.color : null;
  }

  // A line in the category's colour, or recessive grey.
  styledPath(svg, p, data) {
    const colour = this.lineColour(p);
    return svg
      .append("path")
      .datum(data)
      .attr("fill", "none")
      .attr("class", colour ? null : "text-subdued")
      .attr("stroke", colour || "currentColor")
      .attr("stroke-opacity", colour ? 1 : 0.55);
  }

  actualLine(svg, x, y, p, width) {
    this.styledPath(
      svg,
      p,
      this.range.filter((i) => i < this.input.history),
    )
      .attr("stroke-width", width)
      .attr("stroke-linejoin", "round")
      .attr(
        "d",
        d3
          .line()
          .x((i) => x(i))
          .y((i) => y(p.actual[i])),
      )
      .style("cursor", "pointer")
      .on("click", () => this.input.onFocus(p.id));
  }

  fitLine(svg, x, y, p, value = (i) => this.fitted(p, i)) {
    this.styledPath(svg, p, this.range)
      .attr("stroke-width", 1.5)
      .attr("stroke-dasharray", "2 3")
      .attr("stroke-opacity", 0.75)
      .attr(
        "d",
        d3
          .line()
          .curve(d3.curveMonotoneX)
          .x((i) => x(i))
          .y((i) => y(value(i))),
      );
  }

  endLabels(svg, list, yOf, width, margin, text) {
    const labels = list
      .map((p) => ({ p, y: yOf(p) }))
      .filter((d) => Number.isFinite(d.y))
      .sort((a, b) => a.y - b.y);
    for (let k = 1; k < labels.length; k++)
      labels[k].y = Math.max(labels[k].y, labels[k - 1].y + 13);
    svg
      .append("g")
      .selectAll("text")
      .data(labels)
      .join("text")
      .attr("x", width - margin.right + 8)
      .attr("y", (d) => d.y + 4)
      .attr("font-size", 11.5)
      .attr("class", (d) =>
        d.p.id === this.input.focus
          ? "fill-current text-primary font-medium"
          : "fill-current text-secondary",
      )
      .style("cursor", "pointer")
      .on("click", (_, d) => this.input.onFocus(d.p.id))
      .text(text);
  }

  hoverLayer(svg, x, width, height, margin, list) {
    const { hover } = this.input;
    if (hover != null && this.range.includes(hover)) {
      svg
        .append("line")
        .attr("class", "text-subdued")
        .attr("x1", x(hover))
        .attr("x2", x(hover))
        .attr("y1", margin.top)
        .attr("y2", height - margin.bottom)
        .attr("stroke", "currentColor")
        .attr("stroke-dasharray", "2 3");
    }
    svg
      .append("rect")
      .attr("x", margin.left)
      .attr("y", margin.top)
      .attr("width", width - margin.left - margin.right)
      .attr("height", height - margin.top - margin.bottom)
      .attr("fill", "transparent")
      .on("pointermove", (event) => {
        const [mx] = d3.pointer(event);
        const idx = this.range;
        const i =
          idx[
            Math.max(
              0,
              Math.min(
                idx.length - 1,
                Math.round((mx - margin.left) / x.step()),
              ),
            )
          ];
        Tooltip.show(event, this.monthTable(i, list));
        if (i !== hover) this.input.onHover(i);
      })
      .on("pointerleave", () => {
        Tooltip.hide();
        this.input.onHover(null);
      });
  }

  monthTable(i, list) {
    const { money, history } = this.input;
    const future = i >= history;
    const cell = (text, cls = "") =>
      `<td class="pl-3 text-right tabular-nums ${cls}">${text}</td>`;
    const rows = list.map((p) => {
      const v = this.compared(p, i);
      const b = this.budget(p, i);
      let diff = "–";
      if (b != null) {
        diff = v > b ? `+${money.format(v - b)}` : `−${money.format(b - v)}`;
      }
      const diffClass =
        b == null
          ? "text-subdued"
          : v > b
            ? "text-destructive"
            : "text-success";
      const fit =
        this.o.fit === "off" && !future ? "" : money.format(this.fitted(p, i));
      return `<tr><td class="pr-2">${escapeHtml(p.name)}</td>${cell(future ? "" : money.format(v))}${cell(fit, "text-secondary")}${cell(b == null ? this.label("chart.no_budget") : money.format(b), "text-secondary")}${cell(diff, diffClass)}</tr>`;
    });
    let title = this.fmtMonth(this.input.months[i]);
    if (future) title += ` · ${this.label("chart.forecast")}`;
    else if (this.o.rolling) title += ` · ${this.label("chart.rolling_note")}`;
    const head = ["actual", "fitted", "budget", "vs_budget"]
      .map(
        (k) =>
          `<th class="pl-3 text-right font-normal text-subdued">${this.label(`chart.columns.${k}`)}</th>`,
      )
      .join("");
    return `<p class="font-medium mb-1">${title}</p><table class="w-full"><tr><th></th>${head}</tr>${rows.join("")}</table>`;
  }

  // --- A: lines ---

  drawLines(container) {
    const list = this.shown;
    const margin = { top: 14, right: 116, bottom: 26, left: 58 };
    const width = Math.max(320, container.clientWidth);
    const height = this.input.tall ? 560 : VIEW_HEIGHT.lines;
    const svg = this.svgIn(container, width, height);
    const x = this.xScale(width, margin);
    const idx = this.range;
    const max = d3.max(list, (p) =>
      d3.max(idx, (i) =>
        Math.max(
          this.compared(p, i) ?? 0,
          this.fitFor(p) ? this.fitted(p, i) : 0,
          this.shadeFor(p) || p.id === this.input.focus
            ? (this.budget(p, i) ?? 0)
            : 0,
        ),
      ),
    );
    const y = d3
      .scaleLinear()
      .domain([0, (max || 1) * 1.05])
      .nice()
      .range([height - margin.bottom, margin.top]);
    this.forecastBand(svg, x, width, height, margin);
    this.axes(svg, x, y, width, height, margin, (v) =>
      this.input.money.format(v),
    );
    const focus = list.find((p) => p.id === this.input.focus);
    if (focus) this.cycleLines(svg, x, height, margin, focus);
    this.hatch(svg, "planner-hatch");
    const ordered = [...list].sort((a) => (a.id === this.input.focus ? 1 : -1));
    for (const p of ordered) {
      if (this.shadeFor(p))
        this.budgetShading(
          svg,
          x,
          y,
          p,
          "planner-hatch",
          this.o.shade === "all" &&
            p.id !== this.input.focus &&
            !this.input.shaded?.has(p.id)
            ? 0.55
            : 1,
        );
    }
    for (const p of ordered) {
      const isFocus = p.id === this.input.focus;
      if (p.budget != null && (isFocus || this.shadeFor(p)))
        this.budgetLine(svg, x, y, p, {
          focus: isFocus,
          colour: isFocus ? null : this.lineColour(p),
        });
      if (this.fitFor(p)) this.fitLine(svg, x, y, p);
      this.actualLine(svg, x, y, p, isFocus ? 2.5 : 1.5);
    }
    const last = idx[idx.length - 1];
    this.endLabels(
      svg,
      list,
      (p) => y(this.compared(p, last)),
      width,
      margin,
      (d) => d.p.name,
    );
    this.hoverLayer(svg, x, width, height, margin, list);
  }

  // --- B: percent of budget ---

  drawPercent(container) {
    const list = this.shown.filter((p) => p.budget);
    if (!list.length)
      return this.empty(container, this.label("chart.no_budgeted"));
    const margin = { top: 14, right: 130, bottom: 26, left: 48 };
    const width = Math.max(320, container.clientWidth);
    const height = this.input.tall ? 520 : VIEW_HEIGHT.percent;
    const svg = this.svgIn(container, width, height);
    const x = this.xScale(width, margin);
    const idx = this.range;
    const ratio = (p, i, v = this.compared(p, i)) =>
      (v / this.budget(p, i)) * 100;
    const max = Math.max(
      150,
      d3.max(list, (p) => d3.max(idx, (i) => ratio(p, i))),
    );
    const y = d3
      .scaleLinear()
      .domain([0, max])
      .nice()
      .range([height - margin.bottom, margin.top]);
    this.forecastBand(svg, x, width, height, margin);
    svg
      .append("rect")
      .attr("class", "text-primary")
      .attr("x", margin.left)
      .attr("width", width - margin.left - margin.right)
      .attr("y", y(110))
      .attr("height", y(90) - y(110))
      .attr("fill", "currentColor")
      .attr("fill-opacity", 0.05);
    this.axes(svg, x, y, width, height, margin, (v) => `${v}%`);
    svg
      .append("line")
      .attr("class", "text-secondary")
      .attr("x1", margin.left)
      .attr("x2", width - margin.right)
      .attr("y1", y(100))
      .attr("y2", y(100))
      .attr("stroke", "currentColor")
      .attr("stroke-dasharray", "4 3");
    const focus = list.find((p) => p.id === this.input.focus);
    if (focus) this.cycleLines(svg, x, height, margin, focus);
    const ordered = [...list].sort((a) => (a.id === this.input.focus ? 1 : -1));
    for (const p of ordered) {
      if (this.fitFor(p))
        this.fitLine(svg, x, y, p, (i) => ratio(p, i, this.fitted(p, i)));
      this.styledPath(
        svg,
        p,
        idx.filter((i) => i < this.input.history),
      )
        .attr("stroke-width", p.id === this.input.focus ? 2.5 : 1.5)
        .attr(
          "d",
          d3
            .line()
            .x((i) => x(i))
            .y((i) => y(ratio(p, i))),
        )
        .style("cursor", "pointer")
        .on("click", () => this.input.onFocus(p.id));
    }
    const lastHist = Math.min(idx[idx.length - 1], this.input.history - 1);
    this.endLabels(
      svg,
      list,
      (p) => y(ratio(p, lastHist)),
      width,
      margin,
      (d) => `${d.p.name} ${Math.round(ratio(d.p, lastHist))}%`,
    );
    this.hoverLayer(svg, x, width, height, margin, list);
    if (this.shown.some((p) => p.budget == null)) {
      const note = document.createElement("p");
      note.className = "text-xs text-subdued mt-1";
      note.textContent = this.label("chart.unbudgeted_left_out");
      container.append(note);
    }
  }

  // --- C: one chart each ---

  drawMultiples(container) {
    const grid = document.createElement("div");
    grid.className = "grid gap-3";
    const size = MULTIPLE_SIZES[this.o.size] || MULTIPLE_SIZES.small;
    grid.style.gridTemplateColumns = size.column;
    container.append(grid);
    for (const p of this.shown) {
      const box = document.createElement("div");
      box.className =
        "border border-secondary rounded-lg px-2.5 pt-2 pb-1 min-w-0";
      const head = document.createElement("div");
      head.className = "flex items-baseline justify-between gap-2 text-sm";
      const name = document.createElement("button");
      name.type = "button";
      name.className = `font-medium truncate text-left ${p.id === this.input.focus ? "text-primary" : "text-secondary"}`;
      name.textContent = p.name;
      name.addEventListener("click", () => this.input.onFocus(p.id));
      const counts = this.overCount(p);
      const meta = document.createElement("span");
      meta.className = "text-xs text-subdued text-right shrink-0";
      const parts = [
        counts
          ? this.label("chart.over_count", counts)
          : this.label("chart.no_budget"),
      ];
      if (this.o.cycles && p.cycle)
        parts.push(this.label("chart.cycle_short", { months: p.cycle.length }));
      meta.textContent = parts.join(" · ");
      head.append(name, meta);
      const holder = document.createElement("div");
      box.append(head, holder);
      grid.append(box);

      const margin = { top: 8, right: 8, bottom: 20, left: 48 };
      const width = Math.max(200, holder.clientWidth);
      const height = this.input.tall ? size.height + 60 : size.height;
      const svg = this.svgIn(holder, width, height);
      const x = this.xScale(width, margin);
      const idx = this.range;
      // Each chart's scale spans its own values, not from zero, so the gap
      // between spending and budget is easy to see.
      const values = idx.flatMap((i) =>
        [
          this.compared(p, i),
          this.o.fit !== "off" ? this.fitted(p, i) : null,
          this.budget(p, i),
        ].filter((v) => v != null),
      );
      const [low, high] = d3.extent(values);
      const pad = (high - low) * 0.1 || high * 0.1 || 1;
      const y = d3
        .scaleLinear()
        .domain([Math.max(0, low - pad), high + pad])
        .nice()
        .range([height - margin.bottom, margin.top]);
      this.forecastBand(svg, x, width, height, margin);
      this.axes(
        svg,
        x,
        y,
        width,
        height,
        margin,
        (v) => this.input.money.format(v),
        true,
      );
      this.cycleLines(svg, x, height, margin, p);
      const hatchId = `planner-hatch-${p.id}`;
      this.hatch(svg, hatchId);
      if (p.budget != null && this.o.shade !== "off")
        this.budgetShading(svg, x, y, p, hatchId);
      if (p.budget != null) this.budgetLine(svg, x, y, p);
      if (this.o.fit !== "off") {
        svg
          .append("path")
          .datum(idx)
          .attr("fill", "none")
          .attr("class", "text-secondary")
          .attr("stroke", "currentColor")
          .attr("stroke-width", 1.5)
          .attr("stroke-dasharray", "2 3")
          .attr(
            "d",
            d3
              .line()
              .curve(d3.curveMonotoneX)
              .x((i) => x(i))
              .y((i) => y(this.fitted(p, i))),
          );
      }
      svg
        .append("path")
        .datum(idx.filter((i) => i < this.input.history))
        .attr("fill", "none")
        .attr("class", "text-primary")
        .attr("stroke", "currentColor")
        .attr("stroke-width", 1.75)
        .attr(
          "d",
          d3
            .line()
            .x((i) => x(i))
            .y((i) => y(p.actual[i])),
        );
      this.hoverLayer(svg, x, width, height, margin, [p]);
    }
  }

  // --- D: month grid ---

  drawGrid(container) {
    const list = this.shown;
    const idx = this.range;
    const { history } = this.input;
    const cell = 26;
    const margin = { top: 22, right: 76, bottom: 6, left: 132 };
    const width = Math.max(
      container.clientWidth,
      margin.left + margin.right + idx.length * 22,
    );
    const height = margin.top + margin.bottom + list.length * (cell + 2);
    const scroll = document.createElement("div");
    scroll.className = "overflow-x-auto";
    container.append(scroll);
    const svg = d3
      .select(scroll)
      .append("svg")
      .attr("viewBox", [0, 0, width, height])
      .attr("width", width)
      .attr("height", height);
    const cw = (width - margin.left - margin.right) / idx.length;
    const strength = d3
      .scaleLinear()
      .domain([0.05, 0.5])
      .range([0.3, 1])
      .clamp(true);
    const rel = (p, i) => this.compared(p, i) / this.budget(p, i) - 1;
    const nob = svg
      .append("defs")
      .append("pattern")
      .attr("id", "planner-nobudget")
      .attr("class", "text-subdued")
      .attr("width", 6)
      .attr("height", 6)
      .attr("patternUnits", "userSpaceOnUse")
      .attr("patternTransform", "rotate(45)");
    nob
      .append("line")
      .attr("y2", 6)
      .attr("stroke", "currentColor")
      .attr("stroke-opacity", 0.35)
      .attr("stroke-width", 2);

    list.forEach((p, row) => {
      const yy = margin.top + row * (cell + 2);
      svg
        .append("text")
        .attr("x", margin.left - 8)
        .attr("y", yy + cell / 2 + 4)
        .attr("text-anchor", "end")
        .attr("font-size", 12)
        .attr("class", "fill-current text-primary")
        .style("cursor", "pointer")
        .on("click", () => this.input.onFocus(p.id))
        .text(p.name);
      const cls = (i) => {
        if (p.budget == null) return null;
        const r = rel(p, i);
        if (Math.abs(r) <= 0.05) return "text-subdued";
        return r > 0 ? "text-destructive" : "text-success";
      };
      svg
        .append("g")
        .selectAll("rect")
        .data(idx)
        .join("rect")
        .attr("x", (_, k) => margin.left + k * cw + 1)
        .attr("y", yy)
        .attr("width", Math.max(2, cw - 2))
        .attr("height", cell)
        .attr("rx", 3)
        .attr("class", cls)
        .attr("fill", (i) =>
          p.budget == null ? "url(#planner-nobudget)" : "currentColor",
        )
        .attr("fill-opacity", (i) => {
          if (p.budget == null) return 1;
          const r = Math.abs(rel(p, i));
          const base = r <= 0.05 ? 0.18 : strength(r);
          return i >= history ? base * 0.45 : base;
        })
        .attr("stroke", (i) =>
          i === this.input.hover || i >= history ? "currentColor" : "none",
        )
        .attr("stroke-dasharray", (i) =>
          i >= history && i !== this.input.hover ? "2 2" : null,
        )
        .on("pointermove", (event, i) => {
          Tooltip.show(event, this.monthTable(i, [p]));
          if (i !== this.input.hover) this.input.onHover(i);
        })
        .on("pointerleave", () => {
          Tooltip.hide();
          this.input.onHover(null);
        });
      if (this.o.cycles && p.cycle) {
        const { length, start } = p.cycle;
        svg
          .append("g")
          .selectAll("line")
          .data(
            idx.filter((i) => (((i - start) % length) + length) % length === 0),
          )
          .join("line")
          .attr("class", "text-primary")
          .attr("x1", (i) => margin.left + idx.indexOf(i) * cw)
          .attr("x2", (i) => margin.left + idx.indexOf(i) * cw)
          .attr("y1", yy - 1)
          .attr("y2", yy + cell + 1)
          .attr("stroke", "currentColor")
          .attr("stroke-width", 1.5);
      }
      const counts = this.overCount(p);
      svg
        .append("text")
        .attr("x", width - margin.right + 8)
        .attr("y", yy + cell / 2 + 4)
        .attr("font-size", 11.5)
        .attr("class", "fill-current text-secondary")
        .text(counts ? `${counts.over} / ${counts.of}` : "–");
    });
    svg
      .append("g")
      .selectAll("text")
      .data(idx.filter((_, k) => k % Math.ceil(idx.length / 12) === 0))
      .join("text")
      .attr("x", (i) => margin.left + idx.indexOf(i) * cw + cw / 2)
      .attr("y", 14)
      .attr("text-anchor", "middle")
      .attr("font-size", 10)
      .attr("class", "fill-current text-subdued")
      .text((i) => this.fmtTick(this.input.months[i]));
  }
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

// One floating tooltip shared by every chart on the page.
const Tooltip = {
  el: null,
  show(event, html) {
    if (!this.el) {
      this.el = document.createElement("div");
      this.el.className =
        "fixed z-50 pointer-events-none bg-container text-primary text-xs rounded-lg shadow-border-xs p-2 max-w-[calc(100vw-2rem)]";
      this.el.setAttribute("role", "tooltip");
      document.body.append(this.el);
    }
    this.el.innerHTML = html;
    this.el.hidden = false;
    const pad = 14;
    const rect = this.el.getBoundingClientRect();
    let x = event.clientX + pad;
    let y = event.clientY + pad;
    if (x + rect.width > window.innerWidth - 8)
      x = event.clientX - rect.width - pad;
    if (y + rect.height > window.innerHeight - 8)
      y = event.clientY - rect.height - pad;
    this.el.style.left = `${Math.max(8, x)}px`;
    this.el.style.top = `${Math.max(8, y)}px`;
  },
  hide() {
    if (this.el) this.el.hidden = true;
  },
  remove() {
    this.el?.remove();
    this.el = null;
  },
};

export const plannerChartTooltip = Tooltip;
