import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchReliabilityAnalytics } from "../../model/api";
import { buildFailureCsv } from "../../model/failureCsv";
import type { ReliabilityAnalyticsResponse } from "../../model/types";
import { useI18n } from "../../i18n/I18nContext";
import { Header, type Route } from "../components/Header";
import type { Language } from "../../i18n/I18nContext";

type Props = { activeRoute: Route; onNavigate: (route: Route) => void };
type FailureFilter = "all" | "open" | "fixed";
type ReliabilityPeriod = 7 | 30 | 90 | "all";
type FailureSort = "failed-desc" | "tokens-desc" | "duration-desc";
type FailureRecord = ReliabilityAnalyticsResponse["reliability"]["records"][number];

const pageSizes = [15, 30, 50] as const;

function duration(minutes: number | undefined, numberFormat: Intl.NumberFormat): string {
  if (minutes === undefined) return "—";
  if (minutes < 60) return `${Math.round(minutes)} min`;
  if (minutes < 1440) return `${numberFormat.format(minutes / 60)} h`;
  return `${numberFormat.format(minutes / 1440)} d`;
}

function recordCount(count: number, language: Language): string {
  if (language === "en") return `${count} ${count === 1 ? "record" : "records"}`;
  const lastTwo = count % 100;
  const last = count % 10;
  if (lastTwo >= 10 && lastTwo <= 20) return `${count} gedimų įrašų`;
  if (last === 1) return `${count} gedimo įrašas`;
  if (last >= 2 && last <= 9) return `${count} gedimų įrašai`;
  return `${count} gedimų įrašų`;
}

function countLabel(count: number, language: Language, en: [string, string], lt: [string, string, string]): string {
  if (language === "en") return `${count} ${count === 1 ? en[0] : en[1]}`;
  const lastTwo = count % 100;
  const last = count % 10;
  const form = lastTwo >= 10 && lastTwo <= 20 ? lt[2] : last === 1 ? lt[0] : last >= 2 && last <= 9 ? lt[1] : lt[2];
  return `${count} ${form}`;
}

function inPeriod(timestamp: string, generatedAt: string, period: ReliabilityPeriod): boolean {
  if (period === "all") return true;
  const end = new Date(generatedAt);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - period + 1);
  start.setUTCHours(0, 0, 0, 0);
  return Date.parse(timestamp) >= start.getTime() && Date.parse(timestamp) <= end.getTime();
}

function summarizeRecords(records: FailureRecord[]) {
  const fixed = records.filter((record) => record.status === "fixed").length;
  const repairMinutes = records.flatMap((record) => record.fixedAt ? [(Date.parse(record.fixedAt) - Date.parse(record.failedAt)) / 60_000] : []);
  const sortedMinutes = repairMinutes.filter(Number.isFinite).sort((left, right) => left - right);
  const middle = Math.floor(sortedMinutes.length / 2);
  const medianRepairMinutes = sortedMinutes.length === 0 ? undefined : sortedMinutes.length % 2
    ? sortedMinutes[middle]
    : ((sortedMinutes[middle - 1] ?? 0) + (sortedMinutes[middle] ?? 0)) / 2;
  const byType = new Map<string, { count: number; fixed: number; open: number }>();
  for (const record of records) {
    const item = byType.get(record.type) ?? { count: 0, fixed: 0, open: 0 };
    item.count += 1;
    item[record.status] += 1;
    byType.set(record.type, item);
  }
  return {
    failures: records.length,
    fixed,
    open: records.length - fixed,
    fixRate: records.length ? fixed / records.length : 1,
    medianRepairMinutes,
    incidentTokens: records.reduce((sum, record) => sum + record.totalTokens, 0),
    repairTokens: records.reduce((sum, record) => sum + record.repairTokens, 0),
    diagnosticTokens: records.reduce((sum, record) => sum + record.diagnosticTokens, 0),
    retryTokens: records.reduce((sum, record) => sum + record.retryTokens, 0),
    cacheTokens: records.reduce((sum, record) => sum + record.cacheTokens, 0),
    byType: [...byType.entries()].map(([type, value]) => ({ type, ...value })).sort((left, right) => right.count - left.count),
  };
}


