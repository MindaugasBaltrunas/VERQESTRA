import { useEffect, useMemo, useState } from "react";
import type { AggregateRow, SortDirection, SortKey } from "../../model/tokenUsageViewModel";
import { useI18n } from "../../i18n/I18nContext";
import { sortAggregateRows } from "../../model/tokenUsageViewModel";

type Props = { rows: AggregateRow[]; onSelectTask?: (taskId: string) => void; unassignedRecords?: number };

type Column = { key: SortKey; label: string; numeric?: boolean };

const PAGE_SIZE = 15;

const columns: Column[] = [
  { key: "key", label: "Task ID" },
  { key: "records", label: "Records", numeric: true },
  { key: "inputTokens", label: "Input", numeric: true },
  { key: "outputTokens", label: "Output", numeric: true },
  { key: "cacheReadTokens", label: "Cache read", numeric: true },
  { key: "cacheCreationTokens", label: "Cache create", numeric: true },
  { key: "totalTokens", label: "Total tokens", numeric: true },
];

function formatTokens(value: number): string {
  return value.toLocaleString("lt-LT");
}

function formatCompactTokens(value: number): string {
  return new Intl.NumberFormat("lt-LT", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

function tokenShare(value: number, total: number): number {
  return total > 0 ? value / total : 0;
}

function formatPercent(value: number): string {
  return new Intl.NumberFormat("lt-LT", { style: "percent", maximumFractionDigits: 1 }).format(value);
}

export function TopTasksTable({ rows, onSelectTask, unassignedRecords }: Props) {
  const { t, locale, language } = useI18n();
  const [sortKey, setSortKey] = useState<SortKey>("totalTokens");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");
  const [page, setPage] = useState(1);

  const sortedRows = useMemo(
    () => sortAggregateRows(rows, sortKey, sortDirection),
    [rows, sortKey, sortDirection],
  );
  const totalPages = Math.max(1, Math.ceil(sortedRows.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageRows = sortedRows.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);
  const totalTokens = rows.reduce((sum, row) => sum + row.totalTokens, 0);
  const rowsIdentity = rows.map((row) => row.key).join("\u0000");
  const overview = useMemo(() => {
    const rankedRows = sortAggregateRows(rows, "totalTokens", "desc");
    const leader = totalTokens > 0 ? (rankedRows[0] ?? null) : null;
    const topFiveTokens = rankedRows.slice(0, 5).reduce((sum, row) => sum + row.totalTokens, 0);
    return {
      leader,
      topFiveShare: tokenShare(topFiveTokens, totalTokens),
      averageTokens: rows.length > 0 ? totalTokens / rows.length : 0,
    };
  }, [rows, totalTokens]);

  useEffect(() => {
    setPage(1);
  }, [rowsIdentity]);

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDirection((current) => (current === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDirection("desc");
    }
    setPage(1);
  };

  return (
    <section className="chart-panel top-tasks-panel" aria-labelledby="top-tasks-title">
      <div className="top-tasks-heading">
        <div>
          <p className="usage-eyebrow">{t("Task view")}</p>
          <h3 id="top-tasks-title">{t("Top token-consuming tasks")}</h3>
          <p>{t("Sort by total usage or an individual token type. Only data matching active filters is shown.")}</p>
        </div>
        <span className="top-tasks-count">{rows.length.toLocaleString(locale)} {language === "lt" ? "užduočių" : "tasks"}</span>
      </div>
      {rows.length === 0 ? (
        <div className="chart-empty">No data</div>
      ) : (
        <>
          {totalTokens === 0 && (
            <div className="zero-token-notice">
              {language === "lt"
                ? `Rasta ${formatTokens(rows.reduce((sum, row) => sum + row.records, 0))} veiklos įrašų, tačiau jie tokenų nesunaudojo.`
                : `${formatTokens(rows.reduce((sum, row) => sum + row.records, 0))} activity records were found, but they report no token usage.`}
            </div>
          )}
          <div className="top-tasks-overview" aria-label={t("Task token summary")}>
            <div>
              <span>{t("Largest task")}</span>
              <strong title={overview.leader?.key}>{overview.leader?.key ?? t("No tokens used")}</strong>
              {/* Du angliški literalai, likę be vertimo šalia kaimynų, kurie jį turi. */}
              <small>
                {overview.leader
                  ? `${formatCompactTokens(overview.leader.totalTokens)} ${t("tokens")}`
                  : t("No token-using task")}
              </small>
            </div>
            <div>
              <span>{t("Top 5 share")}</span>
              <strong>{formatPercent(overview.topFiveShare)}</strong>
              <small>{language === "lt" ? "viso pasirinkto laikotarpio" : "of the selected period"}</small>
            </div>
            <div>
              <span>{t("Average per task")}</span>
              <strong>{formatCompactTokens(overview.averageTokens)}</strong>
              <small>{language === "lt" ? "tokenų vienai užduočiai" : "tokens per task"}</small>
            </div>
            <div>
              {/* Be `t()` — vienintelis šios eilutės kaimynas jį turi (žr. eilutę aukščiau). */}
              <span>{t("Total")}</span>
              <strong>{formatCompactTokens(totalTokens)}</strong>
              <small>{formatTokens(totalTokens)} {language === "lt" ? "tokenų" : "tokens"}</small>
            </div>
          </div>

          <div className="usage-table-scroll top-tasks-table-scroll">
            <table className="usage-table top-tasks-table">
              <caption className="visually-hidden">{t("Task token usage for selected filters")}</caption>
              <thead>
                <tr>
                  {columns.map((column) => (
                    <th
                      key={column.key}
                      className={column.numeric ? "numeric-cell" : undefined}
                      aria-sort={sortKey === column.key ? (sortDirection === "asc" ? "ascending" : "descending") : undefined}
                    >
                      <button className="table-sort-button" type="button" onClick={() => toggleSort(column.key)}>
                        {t(column.label)}
                        {sortKey === column.key && <span aria-hidden="true">{sortDirection === "asc" ? " ▲" : " ▼"}</span>}
                      </button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {pageRows.map((row) => (
                  <tr key={row.key}>
                    <td className="task-id-cell" data-label={t("Task ID")} title={row.key}>
                      {onSelectTask
                        ? <button type="button" className="task-drilldown-button" onClick={() => onSelectTask(row.key)}>{row.key}</button>
                        : row.key}
                    </td>
                    <td className="numeric-cell" data-label={t("Records")}>{row.records.toLocaleString(locale)}</td>
                    <td className="numeric-cell" data-label={t("Input")}>{row.inputTokens.toLocaleString(locale)}</td>
                    <td className="numeric-cell" data-label={t("Output")}>{row.outputTokens.toLocaleString(locale)}</td>
                    <td className="numeric-cell" data-label={t("Cache read")}>{row.cacheReadTokens.toLocaleString(locale)}</td>
                    <td className="numeric-cell" data-label={t("Cache create")}>{row.cacheCreationTokens.toLocaleString(locale)}</td>
                    <td className="numeric-cell total-token-cell" data-label={t("Total tokens")}>
                      <strong>{formatTokens(row.totalTokens)}</strong>
                      <small>{formatPercent(tokenShare(row.totalTokens, totalTokens))}</small>
                      <span className="token-share-track" aria-hidden="true">
                        <i style={{ width: `${Math.min(tokenShare(row.totalTokens, totalTokens) * 100, 100)}%` }} />
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {rows.length > PAGE_SIZE && (
        <div className="table-pagination" aria-label={t("Table pages")}>
          <span>{(safePage - 1) * PAGE_SIZE + 1}–{Math.min(safePage * PAGE_SIZE, rows.length)} iš {rows.length}</span>
          <div>
            <button type="button" disabled={safePage === 1} onClick={() => setPage((value) => Math.max(1, value - 1))} aria-label={t("Previous page")}>‹</button>
            <strong>{safePage} / {totalPages}</strong>
            <button type="button" disabled={safePage === totalPages} onClick={() => setPage((value) => Math.min(totalPages, value + 1))} aria-label={t("Next page")}>›</button>
          </div>
        </div>
      )}
      {typeof unassignedRecords === "number" && unassignedRecords > 0 && (
        <p className="unassigned-records-notice">
          <strong>{formatTokens(unassignedRecords)}</strong>{" "}
          {t("records have no task ID and are excluded from this table and the unique task count above.")}
        </p>
      )}
    </section>
  );
}
