import { memo, useState } from "react";
import type { UiControlPlaneData, UiLearningRecommendation } from "../../../model/types";
import { Badge } from "../shared/Badge";
import type { StatusVariant } from "../../../model/dashboardViewModel";
import { useI18n } from "../../../i18n/I18nContext";

// Surfaces the learning-memory recommendations the dashboard payload already
// computes (`controlPlane.learning_recommendations` + `learning_summary`) and
// gives the `/learning/approve|reject` endpoints their only UI owner. Before
// this panel those payload fields were computed server-side on every poll but
// never rendered, and the approve/reject API client functions were dead exports.

type LearningSummary = UiControlPlaneData["learning_summary"];

type Props = {
  summary: LearningSummary;
  recommendations: UiLearningRecommendation[];
  onApprove: (id: string) => Promise<void>;
  onReject: (id: string) => Promise<void>;
};

function statusVariant(status: UiLearningRecommendation["status"]): StatusVariant {
  if (status === "approved") return "good";
  if (status === "rejected") return "error";
  return "warning";
}

function statusLabel(status: UiLearningRecommendation["status"]): string {
  if (status === "approved") return "approved";
  if (status === "rejected") return "rejected";
  return "pending";
}

export const LearningPanel = memo(function LearningPanel({
  summary,
  recommendations,
  onApprove,
  onReject,
}: Props) {
  const { t } = useI18n();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const pending = recommendations.filter((recommendation) => recommendation.status === "pending");
  const history = recommendations.filter((recommendation) => recommendation.status !== "pending");
  const visibleRecommendations = showHistory ? history : pending;

  async function decide(id: string, action: (id: string) => Promise<void>) {
    setBusyId(id);
    try {
      await action(id);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="panel">
      <div className="panel-header">
        <div><h2>{t("Recommendation inbox")}</h2><p className="panel-subtitle">{t("Only recommendations requiring a decision are shown by default")}</p></div>
        <div className="segmented-control">
          <button type="button" className={!showHistory ? "active" : ""} onClick={() => setShowHistory(false)}>{t("Pending")} <b>{pending.length}</b></button>
          <button type="button" className={showHistory ? "active" : ""} onClick={() => setShowHistory(true)}>{t("History")} <b>{history.length}</b></button>
        </div>
      </div>
      <div className="summary">
        <div className="metric">
          <div className="metric-label">{t("Records")}</div>
          <div className="metric-value">{summary.records}</div>
        </div>
        <div className="metric">
          <div className="metric-label">{t("Pending")}</div>
          <div className="metric-value">{summary.pending_recommendations}</div>
        </div>
        <div className="metric">
          <div className="metric-label">{t("Approved")}</div>
          <div className="metric-value">{summary.approved_recommendations}</div>
        </div>
        <div className="metric">
          <div className="metric-label">{t("Rejected")}</div>
          <div className="metric-value">{summary.rejected_recommendations}</div>
        </div>
      </div>
      {visibleRecommendations.length === 0 ? (
        <div className="inbox-zero"><span>✓</span><strong>{t(showHistory ? "No decision history" : "All recommendations reviewed")}</strong><p>{t("Nothing currently requires your decision.")}</p></div>
      ) : (
        <div className="recommendation-list">{visibleRecommendations.map((recommendation) => (
          <details
            key={recommendation.id}
            className="recommendation-card"
          >
            <summary>
              <div><Badge text={statusLabel(recommendation.status)} variant={statusVariant(recommendation.status)} /><strong>{recommendation.summary}</strong></div>
              <span>{recommendation.evidence.length} evidence items</span>
            </summary>
            <div className="recommendation-body">
              <div className="recommendation-labels">{recommendation.labels.map((label) => <Badge key={label} text={label} variant="neutral" />)}</div>
              {recommendation.evidence.length > 0 && (
              <ul style={{ margin: "0.25rem 0", paddingInlineStart: "1.2rem", color: "var(--muted)", fontSize: "0.85em" }}>
                {recommendation.evidence.map((item, index) => (
                  <li key={index}>{item}</li>
                ))}
              </ul>
            )}
              {recommendation.status === "pending" && (
              <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap", marginTop: "0.5rem" }}>
                <button
                  className="button success small-button"
                  type="button"
                  disabled={busyId === recommendation.id}
                  onClick={() => void decide(recommendation.id, onApprove)}
                >
                  {t("Approve")}
                </button>
                <button
                  className="button danger small-button"
                  type="button"
                  disabled={busyId === recommendation.id}
                  onClick={() => void decide(recommendation.id, onReject)}
                >
                  {t("Reject")}
                </button>
              </div>
              )}
            </div>
          </details>
        ))}</div>
      )}
    </section>
  );
});