export function ReliabilityPage({ activeRoute, onNavigate }: Props) {
  const { t, locale, language } = useI18n();
  const compact = useMemo(() => new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 }), [locale]);
  const decimal = useMemo(() => new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }), [locale]);
  const [data, setData] = useState<ReliabilityAnalyticsResponse>();
  const [error, setError] = useState<string>();
  const [filter, setFilter] = useState<FailureFilter>("all");
  const [period, setPeriod] = useState<ReliabilityPeriod>(30);
  const [selectedFailureDate, setSelectedFailureDate] = useState<string>();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [detailPage, setDetailPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(15);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<FailureSort>("failed-desc");
  const load = useCallback(async (fresh = false) => {
    setError(undefined);
    try { setData(await fetchReliabilityAnalytics(fresh)); }
    catch (nextError) { setError(nextError instanceof Error ? nextError.message : String(nextError)); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const periodRecords = useMemo(() => (data?.reliability.records ?? []).filter((record) =>
    data ? inPeriod(record.failedAt, data.generatedAt, period) : false), [data, period]);
  const periodSummary = useMemo(() => summarizeRecords(periodRecords), [periodRecords]);
  const records = useMemo(() => {
    const query = search.trim().toLocaleLowerCase(locale);
    return periodRecords.filter((record) =>
      (filter === "all" || record.status === filter)
      && (!selectedFailureDate || record.failedAt.startsWith(selectedFailureDate))
      && (!query || `${record.taskId} ${record.type} ${record.phase} ${record.reason} ${record.detail ?? ""}`.toLocaleLowerCase(locale).includes(query)))
      .sort((left, right) => {
        if (sort === "tokens-desc") return right.totalTokens - left.totalTokens || right.failedAt.localeCompare(left.failedAt);
        if (sort === "duration-desc") {
          const leftDuration = left.fixedAt ? Date.parse(left.fixedAt) - Date.parse(left.failedAt) : Number.POSITIVE_INFINITY;
          const rightDuration = right.fixedAt ? Date.parse(right.fixedAt) - Date.parse(right.failedAt) : Number.POSITIVE_INFINITY;
          return rightDuration - leftDuration || right.failedAt.localeCompare(left.failedAt);
        }
        return right.failedAt.localeCompare(left.failedAt);
      });
  }, [periodRecords, filter, selectedFailureDate, search, sort, locale]);
  const detailPageCount = Math.max(1, Math.ceil(records.length / pageSize));
  const visibleRecords = records.slice((detailPage - 1) * pageSize, detailPage * pageSize);
  const fileRows = useMemo(() => data?.files.byDay.slice(period === "all" ? 0 : -period) ?? [], [data, period]);
  const selectedPeriodLabel = period === "all" ? t("All history") : countLabel(period, language, ["day", "days"], ["diena", "dienos", "dienų"]);
  useEffect(() => { setDetailPage(1); }, [filter, selectedFailureDate, search, sort, pageSize, period, data]);
  useEffect(() => { setSelectedFailureDate(undefined); }, [period]);

  const exportCsv = useCallback(() => {
    const blob = new Blob([`\uFEFF${buildFailureCsv(records)}`], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `ag-loop-failures-${period === "all" ? "all" : `${period}d`}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  }, [records, period]);

  return (
    <>
      <Header root="" onRefresh={() => void load(true)} activeRoute={activeRoute} onNavigate={onNavigate} />
      <main>
        <div className="page-heading">
          <div><p className="page-eyebrow">{t("Engineering intelligence")}</p><h2>{t("Reliability")}</h2><p>{t("File activity, failures, repairs, unresolved work, and deterministic token cost in one view.")}</p></div>
          {data && <span className="freshness-indicator"><i /> {t("Updated")} {new Date(data.generatedAt).toLocaleString(locale)}</span>}
        </div>
        {error && <div className="notice notice-error" role="alert">{t("Could not load reliability analytics")}: {error} <button className="button ghost small-button" onClick={() => void load()}>{t("Try again")}</button></div>}
        {!data && !error && <div className="panel">{t("Loading...")}</div>}
        {data && (
          <div className="reliability-page">
            <section className="reliability-period-bar" aria-label={t("Analytics period")}>
              <div><strong>{t("Analytics period")}</strong><span>{t("The summary, failure types, timeline, and details use the same period.")}</span></div>
              <div className="segmented-control">
                {([7, 30, 90, "all"] as const).map((value) => <button key={value} type="button" className={period === value ? "active" : ""} aria-pressed={period === value} onClick={() => setPeriod(value)}>{value === "all" ? t("All") : countLabel(value, language, ["day", "days"], ["diena", "dienos", "dienų"])}</button>)}
              </div>
            </section>
            <section className="reliability-kpis" aria-label={t("Reliability summary")}>
              <Kpi label={t("Files this session")} value={String(data.files.session.touched)} detail={`${t("Created")}: ${data.files.session.created} · ${t("Modified")}: ${data.files.session.modified}`} />
              <Kpi label={t("Unique files today")} value={String(data.files.today.uniqueFiles)} detail={`${t("Commits")}: ${data.files.today.commits}`} />
              <Kpi label={t("Unique files this week")} value={String(data.files.week.uniqueFiles)} detail={`${t("Commits")}: ${data.files.week.commits}`} />
              <Kpi label={t("Fix rate")} value={`${decimal.format(periodSummary.fixRate * 100)}%`} detail={`${t("Fixed")}: ${periodSummary.fixed} / ${periodSummary.failures} · ${selectedPeriodLabel}`} tone={periodSummary.open ? "warning" : "good"} />
              <Kpi label={t("Still unresolved")} value={String(periodSummary.open)} detail={`${t("Failure events without a later done event")} · ${selectedPeriodLabel}`} tone={periodSummary.open ? "error" : "good"} />
              <Kpi label={t("Median repair time")} value={duration(periodSummary.medianRepairMinutes, decimal)} detail={`${t("From failure to the next done event")} · ${selectedPeriodLabel}`} />
              <Kpi label={t("Incident tokens")} value={compact.format(periodSummary.incidentTokens)} detail={`${t("All tokens between failure and recovery")} · ${selectedPeriodLabel}`} />
            </section>

            <section className="panel">
              <div className="panel-header"><div><h2>{t("Incident token structure")}</h2><p className="panel-subtitle">{t("Non-overlapping diagnostic and retry attribution, with cache shown separately")}</p></div><span className="badge status-neutral">{selectedPeriodLabel}</span></div>
              <div className="reliability-token-grid">
                <Kpi label={t("Diagnostic tokens")} value={compact.format(periodSummary.diagnosticTokens)} detail={t("Diagnosis phases")} />
                <Kpi label={t("Retry tokens")} value={compact.format(periodSummary.retryTokens)} detail={t("Retry attempts outside diagnosis")} />
                <Kpi label={t("Cache tokens")} value={compact.format(periodSummary.cacheTokens)} detail={t("Cache read and creation tokens")} />
                <Kpi label={t("Repair share")} value={`${decimal.format(periodSummary.incidentTokens ? periodSummary.repairTokens / periodSummary.incidentTokens * 100 : 0)}%`} detail={`${compact.format(periodSummary.repairTokens)} / ${compact.format(periodSummary.incidentTokens)}`} />
              </div>
            </section>

            <section className="panel">
              <div className="panel-header"><div><h2>{t("File activity over time")}</h2><p className="panel-subtitle">{t("Unique created, modified, and deleted files from Git commits")}</p></div><span className="badge status-neutral">{period === "all" ? countLabel(data.coverage.gitSinceDays, language, ["day", "days"], ["diena", "dienos", "dienų"]) : selectedPeriodLabel}</span></div>
              <FileActivityChart rows={fileRows} />
            </section>

            <div className="reliability-two-column">
              <section className="panel">
                <div className="panel-header"><div><h2>{t("Failures by type")}</h2><p className="panel-subtitle">{t("Deterministic classification from phase, reason, and error detail")}</p></div></div>
                <div className="failure-type-list">
                  {periodSummary.byType.map((item) => (
                    <div key={item.type}><span>{t(item.type)}</span><div className="type-bar"><i style={{ width: `${periodSummary.failures ? item.count / periodSummary.failures * 100 : 0}%` }} /></div><strong>{item.count}</strong><small>{t("Unresolved")}: {item.open}</small></div>
                  ))}
                </div>
              </section>
              <section className="panel">
                <div className="panel-header"><div><h2>{t("Unique changed files by type")}</h2><p className="panel-subtitle">{t("Unique file paths changed during the available Git history")}</p></div></div>
                <div className="extension-grid">
                  {data.files.byExtension.map((item) => <div key={item.extension}><code>{item.extension}</code><strong>{item.files}</strong></div>)}
                </div>
              </section>
            </div>

            <section className="panel failure-ledger">
              <div className="panel-header">
                <div><h2>{t("Failure and repair timeline")}</h2><p className="panel-subtitle">{t("Select a day in the chart, then expand its failure details")}</p></div>
                {selectedFailureDate && <button className="button ghost small-button" type="button" onClick={() => setSelectedFailureDate(undefined)}>× {t("Clear day filter")}</button>}
              </div>
              <FailureTimelineChart
                rows={data.reliability.byDay}
                endDate={data.generatedAt}
                period={period}
                selectedDate={selectedFailureDate}
                onSelectDate={setSelectedFailureDate}
                compact={compact}
              />
              <details className="failure-details" open={detailsOpen} onToggle={(event) => setDetailsOpen(event.currentTarget.open)}>
                <summary>
                  <span><strong>{t("Failure details")}</strong><small>{selectedFailureDate ? `${selectedFailureDate} UTC · ` : ""}{recordCount(records.length, language)}</small></span>
                  <span>{t(detailsOpen ? "Collapse details" : "Expand details")}</span>
                </summary>
                <div className="failure-detail-toolbar">
                  <div className="segmented-control" aria-label={t("Filter failure records")}>
                    {(["all", "open", "fixed"] as const).map((value) => <button key={value} type="button" className={filter === value ? "active" : ""} aria-pressed={filter === value} onClick={() => setFilter(value)}>{t(value)}</button>)}
                  </div>
                  <p>{t("Showing records for")} <strong>{selectedFailureDate ? `${selectedFailureDate} UTC` : selectedPeriodLabel}</strong></p>
                </div>
                <div className="failure-query-toolbar">
                  <label><span>{t("Search failures")}</span><input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t("Task, type, phase, or reason...")} /></label>
                  <label><span>{t("Sort by")}</span><select value={sort} onChange={(event) => setSort(event.target.value as FailureSort)}><option value="failed-desc">{t("Newest failure")}</option><option value="tokens-desc">{t("Most incident tokens")}</option><option value="duration-desc">{t("Longest repair time")}</option></select></label>
                  <label><span>{t("Rows per page")}</span><select value={pageSize} onChange={(event) => setPageSize(Number(event.target.value))}>{pageSizes.map((size) => <option key={size} value={size}>{size}</option>)}</select></label>
                  <button type="button" className="button ghost small-button" onClick={exportCsv} disabled={records.length === 0}>↓ {t("Export CSV")}</button>
                </div>
                {records.length === 0 ? <div className="inbox-zero"><span>✓</span><strong>{t("No matching failure records")}</strong></div> : (
                  <div className="table-scroll"><table><thead><tr><th>{t("Task / type")}</th><th>{t("Failed")}</th><th>{t("Recovered")}</th><th>{t("Status")}</th><th>{t("Reason")}</th><th>{t("Tokens")}</th></tr></thead>
                    <tbody>{visibleRecords.map((record) => <tr key={`${record.taskId}-${record.failedAt}`}><td><strong>{record.taskId}</strong><small>{t(record.type)} · {record.phase}</small></td><td>{new Date(record.failedAt).toLocaleString(locale)}</td><td>{record.fixedAt ? new Date(record.fixedAt).toLocaleString(locale) : "—"}</td><td><span className={`badge ${record.status === "fixed" ? "status-good" : "status-error"}`}>{t(record.status)}</span></td><td title={record.detail}>{record.reason}</td><td><strong>{compact.format(record.totalTokens)}</strong><small>{t("Diagnosis")}: {compact.format(record.diagnosticTokens)} · {t("Retries")}: {compact.format(record.retryTokens)} · {t("Cache")}: {compact.format(record.cacheTokens)}</small></td></tr>)}</tbody>
                  </table></div>
                )}
                {records.length > pageSize && <nav className="failure-pagination" aria-label={t("Failure detail pages")}>
                  <button type="button" className="button ghost small-button" disabled={detailPage === 1} onClick={() => setDetailPage((page) => page - 1)}>{t("Previous")}</button>
                  <span>{t("Page")} {detailPage} {t("of")} {detailPageCount}</span>
                  <button type="button" className="button ghost small-button" disabled={detailPage === detailPageCount} onClick={() => setDetailPage((page) => page + 1)}>{t("Next")}</button>
                </nav>}
              </details>
            </section>

            <section className="reliability-coverage">
              <strong>{t("Data coverage")}</strong><span>Git: {data.coverage.gitAvailable ? countLabel(data.coverage.gitSinceDays, language, ["day", "days"], ["diena", "dienos", "dienų"]) : t("unavailable")} · {countLabel(data.coverage.taskEvents, language, ["task event", "task events"], ["užduoties įvykis", "užduočių įvykiai", "užduočių įvykių"])} · {countLabel(data.coverage.tokenRecords, language, ["token record", "token records"], ["tokenų įrašas", "tokenų įrašai", "tokenų įrašų"])}</span>
              {data.coverage.limitations.map((item) => <p key={item}>{t(item)}</p>)}
            </section>
          </div>
        )}
      </main>
    </>
  );
}

function Kpi({ label, value, detail, tone = "neutral" }: { label: string; value: string; detail: string; tone?: string }) {
  return <article className={`reliability-kpi kpi-${tone}`}><span>{label}</span><strong>{value}</strong><small>{detail}</small></article>;
}

function FileActivityChart({ rows }: { rows: ReliabilityAnalyticsResponse["files"]["byDay"] }) {
  const { t } = useI18n();
  const max = Math.max(1, ...rows.map((row) => row.created + row.modified + row.deleted));
  return <div className="file-activity-chart" role="img" aria-label={t("Daily file activity chart")}>
    <div className="chart-legend"><span className="legend-created">{t("Created")}</span><span className="legend-modified">{t("Modified")}</span><span className="legend-deleted">{t("Deleted")}</span></div>
    <div className="file-bars" style={{ gridTemplateColumns: `repeat(${Math.max(rows.length, 1)}, minmax(12px, 1fr))` }}>{rows.map((row) => {
      const total = row.created + row.modified + row.deleted;
      return <div key={row.date} className="file-bar-column" title={`${row.date}: ${total}`}><div className="file-bar-stack" style={{ height: `${Math.max(total ? 5 : 0, total / max * 150)}px` }}><i className="created" style={{ flex: row.created }} /><i className="modified" style={{ flex: row.modified }} /><i className="deleted" style={{ flex: row.deleted }} /></div><span>{row.date.slice(5)}</span></div>;
    })}</div>
  </div>;
}

function FailureTimelineChart({
  rows,
  endDate,
  period,
  selectedDate,
  onSelectDate,
  compact,
}: {
  rows: ReliabilityAnalyticsResponse["reliability"]["byDay"];
  endDate: string;
  period: ReliabilityPeriod;
  selectedDate?: string;
  onSelectDate: (date: string) => void;
  compact: Intl.NumberFormat;
}) {
  const { t } = useI18n();
  const days = useMemo(() => {
    if (period === "all") return rows.map((row) => ({
      date: row.date,
      fixed: row.fixed,
      open: row.open,
      incidentTokens: row.incidentTokens,
      diagnosticTokens: row.diagnosticTokens,
      retryTokens: row.retryTokens,
      cacheTokens: row.cacheTokens,
    }));
    const result: Array<{ date: string; fixed: number; open: number; incidentTokens: number; diagnosticTokens: number; retryTokens: number; cacheTokens: number }> = [];
    const end = new Date(endDate);
    for (let offset = period - 1; offset >= 0; offset -= 1) {
      const date = new Date(end);
      date.setUTCDate(date.getUTCDate() - offset);
      const key = date.toISOString().slice(0, 10);
      const matching = rows.find((row) => row.date === key);
      result.push({
        date: key,
        fixed: matching?.fixed ?? 0,
        open: matching?.open ?? 0,
        incidentTokens: matching?.incidentTokens ?? 0,
        diagnosticTokens: matching?.diagnosticTokens ?? 0,
        retryTokens: matching?.retryTokens ?? 0,
        cacheTokens: matching?.cacheTokens ?? 0,
      });
    }
    return result;
  }, [endDate, period, rows]);
  const max = Math.max(1, ...days.map((day) => day.fixed + day.open));
  const selected = days.find((day) => day.date === selectedDate);

  return (
    <div className="failure-timeline" role="region" aria-label={t("Failure and repair timeline chart")}>
      <div className="chart-legend">
        <span className="legend-fixed">{t("Fixed")}</span>
        <span className="legend-open">{t("Unresolved")}</span>
        <small>{t("Click a bar to filter details")}</small>
      </div>
      {selected && <div className="failure-selection" aria-live="polite">
        <strong>{selected.date} UTC</strong>
        <span>{t("Fixed")}: {selected.fixed}</span>
        <span>{t("Unresolved")}: {selected.open}</span>
        <span>{t("Incident tokens")}: {compact.format(selected.incidentTokens)}</span>
        <span>{t("Diagnosis")}: {compact.format(selected.diagnosticTokens)}</span>
        <span>{t("Retries")}: {compact.format(selected.retryTokens)}</span>
        <span>{t("Cache")}: {compact.format(selected.cacheTokens)}</span>
      </div>}
      <div className="failure-chart-plot">
        <div className="failure-axis" aria-hidden="true"><span>{max}</span><span>{Math.round(max / 2)}</span><span>0</span></div>
        <div className="failure-timeline-bars" style={{ gridTemplateColumns: `repeat(${Math.max(days.length, 1)}, minmax(12px, 1fr))` }}>
        {days.map((day) => {
          const total = day.fixed + day.open;
          return (
            <button
              key={day.date}
              type="button"
              className={`failure-day${selectedDate === day.date ? " selected" : ""}`}
              aria-label={`${day.date} UTC; ${t("Failures")}: ${total}; ${t("Fixed")}: ${day.fixed}; ${t("Unresolved")}: ${day.open}`}
              aria-pressed={selectedDate === day.date}
              onClick={() => onSelectDate(day.date)}
              disabled={total === 0}
              title={`${day.date}\n${t("Failures")}: ${total}\n${t("Incident tokens")}: ${compact.format(day.incidentTokens)}`}
            >
              <span className="failure-day-stack" style={{ height: `${Math.max(total ? 6 : 0, total / max * 150)}px` }}>
                <i className="fixed" style={{ flex: day.fixed }} />
                <i className="open" style={{ flex: day.open }} />
              </span>
              <small>{day.date.slice(5)}</small>
            </button>
          );
        })}
        </div>
      </div>
    </div>
  );
}
