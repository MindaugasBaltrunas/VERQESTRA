import { describe, expect, it } from "vitest";
import { formatAge, formatElapsed, formatEtaRange, formatPercentLabel } from "../../model/slotProgressFormat";

describe("formatAge", () => {
  it("shows a dash instead of a number that does not exist", () => {
    expect(formatAge(null)).toBe("—");
    expect(formatAge(-1)).toBe("—");
    expect(formatAge(Number.NaN)).toBe("—");
    expect(formatAge(Number.POSITIVE_INFINITY)).toBe("—");
  });

  it("switches unit at a minute and at an hour", () => {
    expect(formatAge(0)).toBe("0s");
    expect(formatAge(59_999)).toBe("59s");
    expect(formatAge(60_000)).toBe("1m");
    expect(formatAge(3_599_999)).toBe("59m");
    expect(formatAge(3_600_000)).toBe("1h");
    expect(formatAge(7_200_000)).toBe("2h");
  });
});

describe("formatElapsed", () => {
  it("shows a dash instead of a number that does not exist", () => {
    expect(formatElapsed(null)).toBe("—");
    expect(formatElapsed(-1)).toBe("—");
    expect(formatElapsed(Number.NaN)).toBe("—");
    expect(formatElapsed(Number.POSITIVE_INFINITY)).toBe("—");
  });

  it("keeps the finer part, because 4m and 4m 55s are different facts for a running attempt", () => {
    expect(formatElapsed(0)).toBe("0s");
    expect(formatElapsed(59_999)).toBe("59s");
    expect(formatElapsed(60_000)).toBe("1m");
    expect(formatElapsed(295_000)).toBe("4m 55s");
    expect(formatElapsed(3_600_000)).toBe("1h");
    expect(formatElapsed(5_400_000)).toBe("1h 30m");
  });
});

describe("formatEtaRange", () => {
  it("shows a dash for an unusable range", () => {
    expect(formatEtaRange(Number.NaN, 60_000)).toBe("—");
    expect(formatEtaRange(60_000, Number.POSITIVE_INFINITY)).toBe("—");
    expect(formatEtaRange(-1, 60_000)).toBe("—");
  });

  it("puts both ends in the unit of the larger one", () => {
    expect(formatEtaRange(240_000, 420_000)).toBe("4–7m");
    expect(formatEtaRange(20_000, 45_000)).toBe("20–45s");
    expect(formatEtaRange(3_600_000, 10_800_000)).toBe("1–3h");
  });

  it("collapses to a single value when both ends round to the same number", () => {
    // „4–4m" nieko nepasako, todėl rodoma viena reikšmė.
    expect(formatEtaRange(240_000, 250_000)).toBe("4m");
  });

  it("accepts an inverted range instead of printing it backwards", () => {
    expect(formatEtaRange(420_000, 240_000)).toBe("4–7m");
  });
});

describe("formatPercentLabel", () => {
  it("rounds and never prints NaN", () => {
    expect(formatPercentLabel(42.4)).toBe("42%");
    expect(formatPercentLabel(0)).toBe("0%");
    expect(formatPercentLabel(Number.NaN)).toBe("—");
    expect(formatPercentLabel(Number.POSITIVE_INFINITY)).toBe("—");
  });
});
