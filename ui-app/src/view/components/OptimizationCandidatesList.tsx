import { memo } from "react";
import type { OptimizationCandidate } from "../../model/types";
import { useI18n } from "../../i18n/I18nContext";

type Props = { candidates: OptimizationCandidate[] };

const MAX_ROWS = 25;

export const OptimizationCandidatesList = memo(function OptimizationCandidatesList({ candidates }: Props) {
  const { t, language, locale } = useI18n();
  const formatTokens = (value: number) => value.toLocaleString(locale);
  const formatMultiplier = (value: number) =>
    `${new Intl.NumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(value)}×`;
  const rows = candidates.slice(0, MAX_ROWS);

  return (
    <div className="chart-panel top-tasks-panel">
      <div className="chart-heading">
        <div>
          <h3>{t("Optimization candidates")}</h3>
          <p>{t("Tasks using significantly more tokens than their family median (>2×)")}</p>
        </div>
      </div>
      {rows.length === 0 ? (
        <div className="chart-empty">{t("No candidates—all tasks are within their family baseline")}</div>
      ) : (
        <div className="usage-table-scroll">
          <table className="usage-table">
            <thead>
              <tr>
                <th>{t("Task ID")}</th>
                <th>{t("Family")}</th>
                <th className="numeric-cell">{t("Total tokens")}</th>
                <th className="numeric-cell">{t("Family median")}</th>
                <th className="numeric-cell">{t("Multiplier")}</th>
                <th>{t("Likely cause")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((candidate) => (
                <tr key={candidate.taskId}>
                  <td className="task-id-cell" title={candidate.taskId}>
                    {candidate.taskId}
                  </td>
                  <td>{candidate.familyKey}</td>
                  <td className="numeric-cell">{formatTokens(candidate.taskTokens)}</td>
                  <td className="numeric-cell">{formatTokens(candidate.groupMedianTokens)}</td>
                  <td className="numeric-cell">
                    <strong>{formatMultiplier(candidate.multiplier)}</strong>
                  </td>
                  <td>{candidate.reasonHint}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {candidates.length > MAX_ROWS && (
        <p className="usage-page-heading" style={{ marginTop: "0.6rem" }}>
          {language === "lt"
            ? `Rodoma ${MAX_ROWS} iš ${candidates.length} kandidatų (rikiuota pagal kartotinį).`
            : `Showing ${MAX_ROWS} of ${candidates.length} candidates, ranked by multiplier.`}
        </p>
      )}
    </div>
  );
});
