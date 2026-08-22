import assert from "node:assert/strict";
import test from "node:test";

import type { UnmeasuredCause } from "../domain/metrics/metric-value.js";
import { isMeasured, measure, totalOf, unmeasured } from "../domain/metrics/metric-value.js";

/**
 * Unit tests for the metric value itself (BENCH-7).
 *
 * The aggregate reaches most of these branches, but not all of them: a negative
 * denominator and an infinite term cannot be produced from samples, and they are
 * exactly the inputs that would turn a report into a number nobody can read. The
 * type is the package's single guarantee that an absent measurement is
 * `undefined` and never `0`, `NaN` or `Infinity`, so it is asserted directly.
 */

const CAUSE: UnmeasuredCause = {
  reason: "no-samples",
  detail: "no sample was recorded for this population",
};

test("a positive denominator yields the quotient and the counts it came from", () => {
  const metric = measure(3, 4, CAUSE);
  assert.ok(isMeasured(metric));
  assert.equal(metric.value, 0.75);
  assert.deepEqual(
    { numerator: metric.numerator, denominator: metric.denominator },
    { numerator: 3, denominator: 4 },
  );
});

test("an empty denominator yields the cause the caller stated, not a number", () => {
  const metric = measure(0, 0, CAUSE);
  assert.equal(metric.value, undefined);
  assert.ok(!isMeasured(metric));
  if (metric.value === undefined) {
    assert.equal(metric.reason, "no-samples");
    assert.equal(metric.detail, CAUSE.detail);
  }
  assert.equal(metric.denominator, 0);
});

test("a negative denominator is refused rather than divided by", () => {
  // Unreachable from a validated sample, and a sign error upstream would
  // otherwise be published as a negative rate that reads like a measurement.
  const metric = measure(1, -2, CAUSE);
  assert.equal(metric.value, undefined);
});

test("a zero numerator over a real denominator is a measured zero", () => {
  // The distinction the whole type exists for: nothing failed is a measurement,
  // nothing was checked is not.
  const metric = measure(0, 5, CAUSE);
  assert.ok(isMeasured(metric));
  assert.equal(metric.value, 0);
});

test("counts arithmetic cannot be trusted on are refused whichever side they arrive from", () => {
  for (const [numerator, denominator] of [
    [Number.NaN, 2],
    [1.5, 2],
    [Number.POSITIVE_INFINITY, 2],
    [1, 2.5],
    [1, Number.MAX_SAFE_INTEGER + 2],
  ] as const) {
    const metric = measure(numerator, denominator, CAUSE);
    assert.equal(metric.value, undefined, `${numerator}/${denominator} was reported as a value`);
    if (metric.value === undefined) {
      assert.equal(metric.reason, "unreliable-total");
    }
  }
});

test("an unusable total outranks the empty denominator the caller described", () => {
  const metric = measure(Number.NaN, 0, CAUSE);
  assert.equal(metric.value, undefined);
  if (metric.value === undefined) assert.equal(metric.reason, "unreliable-total");
});

test("an explicitly unmeasured value keeps the counts it was refused on", () => {
  const metric = unmeasured(CAUSE, { numerator: 7, denominator: 0 });
  assert.equal(metric.value, undefined);
  assert.equal(metric.numerator, 7);
  assert.equal(metric.reason, "no-samples");
});

test("an empty total is zero, so an empty population divides cleanly", () => {
  assert.equal(totalOf([]), 0);
});

test("a total sums exact integers in any order to the same number", () => {
  assert.equal(totalOf([1, 2, 3]), 6);
  assert.equal(totalOf([3, 1, 2]), 6);
  assert.equal(totalOf([0, -0]), 0);
});

test("a term that is not an exact integer poisons the total instead of rounding into it", () => {
  for (const values of [[0.5, 0.5], [Number.NaN], [Number.POSITIVE_INFINITY, 1], [-1.25, 1.25]]) {
    assert.ok(Number.isNaN(totalOf(values)), `${values.join(", ")} produced a usable total`);
  }
});

test("a total that leaves the exact integer range is refused by the metric it feeds", () => {
  const total = totalOf([Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]);
  const metric = measure(total, 2, CAUSE);
  assert.equal(metric.value, undefined);
  if (metric.value === undefined) assert.equal(metric.reason, "unreliable-total");
});
