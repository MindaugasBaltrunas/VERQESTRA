import { memo } from "react";
import type { TokenAnalyticsSnapshot } from "../../model/types";
import { useI18n } from "../../i18n/I18nContext";

type Props = { snapshot: TokenAnalyticsSnapshot | null };

function formatNumber(value: number): string {
  return Math.round(value).toLocaleString("lt-LT");
}

function formatPercent(value: number): string {
  return new Intl.NumberFormat("lt-LT", { style: "percent", maximumFractionDigits: 1 }).format(value);
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

export const TokenAnalyticsSnapshotPanel = memo(function TokenAnalyticsSnapshotPanel({ snapshot }: Props) {
  const { t, locale } = useI18n();
  if (!snapshot) {
    return (
      <section className="chart-panel analytics-snapshot-panel">
        <h3>{t("Accumulated analytics snapshot")}</h3>
        <div className="chart-empty">{t("Snapshot history has not been created yet; live groups are shown below.")}</div>
      </section>
    );
  }

  const firstDay = snapshot.tokensByDay[0]?.key;
  const lastDay = snapshot.tokensByDay[snapshot.tokensByDay.length - 1]?.key;
  const groupMedian = median(snapshot.groupMedians.map((group) => group.medianTokens));
  const generatedAt = new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(snapshot.generatedAt));

  const metrics = [
    { label: t("Total tokens"), value: formatNumber(snapshot.totals.totalTokens) },
    { label: t("Records"), value: formatNumber(snapshot.totals.records) },
    { label: t("Tasks"), value: formatNumber(snapshot.totals.uniqueTasks) },
    { label: t("Preflight fast-path"), value: formatPercent(snapshot.fastPathHitRate.preflight) },
    { label: t("Diagnose fast-path"), value: formatPercent(snapshot.fastPathHitRate.diagnose) },
    { label: t("Cache hit rate"), value: formatPercent(snapshot.cacheHitRate) },
    { label: t("Tasks with repair"), value: formatPercent(snapshot.repairShare) },
    {
      label: t("Median of group medians"),
      value: formatNumber(groupMedian),
      detail: `${formatNumber(snapshot.groupMedians.length)} ${t("groups")}`,
    },
  ];

  return (
    <section className="chart-panel analytics-snapshot-panel" aria-labelledby="analytics-snapshot-title">
      <div className="analytics-snapshot-heading">
        <div>
          <p className="usage-eyebrow">{t("Latest accumulated view")}</p>
          <h3 id="analytics-snapshot-title">{t("Analytics snapshot summary")}</h3>
          <p>
            {snapshot.tokensByDay.length > 0
              ? `${formatNumber(snapshot.tokensByDay.length)} ${t("days")} · ${firstDay}–${lastDay}`
              : t("No daily view yet")}
          </p>
        </div>
        <span title={snapshot.generatedAt}>{t("Updated")} {generatedAt}</span>
      </div>
      <div className="analytics-snapshot-metrics">
        {metrics.map((metric) => (
          <div key={metric.label}>
            <span>{metric.label}</span>
            <strong>{metric.value}</strong>
            {metric.detail && <small>{metric.detail}</small>}
          </div>
        ))}
      </div>
    </section>
  );
});
