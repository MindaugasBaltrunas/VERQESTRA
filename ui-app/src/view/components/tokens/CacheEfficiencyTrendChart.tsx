import { memo } from "react";
import type { TokenAnalyticsSnapshot } from "../../../model/types";
import { useI18n } from "../../../i18n/I18nContext";
import { buildLineChartGeometry } from "../../../model/chartMath";

type Props = { history: TokenAnalyticsSnapshot[] };

const CHART_WIDTH = 640;
const CHART_HEIGHT = 200;
const PADDING_X = 30;
const PADDING_Y = 24;

/**
 * Cache hit rate at each accumulated snapshot (one point per completed task run,
 * see similar-task-analytics.ts) — shows whether cache reuse is trending up or
 * down as the project accumulates more runs, not just the current filter window.
 */
export const CacheEfficiencyTrendChart = memo(function CacheEfficiencyTrendChart({ history }: Props) {
  const { t, locale } = useI18n();
  const formatPercent = (value: number) =>
    new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 1 }).format(value);
  const formatTimestamp = (value: string) =>
    new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short" }).format(new Date(value));
  if (history.length === 0) {
    return (
      <div className="chart-panel">
        <h3>{t("Cache efficiency over time")}</h3>
        <div className="chart-empty">{t("No historical snapshots")}</div>
      </div>
    );
  }

  const rates = history.map((snapshot) => snapshot.cacheHitRate);
  const geometry = buildLineChartGeometry(rates, {
    width: CHART_WIDTH,
    height: CHART_HEIGHT,
    paddingX: PADDING_X,
    paddingY: PADDING_Y,
  });
  const baselineY = geometry.baselineY;
  // Fixed 0–1 scale (it's a rate), not `geometry`'s data-max scale — only the x
  // layout is borrowed from `geometry.points`, matching CostOverTimeChart's pattern.
  const yFor = (value: number) => baselineY - value * (baselineY - PADDING_Y);
  const linePath = `M ${rates.map((value, index) => `${geometry.points[index].x},${yFor(value)}`).join(" L ")}`;
  const ticks = [1, 0.5, 0];
  const latest = rates[rates.length - 1];
  const first = rates[0];
  const delta = latest - first;
  const areaPath = `${linePath} L ${geometry.points.at(-1)!.x},${baselineY} L ${geometry.points[0].x},${baselineY} Z`;

  return (
    <div className="chart-panel">
      <div className="chart-heading">
        <div>
          <h3>{t("Cache efficiency over time")}</h3>
          <p>{t("Cache hit rate across accumulated snapshots")} ({history.length})</p>
        </div>
        <div className="trend-headline">
          <strong>{formatPercent(latest)}</strong>
          <span className={delta >= 0 ? "positive" : "negative"}>
            {delta >= 0 ? "↗" : "↘"} {formatPercent(Math.abs(delta))}
          </span>
        </div>
      </div>
      <svg
        viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
        style={{ width: "100%", height: "auto" }}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label={t("Cache efficiency over time")}
      >
        <defs>
          <linearGradient id="cache-area-gradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity=".28" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity=".02" />
          </linearGradient>
        </defs>
        {ticks.map((tick, index) => {
          const y = PADDING_Y + (index * (baselineY - PADDING_Y)) / (ticks.length - 1);
          return (
            <g key={index}>
              <line x1={PADDING_X} y1={y} x2={CHART_WIDTH - PADDING_X} y2={y} stroke="var(--border)" />
              <text x={PADDING_X + 4} y={Math.max(12, y - 5)} fill="var(--faint)" fontSize={10}>
                {formatPercent(tick)}
              </text>
            </g>
          );
        })}
        <path d={areaPath} fill="url(#cache-area-gradient)" />
        <path d={linePath} fill="none" stroke="var(--accent-strong)" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" />
        {history.map((snapshot, index) => (
          <circle
            key={`${snapshot.generatedAt}-${index}`}
            cx={geometry.points[index].x}
            cy={yFor(rates[index])}
            r={4}
            fill="var(--surface)"
            stroke="var(--accent-strong)"
            strokeWidth={1.5}
          >
            <title>{`${formatTimestamp(snapshot.generatedAt)}: ${formatPercent(rates[index])}`}</title>
          </circle>
        ))}
      </svg>
      <div className="trend-chart-footer">
        <span>{formatTimestamp(history[0].generatedAt)}</span>
        <span>{t("Change since first snapshot")}: <strong>{delta >= 0 ? "+" : "−"}{formatPercent(Math.abs(delta))}</strong></span>
        <span>{formatTimestamp(history.at(-1)!.generatedAt)}</span>
      </div>
    </div>
  );
});
