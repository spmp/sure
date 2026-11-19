import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  budgetAt,
  detectCycle,
  fitSpending,
  rolling,
} from "../../app/javascript/utils/spending_models.mjs"

const close = (actual, expected, tolerance = 1e-6) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} is not within ${tolerance} of ${expected}`)

// Months numbered from January, so index i is calendar month i % 12.
const monthOf = (i) => i % 12

describe("fitSpending trend", () => {
  it("recovers a straight line", () => {
    const series = Array.from({ length: 12 }, (_, i) => 100 + 5 * i)
    const model = fitSpending(series, monthOf)

    close(model.slope, 5)
    close(model.at(20, "trend"), 200)
  })

  it("isn't pulled by a one-off month", () => {
    const series = Array.from({ length: 24 }, () => 100)
    series[3] = 5000

    const model = fitSpending(series, monthOf)

    close(model.slope, 0)
    close(model.at(30, "trend"), 100)
  })

  it("never goes below zero", () => {
    const series = Array.from({ length: 12 }, (_, i) => 120 - 10 * i)

    assert.equal(fitSpending(series, monthOf).at(40, "trend"), 0)
  })
})

describe("fitSpending yearly pattern", () => {
  const yearly = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 300, 600]

  it("learns each calendar month's difference from the trend", () => {
    const series = Array.from({ length: 36 }, (_, i) => 1000 + yearly[monthOf(i)])
    const model = fitSpending(series, monthOf)

    assert.ok(model.hasYearly)
    close(model.at(47, "yearly") - model.at(46, "yearly"), 300, 60)
    assert.ok(model.at(47, "yearly") > model.at(45, "yearly") + 400)
  })

  it("isn't fooled by one unusual month", () => {
    const series = Array.from({ length: 36 }, () => 1000)
    series[10] = 9000

    const model = fitSpending(series, monthOf)

    close(model.at(46, "yearly"), model.at(45, "yearly"), 1)
  })

  it("needs two years of history; with less it is the trend", () => {
    const series = Array.from({ length: 18 }, (_, i) => 1000 + yearly[monthOf(i)])
    const model = fitSpending(series, monthOf)

    assert.equal(model.hasYearly, false)
    assert.equal(model.at(23, "yearly"), model.at(23, "trend"))
  })
})

describe("detectCycle", () => {
  it("finds a repeating pattern and where it starts", () => {
    const shape = [50, 400, 200, 100]
    const series = Array.from({ length: 24 }, (_, i) => 500 + shape[i % 4])

    const cycle = detectCycle(series)

    assert.equal(cycle.length, 4)
    assert.equal(cycle.start % 4, 0, "cycles start at the low point")
  })

  it("finds nothing in steady or steadily growing spending", () => {
    assert.equal(detectCycle(Array.from({ length: 24 }, () => 300)), null)
    assert.equal(detectCycle(Array.from({ length: 24 }, (_, i) => 300 + 10 * i)), null)
  })

  it("needs at least two full cycles", () => {
    const shape = [0, 500, 0, 0, 0, 0, 0]
    assert.equal(detectCycle(Array.from({ length: 10 }, (_, i) => shape[i % 7])), null)
  })
})

describe("rolling", () => {
  it("averages each month with up to two before it", () => {
    assert.deepEqual(rolling([1, 2, 3, 4], 3), [1, 1.5, 2, 3])
  })
})

describe("budgetAt", () => {
  it("is the base amount at the anchor month", () => {
    assert.equal(budgetAt({ base: 100, anchor: 10, growth: 12, compound: true }, 10), 100)
  })

  it("grows by the yearly rate, compounding or not", () => {
    close(budgetAt({ base: 100, anchor: 0, growth: 10, compound: true }, 24), 121)
    close(budgetAt({ base: 100, anchor: 0, growth: 10, compound: false }, 24), 120)
  })

  it("shrinks going back before the anchor", () => {
    close(budgetAt({ base: 121, anchor: 24, growth: 10, compound: true }, 0), 100)
  })
})
