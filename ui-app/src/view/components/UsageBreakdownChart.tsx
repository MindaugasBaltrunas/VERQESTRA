import { memo } from "react";
import type { AggregateRow } from "../../model/tokenUsageViewModel";
import { toBarWidthPercent } from "../../model/chartMath";
import { useI18n } from "../../i18n/I18nContext";

type Props = {
  rows: AggregateRow[];
  title: string;
  variant?: "accent" | "accent-2";
  onSelectKey?: (key: string) => void;
};

function formatTokens(value: number): string {
  return value.toLocaleString("lt-LT");
}

function formatPercent(value: number): string {
  return new Intl.NumberFormat("lt-LT", { style: "percent", maximumFractionDigits: 1 }).format(value);
}

export const UsageBreakdownChart = memo(function UsageBreakdownChart({ rows, title, variant = "accent", onSelectKey }: Props) {
  const { t } = useI18n();
  if (rows.length === 0) {
    return (
      <div className="chart-panel">
        <h3>{title}</h3>
        <div className="chart-empty">{t("No data")}</div>
      </div>
    );
  }

  const visibleRows = rows.filter((row) => row.totalTokens > 0).sort((a, b) => b.totalTokens - a.totalTokens);
  const max = Math.max(...visibleRows.map((row) => row.totalTokens), 0);
  const total = visibleRows.reduce((sum, row) => sum + row.totalTokens, 0);
  const activityRecords = rows.reduce((sum, row) => sum + row.records, 0);
  const barColor = variant === "accent-2" ? "var(--accent-2)" : "var(--accent)";

  return (
    <div className="chart-panel">
      <div className="chart-heading">
        <div>
          <h3>{title}</h3>
          <p>{t("Share of total token usage")}</p>
        </div>
      </div>
      <div className="bar-chart">
        {visibleRows.length === 0 && (
          <div className="chart-empty compact">
            {formatTokens(activityRecords)} activity records exist, but none report token usage.
          </div>
        )}
        {visibleRows.map((row) => {
          const widthPercent = toBarWidthPercent(row.totalTokens, max);
          const share = total > 0 ? (row.totalTokens / total) * 100 : 0;
          return (
            <div key={row.key} className="bar-row">
              {onSelectKey ? (
                <button className="bar-label bar-label-button" type="button" title={`${t("Filter by")} ${row.key}`} onClick={() => onSelectKey(row.key)}>
                  {row.key}
                </button>
              ) : <span className="bar-label" title={row.key}>{row.key}</span>}
              <svg className="bar-track-svg" viewBox="0 0 100 12" preserveAspectRatio="none">
                <rect x={0} y={0} width={100} height={12} fill="var(--surface-3)" />
                <rect x={0} y={0} width={widthPercent} height={12} fill={barColor} />
              </svg>
              <span className="bar-value"><strong>{formatTokens(row.totalTokens)}</strong><small>{formatPercent(share / 100)}</small></span>
            </div>
          );
        })}
      </div>
    </div>
  );
});
