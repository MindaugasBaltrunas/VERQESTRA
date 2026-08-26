import { memo } from "react";
import type { AggregateRow } from "../../model/tokenUsageViewModel";
import { useI18n } from "../../i18n/I18nContext";

type Props = {
  rows: AggregateRow[];
  onSelectTask?: (taskId: string) => void;
};

const MAX_TASKS = 10;

export const TaskConcentrationChart = memo(function TaskConcentrationChart({ rows, onSelectTask }: Props) {
  const { t, locale } = useI18n();
  const ranked = [...rows].filter((row) => row.totalTokens > 0).sort((a, b) => b.totalTokens - a.totalTokens);
  const visible = ranked.slice(0, MAX_TASKS);
  const total = ranked.reduce((sum, row) => sum + row.totalTokens, 0);
  const max = visible[0]?.totalTokens ?? 0;
  let cumulative = 0;

  if (visible.length === 0) {
    return (
      <section className="chart-panel">
        <h3>{t("Task token concentration")}</h3>
        <div className="chart-empty">{t("No data")}</div>
      </section>
    );
  }

  const topShare = visible.reduce((sum, row) => sum + row.totalTokens, 0) / total;
  return (
    <section className="chart-panel" aria-labelledby="task-concentration-title">
      <div className="chart-heading">
        <div>
          <h3 id="task-concentration-title">{t("Task token concentration")}</h3>
          <p>{t("Largest tasks and their cumulative share of selected token usage")}</p>
        </div>
        <div className="trend-headline">
          <strong>{topShare.toLocaleString(locale, { style: "percent", maximumFractionDigits: 1 })}</strong>
          <span>{t("Top 10 share")}</span>
        </div>
      </div>
      <div className="task-concentration-axis" aria-hidden="true">
        <span>{t("Task")}</span><span>{t("Relative size")}</span><span>{t("Share / cumulative")}</span>
      </div>
      <div className="task-concentration-chart" role="list">
        {visible.map((row, index) => {
          const share = row.totalTokens / total;
          cumulative += share;
          const cumulativeShare = cumulative;
          return (
            <div
              className="task-concentration-row"
              role="listitem"
              key={row.key}
              aria-label={`${row.key}: ${row.totalTokens.toLocaleString(locale)} ${t("tokens")}, ${share.toLocaleString(locale, { style: "percent", maximumFractionDigits: 1 })}`}
            >
              <span className="task-rank">{index + 1}</span>
              {onSelectTask ? (
                <button type="button" className="task-drilldown-button" title={row.key} onClick={() => onSelectTask(row.key)}>
                  {row.key}
                </button>
              ) : <span className="task-name" title={row.key}>{row.key}</span>}
              <span className="task-concentration-track" aria-hidden="true">
                <i style={{ width: `${max > 0 ? (row.totalTokens / max) * 100 : 0}%` }} />
              </span>
              <span className="task-concentration-value">
                <strong>{share.toLocaleString(locale, { style: "percent", maximumFractionDigits: 1 })}</strong>
                <small>Σ {cumulativeShare.toLocaleString(locale, { style: "percent", maximumFractionDigits: 1 })}</small>
              </span>
            </div>
          );
        })}
      </div>
      {ranked.length > MAX_TASKS && (
        <p className="chart-limit-note">{t("Top 10 tasks are shown; use the table below for full drill-down.")}</p>
      )}
    </section>
  );
});
