import { memo } from "react";
import type { AggregateRow } from "../../../model/tokenUsageViewModel";
import { buildLineChartGeometry } from "../../../model/chartMath";
import { useI18n } from "../../../i18n/I18nContext";

type Props = { byDay: AggregateRow[] };

const CHART_WIDTH = 640;
const CHART_HEIGHT = 220;
const PADDING_X = 30;
const PADDING_Y = 24;

/**
 * Stacked daily token trend: input (bottom band), output (middle band), cache
 * read+creation (top band). Implemented as three solid, non-transparent areas
 * drawn largest-cumulative-first so each smaller cumulative area occludes the
 * layer beneath it, leaving only the difference visible as that layer's color —
 * the standard trick for a stacked area chart without a charting library.
 */
export const TokenTrendChart = memo(function TokenTrendChart({ byDay: allDays }: Props) {
  const { t, locale } = useI18n();
  const formatTokens = (value: number) => value.toLocaleString(locale);
  // `aggregateTokenUsage` sudeda įrašus be galiojančio `ts` po raktu „unknown", o jis
  // `localeCompare` rikiuotėje atsiduria PO visų `YYYY-MM-DD` raktų. Neišfiltruotas jis tapdavo
  // „naujausia diena": ašies etiketė virsdavo „wn", o visų nedatuotų įrašų tokenai susikraudavo
  // į vieną stulpelį dešinėje (2026-08-06 UI auditas). `computePeriodComparison` jį jau filtravo.
  const byDay = allDays.filter((row) => row.key !== "unknown");
  if (byDay.length === 0) {
    return (
      <div className="chart-panel">
        <h3>{t("Token usage over time")}</h3>
        <div className="chart-empty">{t("No data")}</div>
      </div>
    );
  }

  const visibleDays = byDay.slice(-30);
  const totalTokens = visibleDays.map((row) => row.totalTokens);
  const geometry = buildLineChartGeometry(totalTokens, {
    width: CHART_WIDTH,
    height: CHART_HEIGHT,
    paddingX: PADDING_X,
    paddingY: PADDING_Y,
  });
  const maxValue = Math.max(...totalTokens, 0) || 1;
  const baselineY = geometry.baselineY;
  const yFor = (value: number) => baselineY - (value / maxValue) * (baselineY - PADDING_Y);

  const firstDay = visibleDays[0].key;
  const lastDay = visibleDays[visibleDays.length - 1].key;
  const grandTotal = totalTokens.reduce((sum, value) => sum + value, 0);
  const average = grandTotal / visibleDays.length;
  const averageY = yFor(average);
  const step = visibleDays.length > 1 ? geometry.points[1].x - geometry.points[0].x : 42;
  const barWidth = Math.max(5, Math.min(22, step * 0.68));
  const ticks = [maxValue, maxValue / 2, 0];

  return (
    <div className="chart-panel">
      <div className="chart-heading">
        <div>
          <h3>{t("Token usage over time")}</h3>
          <p>{t("Daily tokens: input · output · cache")}</p>
        </div>
        <div className="trend-headline">
          <strong>{new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 }).format(grandTotal)}</strong>
          <span>{visibleDays.length} {t("days")} · Ø {new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 }).format(average)}</span>
        </div>
      </div>
      <div className="chart-legend">
        <span><i style={{ background: "var(--accent)" }} /> {t("Input")}</span>
        <span><i style={{ background: "var(--accent-2)" }} /> {t("Output")}</span>
        <span><i style={{ background: "var(--warning)" }} /> {t("Cache")}</span>
        <span><i className="legend-average" /> {t("Daily average")}</span>
      </div>
      <svg
        viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
        style={{ width: "100%", height: "auto" }}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label={t("Token usage over time")}
      >
        {ticks.map((tick, index) => {
          const y = PADDING_Y + (index * (baselineY - PADDING_Y)) / (ticks.length - 1);
          return (
            <g key={index}>
              <line x1={PADDING_X} y1={y} x2={CHART_WIDTH - PADDING_X} y2={y} stroke="var(--border)" />
              <text x={PADDING_X + 4} y={Math.max(12, y - 5)} fill="var(--faint)" fontSize={10}>
                {formatTokens(Math.round(tick))}
              </text>
            </g>
          );
        })}
        <line x1={PADDING_X} y1={averageY} x2={CHART_WIDTH - PADDING_X} y2={averageY} stroke="var(--text-strong)" strokeDasharray="5 4" opacity=".65" />
        {visibleDays.map((row, index) => {
          const x = geometry.points[index].x - barWidth / 2;
          const cacheTokens = row.cacheReadTokens + row.cacheCreationTokens;
          const inputHeight = baselineY - yFor(row.inputTokens);
          const outputHeight = baselineY - yFor(row.outputTokens);
          const cacheHeight = baselineY - yFor(cacheTokens);
          return (
            <g key={row.key}>
              <rect x={x} y={baselineY - inputHeight} width={barWidth} height={inputHeight} fill="var(--accent)" />
              <rect x={x} y={baselineY - inputHeight - outputHeight} width={barWidth} height={outputHeight} fill="var(--accent-2)" />
              <rect x={x} y={baselineY - inputHeight - outputHeight - cacheHeight} width={barWidth} height={cacheHeight} fill="var(--warning)" rx={2}>
                <title>{`${row.key}: ${formatTokens(row.totalTokens)} ${t("tokens")} (${t("Input")} ${formatTokens(row.inputTokens)}, ${t("Output")} ${formatTokens(row.outputTokens)}, ${t("Cache")} ${formatTokens(cacheTokens)})`}</title>
              </rect>
            </g>
          );
        })}
        <text x={PADDING_X} y={CHART_HEIGHT - 4} fill="var(--faint)" fontSize={11}>
          {firstDay.slice(5)}
        </text>
        <text x={CHART_WIDTH - PADDING_X} y={CHART_HEIGHT - 4} fill="var(--faint)" fontSize={11} textAnchor="end">
          {lastDay.slice(5)}
        </text>
      </svg>
      {byDay.length > visibleDays.length && (
        <p className="chart-limit-note">{t("Showing the latest 30 days; use the period filter to inspect another window.")}</p>
      )}
    </div>
  );
});
