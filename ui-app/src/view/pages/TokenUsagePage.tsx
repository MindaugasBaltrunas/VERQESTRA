import { useTokenUsageController } from "../../controller/useTokenUsageController";
import { useTokenAnalyticsController } from "../../controller/useTokenAnalyticsController";
import { Header, type Route } from "../components/Header";
import { TokenUsageFilterBar } from "../components/TokenUsageFilterBar";
import { TokenUsageSummaryPanel } from "../components/TokenUsageSummaryPanel";
import { TokenTrendChart } from "../components/CostOverTimeChart";
import { UsageBreakdownChart } from "../components/UsageBreakdownChart";
import { TopTasksTable } from "../components/TopTasksTable";
import { DistributionDonutChart } from "../components/DistributionDonutChart";
import { CacheEfficiencyTrendChart } from "../components/CacheEfficiencyTrendChart";
import { GroupComparisonChart } from "../components/GroupComparisonChart";
import { SimilarTaskGroupsTable } from "../components/SimilarTaskGroupsTable";
import { OptimizationCandidatesList } from "../components/OptimizationCandidatesList";
import { TokenAnalyticsSnapshotPanel } from "../components/TokenAnalyticsSnapshotPanel";
import { AnalyticsDecisionPanel } from "../components/AnalyticsDecisionPanel";
import { TaskConcentrationChart } from "../components/TaskConcentrationChart";
import { useI18n } from "../../i18n/I18nContext";

type Props = {
  activeRoute: Route;
  onNavigate: (route: Route) => void;
};

export function TokenUsagePage({ activeRoute, onNavigate }: Props) {
  const { t, locale } = useI18n();
  const isOptimization = activeRoute === "optimization";
  const {
    loading,
    error,
    refreshError,
    isEmpty,
    isPartial,
    loadedRecords,
    totalRecords,
    filters,
    modelOptions,
    phaseOptions,
    totals,
    byModel,
    byPhaseGroup,
    byDay,
    byTask,
    fastPathStats,
    periodComparison,
    reworkProxyStats,
    perRecordTokenStats,
    perTaskTokenStats,
    actions,
  } = useTokenUsageController();

  const analytics = useTokenAnalyticsController();
  const latestSnapshot = analytics.history[analytics.history.length - 1] ?? null;

  const formatTimestamp = (value: string | null) =>
    value ? new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : t("No data");

  return (
    <>
      <Header root="" onRefresh={() => void Promise.all([actions.reload(), analytics.reload()])} activeRoute={activeRoute} onNavigate={onNavigate} />
      <main className="usage-page">
        {!isOptimization && <section className="usage-page-heading">
          <div>
            <p className="usage-eyebrow">{t("Performance intelligence")}</p>
            <h2>{t("Model efficiency")}</h2>
            <p>{t("Token volume, workload distribution, cache efficiency, and anomalies in one view.")}</p>
          </div>
          <div className="usage-freshness">
            <span>{t("Latest record")}</span>
            <strong>{formatTimestamp(totals.latestTimestamp)}</strong>
          </div>
        </section>}
        {!isOptimization && <TokenUsageFilterBar
          model={filters.model}
          phase={filters.phase}
          taskIdQuery={filters.taskIdQuery}
          from={filters.from}
          to={filters.to}
          modelOptions={modelOptions}
          phaseOptions={phaseOptions}
          onModelChange={actions.setModel}
          onPhaseChange={actions.setPhase}
          onTaskIdQueryChange={actions.setTaskIdQuery}
          onFromChange={actions.setFrom}
          onToChange={actions.setTo}
          onDatePreset={actions.setDatePreset}
          onReset={actions.resetFilters}
        />}

        {!isOptimization && (error ? (
          <div className="notice notice-error" role="alert">
            <strong>{t("Error")}:</strong> {error}
            <br />
            <button
              className="button ghost small-button"
              style={{ marginTop: "0.6rem" }}
              type="button"
              onClick={() => void actions.reload()}
            >
              {t("Try again")}
            </button>
          </div>
        ) : loading ? (
          <div style={{ padding: "2rem", color: "var(--muted)" }}>{t("Loading...")}</div>
        ) : isEmpty ? (
          <div className="chart-empty">{t("No token usage data matches the selected filters.")}</div>
        ) : (
          <>
            {refreshError ? (
              <div className="notice" style={{ color: "var(--error)" }} role="status">
                <strong>{t("Refresh failed")}:</strong> {refreshError}
              </div>
            ) : null}
            {isPartial ? (
              <div className="notice">
                {t("Showing the latest")} {loadedRecords} {t("of")} {totalRecords} {t("records")}.
                <button className="button ghost small-button" type="button" onClick={() => actions.loadAll()}>
                  {t("Load full history")}
                </button>
              </div>
            ) : null}
            <TokenUsageSummaryPanel
              totals={totals}
              fastPathStats={fastPathStats}
              perRecordTokenStats={perRecordTokenStats}
              perTaskTokenStats={perTaskTokenStats}
            />
            <AnalyticsDecisionPanel comparison={periodComparison} rework={reworkProxyStats} isPartial={isPartial} />
            <div className="chart-grid token-overview-grid">
              <TokenTrendChart byDay={byDay} />
              <UsageBreakdownChart rows={byModel} title={t("Model workload distribution")} variant="accent" onSelectKey={actions.setModel} />
              <UsageBreakdownChart rows={byPhaseGroup} title={t("Tokens by workflow stage")} variant="accent-2" />
              <TaskConcentrationChart rows={byTask} onSelectTask={actions.setTaskIdQuery} />
            </div>
            <TopTasksTable rows={byTask} onSelectTask={actions.setTaskIdQuery} unassignedRecords={totals.unassignedRecords} />
          </>
        ))}

        {isOptimization && <section className="usage-page-heading">
          <div>
            <p className="usage-eyebrow">{t("Optimization intelligence")}</p>
            <h2>{t("Optimization opportunities")}</h2>
            <p>{t("Anomalies, comparable task groups, and concrete candidates for reducing token usage.")}</p>
          </div>
        </section>}

        {isOptimization && (analytics.error ? (
          <div className="notice notice-error" role="alert">
            <strong>{t("Error")}:</strong> {analytics.error}
            <br />
            <button
              className="button ghost small-button"
              style={{ marginTop: "0.6rem" }}
              type="button"
              onClick={() => void analytics.reload()}
            >
              {t("Try again")}
            </button>
          </div>
        ) : analytics.loading ? (
          <div style={{ padding: "2rem", color: "var(--muted)" }}>{t("Loading...")}</div>
        ) : analytics.isEmpty ? (
          <div className="chart-empty">{t("Not enough data for comparable-task analysis.")}</div>
        ) : (
          <>
            <TokenAnalyticsSnapshotPanel snapshot={latestSnapshot} />
            <div className="chart-grid analytics-grid">
              <GroupComparisonChart groups={analytics.groups} candidates={analytics.candidates} />
              <DistributionDonutChart
                title={t("Cumulative tokens by stage")}
                description="All-time distribution across preflight, dispatch, diagnose, fast path, and other stages"
                rows={latestSnapshot?.tokensByPhase ?? []}
              />
              <DistributionDonutChart
                title={t("Cumulative tokens by model")}
                description={t("All-time workload distribution by model")}
                rows={latestSnapshot?.tokensByModel ?? []}
              />
              <CacheEfficiencyTrendChart history={analytics.history} />
              <SimilarTaskGroupsTable groups={analytics.groups} candidates={analytics.candidates} />
              <OptimizationCandidatesList candidates={analytics.candidates} />
            </div>
          </>
        ))}
      </main>
    </>
  );
}
