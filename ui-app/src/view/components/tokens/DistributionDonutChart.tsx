import { memo } from "react";
import type { TokenAnalyticsBucket } from "../../../model/types";
import { buildDonutSegments } from "../../../model/chartMath";
import { useI18n } from "../../../i18n/I18nContext";

type Props = {
  title: string;
  description: string;
  rows: TokenAnalyticsBucket[];
};

const RADIUS = 60;
const STROKE_WIDTH = 22;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
const COLORS = ["var(--accent)", "var(--accent-2)", "var(--warning)", "var(--good)", "var(--faint)"];

export const DistributionDonutChart = memo(function DistributionDonutChart({ title, description, rows }: Props) {
  const { t, locale } = useI18n();
  const formatTokens = (value: number) => value.toLocaleString(locale);
  const formatPercent = (value: number) =>
    new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 1 }).format(value);
  const visibleRows = rows.filter((row) => row.totalTokens > 0).sort((a, b) => b.totalTokens - a.totalTokens);

  if (visibleRows.length === 0) {
    return (
      <div className="chart-panel">
        <h3>{title}</h3>
        <div className="chart-empty">{t("No data")}</div>
      </div>
    );
  }

  const segments = buildDonutSegments(
    visibleRows.map((row) => ({ key: row.key, value: row.totalTokens })),
    CIRCUMFERENCE,
  );
  const total = visibleRows.reduce((sum, row) => sum + row.totalTokens, 0);

  return (
    <div className="chart-panel">
      <div className="chart-heading">
        <div>
          <h3>{title}</h3>
          <p>{description}</p>
        </div>
      </div>
      <div className="donut-chart-body">
        <svg className="production-donut" viewBox="0 0 168 168" role="img" aria-label={`${title}: ${formatTokens(total)} ${t("tokens")}`}>
          <defs>
            <filter id="donut-shadow" x="-30%" y="-30%" width="160%" height="160%">
              <feDropShadow dx="0" dy="2" stdDeviation="3" floodOpacity=".16" />
            </filter>
          </defs>
          <g transform="translate(14 14)" filter="url(#donut-shadow)">
          <g transform="rotate(-90 70 70)">
            <circle cx={70} cy={70} r={RADIUS} fill="none" stroke="var(--surface-3)" strokeWidth={STROKE_WIDTH} />
            {segments.map((segment, index) => (
              <circle
                key={segment.key}
                cx={70}
                cy={70}
                r={RADIUS}
                fill="none"
                stroke={COLORS[index % COLORS.length]}
                strokeWidth={STROKE_WIDTH}
                strokeDasharray={segment.dashArray}
                strokeDashoffset={segment.dashOffset}
              >
                <title>{`${segment.key}: ${formatTokens(segment.value)} ${t("tokens")} (${formatPercent(segment.share)})`}</title>
              </circle>
            ))}
          </g>
          <text x={70} y={66} textAnchor="middle" fill="var(--text-strong)" fontSize={13} fontWeight={700}>
            {new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 }).format(total)}
          </text>
          <text x={70} y={82} textAnchor="middle" fill="var(--faint)" fontSize={9}>
            {t("tokens")}
          </text>
          </g>
        </svg>
        <ul className="donut-legend">
          {segments.map((segment, index) => (
            <li key={segment.key}>
              <i style={{ background: COLORS[index % COLORS.length] }} />
              <span>{segment.key}</span>
              <b>{formatPercent(segment.share)}<small>{formatTokens(segment.value)}</small></b>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
});
