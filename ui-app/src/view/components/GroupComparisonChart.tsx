import { memo } from "react";
import type { OptimizationCandidate, TaskFamilyGroup } from "../../model/types";
import { toBarWidthPercent } from "../../model/chartMath";
import { useI18n } from "../../i18n/I18nContext";

type Props = {
  groups: TaskFamilyGroup[];
  candidates: OptimizationCandidate[];
};

const MAX_ROWS = 20;

export const GroupComparisonChart = memo(function GroupComparisonChart({ groups, candidates }: Props) {
  const { t, language, locale } = useI18n();
  const formatTokens = (value: number) => value.toLocaleString(locale);
  if (groups.length === 0) {
    return (
      <div className="chart-panel">
        <h3>{t("Comparable task groups")}</h3>
        <div className="chart-empty">{t("No data")}</div>
      </div>
    );
  }

  const candidateCountByFamily = new Map<string, number>();
  for (const candidate of candidates) {
    candidateCountByFamily.set(candidate.familyKey, (candidateCountByFamily.get(candidate.familyKey) ?? 0) + 1);
  }

  const visibleGroups = groups.slice(0, MAX_ROWS);
  const max = Math.max(...visibleGroups.map((group) => group.totalTokens), 0);
  const visibleTotal = visibleGroups.reduce((sum, group) => sum + group.totalTokens, 0);
  const candidateFamilies = visibleGroups.filter((group) => (candidateCountByFamily.get(group.familyKey) ?? 0) > 0).length;

  return (
    <div className="chart-panel">
      <div className="chart-heading">
        <div>
          <h3>{t("Comparable task groups")}</h3>
          <p>{t("Total tokens by task family, with medians representing a typical task")}</p>
        </div>
        <div className="chart-kpi-pair" aria-label={t("Chart summary")}>
          <span><small>{t("Visible volume")}</small><strong>{formatTokens(visibleTotal)}</strong></span>
          <span><small>{t("Candidate families")}</small><strong>{candidateFamilies}</strong></span>
        </div>
      </div>
      <div className="comparison-axis" aria-hidden="true">
        <span>0</span><span>25%</span><span>50%</span><span>75%</span><span>100%</span>
      </div>
      <div className="comparison-chart" role="list" aria-label={t("Comparable task groups")}>
        {visibleGroups.map((group) => {
          const widthPercent = toBarWidthPercent(group.totalTokens, max);
          const medianPercent = toBarWidthPercent(group.medianTokens, max);
          const candidateCount = candidateCountByFamily.get(group.familyKey) ?? 0;
          return (
            <div
              key={group.familyKey}
              className="comparison-row"
              role="listitem"
              aria-label={`${group.familyKey}: ${formatTokens(group.totalTokens)} ${t("tokens")}; ${t("median")} ${formatTokens(group.medianTokens)}`}
            >
              <span className="comparison-label" title={group.taskIds.join(", ")}>
                <strong>{group.familyKey}</strong>
                <small>{group.taskIds.length} {language === "lt" ? "užd." : "tasks"}</small>
                {candidateCount > 0 && (
                  <span className="candidate-badge" title={language === "lt" ? `${candidateCount} optimizavimo kandidatas(-ai) šioje grupėje` : `${candidateCount} optimization candidate(s) in this group`}>
                    ⚠ {candidateCount}
                  </span>
                )}
              </span>
              <span className="comparison-track" aria-hidden="true">
                <i className={candidateCount > 0 ? "has-candidate" : ""} style={{ width: `${widthPercent}%` }} />
                <b style={{ left: `${medianPercent}%` }} />
              </span>
              <span className="comparison-value">
                <strong>{formatTokens(group.totalTokens)}</strong>
                <small>{language === "lt" ? "med" : "median"} {formatTokens(group.medianTokens)}</small>
              </span>
            </div>
          );
        })}
      </div>
      <div className="comparison-legend" aria-label={t("Chart legend")}>
        <span><i className="legend-total" />{t("Total usage")}</span>
        <span><i className="legend-median" />{t("Family median")}</span>
        <span><i className="legend-candidate" />{t("Optimization candidate present")}</span>
      </div>
      {groups.length > MAX_ROWS && (
        <p className="chart-limit-note">
          {language === "lt"
            ? `Grafike rodoma TOP ${MAX_ROWS} iš ${groups.length.toLocaleString(locale)} grupių pagal bendrą tokenų kiekį.`
            : `Chart shows the top ${MAX_ROWS} of ${groups.length.toLocaleString(locale)} groups by total token usage.`}
        </p>
      )}
    </div>
  );
});
