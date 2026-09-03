import { memo } from "react";
import type { OptimizationCandidate, TaskFamilyGroup } from "../../../model/types";
import { useI18n } from "../../../i18n/I18nContext";

type Props = {
  groups: TaskFamilyGroup[];
  candidates: OptimizationCandidate[];
};

const MAX_ROWS = 25;

export const SimilarTaskGroupsTable = memo(function SimilarTaskGroupsTable({ groups, candidates }: Props) {
  const { t, language, locale } = useI18n();
  const formatTokens = (value: number) => value.toLocaleString(locale);
  const candidateCountByFamily = new Map<string, number>();
  for (const candidate of candidates) {
    candidateCountByFamily.set(candidate.familyKey, (candidateCountByFamily.get(candidate.familyKey) ?? 0) + 1);
  }

  const rows = groups.slice(0, MAX_ROWS);

  return (
    <div className="chart-panel top-tasks-panel">
      <div className="chart-heading">
        <div>
          <h3>{t("Comparable task families")}</h3>
          <p>{language === "lt"
            ? `${groups.length.toLocaleString(locale)} grupės pagal giminystės raktą (bendras pagrindas, skaidymo vaikai, taisymo bandymai, bendri pavadinimo tokenai)`
            : `${groups.length.toLocaleString(locale)} groups by affinity key (shared stem, split children, repair attempts, and title tokens)`}</p>
        </div>
      </div>
      {rows.length === 0 ? (
        <div className="chart-empty">{t("No data")}</div>
      ) : (
        <div className="usage-table-scroll">
          <table className="usage-table">
            <thead>
              <tr>
                <th>{t("Family key")}</th>
                <th className="numeric-cell">{t("Tasks")}</th>
                <th className="numeric-cell">{t("Total tokens")}</th>
                <th className="numeric-cell">{t("Family median")}</th>
                <th className="numeric-cell">{t("Candidates")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((group) => (
                <tr key={group.familyKey}>
                  <td className="task-id-cell" title={group.taskIds.join(", ")}>
                    {group.familyKey}
                  </td>
                  <td className="numeric-cell">{group.taskIds.length}</td>
                  <td className="numeric-cell">{formatTokens(group.totalTokens)}</td>
                  <td className="numeric-cell">{formatTokens(group.medianTokens)}</td>
                  <td className="numeric-cell">{candidateCountByFamily.get(group.familyKey) ?? 0}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {groups.length > MAX_ROWS && (
        <p className="usage-page-heading" style={{ marginTop: "0.6rem" }}>
          {language === "lt"
            ? `Rodoma ${MAX_ROWS} iš ${groups.length} grupių (rikiuota pagal tokenų sumą).`
            : `Showing ${MAX_ROWS} of ${groups.length} groups, ranked by total tokens.`}
        </p>
      )}
    </div>
  );
});
