import { describe, expect, it } from "vitest";
import { countUpValue } from "./countUp";

describe("countUpValue", () => {
  it("starts exactly at the previous value", () => {
    expect(countUpValue(10, 42, 0, 420)).toBe(10);
  });

  it("lands exactly on the target, without a rounding tail", () => {
    // Ne „beveik 42": animacijos pabaigoje ekrane privalo likti PATS skaičius.
    expect(countUpValue(10, 42, 420, 420)).toBe(42);
    expect(countUpValue(10, 42, 10_000, 420)).toBe(42);
  });

  it("skips the animation when there is no time to animate", () => {
    expect(countUpValue(10, 42, 0, 0)).toBe(42);
    expect(countUpValue(10, 42, 100, -1)).toBe(42);
  });

  it("moves only forward between the two ends", () => {
    const samples = [0, 40, 80, 120, 160, 200, 240, 280, 320, 360, 400, 420].map((elapsed) =>
      countUpValue(10, 42, elapsed, 420),
    );

    for (let index = 1; index < samples.length; index += 1) {
      expect(samples[index]).toBeGreaterThanOrEqual(samples[index - 1]);
    }
    expect(samples[0]).toBe(10);
    expect(samples[samples.length - 1]).toBe(42);
    for (const sample of samples) {
      expect(Number.isFinite(sample)).toBe(true);
      expect(sample).toBeGreaterThanOrEqual(10);
      expect(sample).toBeLessThanOrEqual(42);
    }
  });

  it("counts down just as monotonically", () => {
    const first = countUpValue(42, 10, 100, 420);
    const second = countUpValue(42, 10, 300, 420);

    expect(first).toBeLessThanOrEqual(42);
    expect(second).toBeLessThanOrEqual(first);
    expect(second).toBeGreaterThanOrEqual(10);
  });

  it("never turns a broken input into NaN on the screen", () => {
    expect(countUpValue(Number.NaN, 42, 100, 420)).toBe(42);
    expect(countUpValue(10, 42, Number.NaN, 420)).toBe(42);
    expect(countUpValue(10, 42, 100, Number.NaN)).toBe(42);
    expect(countUpValue(Number.POSITIVE_INFINITY, 42, 100, 420)).toBe(42);
    expect(countUpValue(10, 42, Number.POSITIVE_INFINITY, 420)).toBe(42);
  });

  it("never leaves the range when the elapsed time is negative", () => {
    expect(countUpValue(10, 42, -500, 420)).toBe(10);
  });
});
