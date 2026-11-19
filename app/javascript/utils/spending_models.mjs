// Simple models of a category's monthly spending, for the budget planner's
// chart. They are deliberately robust to one-off months (a car repair, an
// annual insurance bill): medians rather than means throughout, so one
// unusual month doesn't become a trend or a "yearly" pattern.

const median = (values) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

const mean = (values) => values.reduce((sum, v) => sum + v, 0) / (values.length || 1);

// Theil–Sen line: the median of the slopes between every pair of months,
// and the median intercept for that slope.
function robustLine(series) {
  const slopes = [];
  for (let i = 0; i < series.length; i++) {
    for (let j = i + 1; j < series.length; j++) {
      slopes.push((series[j] - series[i]) / (j - i));
    }
  }
  const slope = median(slopes);
  const intercept = median(series.map((v, i) => v - slope * i));
  return { slope, intercept };
}

const YEARLY_MIN_MONTHS = 24;

// Fits a trend line and, with at least two years of history, a yearly
// pattern: each calendar month's typical difference from the trend.
// `monthOf(i)` gives the calendar month (0–11) of index i.
//
// Returns { slope, hasYearly, at(i, mode) } where mode is "trend" or
// "yearly" (trend plus the pattern). Indexes past the history forecast.
export function fitSpending(series, monthOf) {
  const { slope, intercept } = robustLine(series);
  const trend = (i) => intercept + slope * i;
  const hasYearly = series.length >= YEARLY_MIN_MONTHS;

  let offsets = new Array(12).fill(0);
  if (hasYearly) {
    const residuals = Array.from({ length: 12 }, () => []);
    series.forEach((v, i) => residuals[monthOf(i)].push(v - trend(i)));
    offsets = residuals.map((values) => (values.length ? median(values) : 0));
    const centre = mean(offsets);
    offsets = offsets.map((v) => v - centre);
  }

  return {
    slope,
    hasYearly,
    at(i, mode = "trend") {
      const value = mode === "yearly" && hasYearly ? trend(i) + offsets[monthOf(i)] : trend(i);
      return Math.max(0, value);
    },
  };
}

const CYCLE_MIN_STRENGTH = 0.3;

// Looks for spending that repeats every 2–12 months, once the trend is
// removed and outliers are tamed. Needs two full cycles of history.
// Returns { length, start, strength } — `start` is an index where a cycle
// begins (its low point) — or null when nothing repeats clearly.
export function detectCycle(series) {
  const { slope, intercept } = robustLine(series);
  let residuals = series.map((v, i) => v - (intercept + slope * i));
  const centre = median(residuals);
  const spread = median(residuals.map((r) => Math.abs(r - centre)));
  if (spread > 0) {
    const limit = 3 * spread;
    residuals = residuals.map((r) => Math.min(centre + limit, Math.max(centre - limit, r)));
  }
  const level = mean(residuals);
  residuals = residuals.map((r) => r - level);
  const variance = residuals.reduce((sum, r) => sum + r * r, 0);
  if (variance < 1e-9) return null;

  let best = null;
  for (let length = 2; length <= 12 && length * 2 <= series.length; length++) {
    let sum = 0;
    for (let i = length; i < residuals.length; i++) sum += residuals[i] * residuals[i - length];
    const strength = sum / variance;
    if (!best || strength > best.strength) best = { length, strength };
  }
  if (!best || best.strength < CYCLE_MIN_STRENGTH) return null;

  const byPhase = Array.from({ length: best.length }, (_, k) =>
    mean(residuals.filter((_, i) => i % best.length === k)),
  );
  const start = byPhase.indexOf(Math.min(...byPhase));
  return { length: best.length, start, strength: best.strength };
}

// Each month averaged with up to `size - 1` months before it.
export function rolling(series, size = 3) {
  return series.map((_, i) => mean(series.slice(Math.max(0, i - size + 1), i + 1)));
}

// A budget of `base` in month `anchor`, growing by `growth` percent a year
// before and after it, compounding or in a straight line.
export function budgetAt({ base, anchor, growth, compound }, i) {
  const years = (i - anchor) / 12;
  const rate = growth / 100;
  return compound ? base * (1 + rate) ** years : base * (1 + rate * years);
}
