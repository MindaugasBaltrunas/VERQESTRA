import { describe, expect, it } from "vitest";
import { buildDonutSegments, buildLineChartGeometry, toBarWidthPercent } from "./chartMath";

describe("toBarWidthPercent", () => {
  it("returns 0 when max is 0", () => {
    expect(toBarWidthPercent(5, 0)).toBe(0);
  });

  it("returns 0 when max is negative", () => {
    expect(toBarWidthPercent(5, -10)).toBe(0);
  });

  it("returns 100 when value equals max", () => {
    expect(toBarWidthPercent(10, 10)).toBe(100);
  });

  it("clamps values above max to 100", () => {
    expect(toBarWidthPercent(50, 10)).toBe(100);
  });

  it("clamps negative values to 0", () => {
    expect(toBarWidthPercent(-5, 10)).toBe(0);
  });

  it("computes a proportional percentage within range", () => {
    expect(toBarWidthPercent(5, 10)).toBe(50);
  });
});

describe("buildLineChartGeometry", () => {
  const config = { width: 640, height: 220, paddingX: 20, paddingY: 20 };

  it("centers a single value", () => {
    const geometry = buildLineChartGeometry([42], config);
    expect(geometry.points).toHaveLength(1);
    expect(geometry.points[0].x).toBe(config.width / 2);
  });

  it("does not divide by zero when all values are zero", () => {
    const geometry = buildLineChartGeometry([0, 0, 0], config);
    expect(geometry.points.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))).toBe(true);
    // All-zero values should sit on the baseline.
    expect(geometry.points.every((p) => p.y === geometry.baselineY)).toBe(true);
  });

  it("spaces N points evenly across the width", () => {
    const geometry = buildLineChartGeometry([1, 2, 3, 4], config);
    expect(geometry.points).toHaveLength(4);
    expect(geometry.points[0].x).toBe(config.paddingX);
    expect(geometry.points[3].x).toBe(config.width - config.paddingX);
    const gap1 = geometry.points[1].x - geometry.points[0].x;
    const gap2 = geometry.points[2].x - geometry.points[1].x;
    expect(gap1).toBeCloseTo(gap2);
  });

  it("produces paths starting with 'M '", () => {
    const geometry = buildLineChartGeometry([1, 2, 3], config);
    expect(geometry.linePath.startsWith("M ")).toBe(true);
    expect(geometry.areaPath.startsWith("M ")).toBe(true);
  });

  it("returns empty geometry paths for no values", () => {
    const geometry = buildLineChartGeometry([], config);
    expect(geometry.points).toHaveLength(0);
    expect(geometry.linePath).toBe("");
    expect(geometry.areaPath).toBe("");
  });
});

describe("buildDonutSegments", () => {
  const circumference = 100;

  it("splits the circumference proportionally to each row's share", () => {
    const segments = buildDonutSegments(
      [
        { key: "a", value: 75 },
        { key: "b", value: 25 },
      ],
      circumference,
    );
    expect(segments[0].share).toBeCloseTo(0.75);
    expect(segments[0].dashArray).toBe("75 25");
    expect(segments[0].dashOffset).toBe(-0);
    expect(segments[1].share).toBeCloseTo(0.25);
    expect(segments[1].dashArray).toBe("25 75");
    // The second segment starts where the first one ended.
    expect(segments[1].dashOffset).toBe(-75);
  });

  it("returns a zero share for every row when the total is 0", () => {
    const segments = buildDonutSegments(
      [
        { key: "a", value: 0 },
        { key: "b", value: 0 },
      ],
      circumference,
    );
    expect(segments.every((segment) => segment.share === 0)).toBe(true);
  });

  it("returns an empty array for no rows", () => {
    expect(buildDonutSegments([], circumference)).toEqual([]);
  });
});
