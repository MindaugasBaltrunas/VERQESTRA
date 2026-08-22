export type ChartPoint = { x: number; y: number };

export type LineChartGeometry = {
  points: ChartPoint[];
  linePath: string;
  areaPath: string;
  baselineY: number;
};

export type LineChartConfig = {
  width: number;
  height: number;
  paddingX: number;
  paddingY: number;
};

export function buildLineChartGeometry(values: number[], config: LineChartConfig): LineChartGeometry {
  const { width, height, paddingX, paddingY } = config;
  const baselineY = height - paddingY;
  const maxValue = Math.max(...values, 0) || 1;

  const points: ChartPoint[] = values.map((value, index) => {
    const x =
      values.length <= 1
        ? width / 2
        : paddingX + (index * (width - 2 * paddingX)) / (values.length - 1);
    const y = baselineY - (value / maxValue) * (baselineY - paddingY);
    return { x, y };
  });

  const linePath = points.map((p) => `${p.x},${p.y}`).join(" L ");
  const firstX = points[0]?.x ?? paddingX;
  const lastX = points[points.length - 1]?.x ?? paddingX;
  const areaPath =
    points.length === 0
      ? ""
      : `M ${points.map((p) => `${p.x},${p.y}`).join(" L ")} L ${lastX},${baselineY} L ${firstX},${baselineY} Z`;

  return {
    points,
    linePath: points.length === 0 ? "" : `M ${linePath}`,
    areaPath,
    baselineY,
  };
}

export function toBarWidthPercent(value: number, max: number): number {
  // NaN/Infinity iš analitikos atsakymo anksčiau nueidavo tiesiai į `style={{ width: "NaN%" }}`
  // ir juosta tiesiog nebūdavo atvaizduojama — be jokio pranešimo, kad duomenys sugadinti.
  if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0) return 0;
  const percent = (value / max) * 100;
  return Math.min(100, Math.max(0, percent));
}

export type DonutSegment = {
  key: string;
  value: number;
  share: number;
  /** SVG `stroke-dasharray`: "<segment length> <remaining circumference>". */
  dashArray: string;
  /** SVG `stroke-dashoffset`: negative cumulative length of prior segments. */
  dashOffset: number;
};

/**
 * Lays out `rows` as consecutive arcs of a ring built from stacked `<circle>`
 * strokes (the standard dasharray/dashoffset donut-chart trick) — avoids pulling
 * in a charting library or hand-rolling arc path math for pie slices.
 */
export function buildDonutSegments(rows: Array<{ key: string; value: number }>, circumference: number): DonutSegment[] {
  const total = rows.reduce((sum, row) => sum + row.value, 0);
  let cumulative = 0;
  const segments: DonutSegment[] = [];
  for (const row of rows) {
    const share = total > 0 ? row.value / total : 0;
    const length = share * circumference;
    segments.push({
      key: row.key,
      value: row.value,
      share,
      dashArray: `${length} ${circumference - length}`,
      dashOffset: -cumulative,
    });
    cumulative += length;
  }
  return segments;
}
