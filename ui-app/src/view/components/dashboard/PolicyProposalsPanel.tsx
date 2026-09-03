import { useCallback, useEffect, useState } from "react";
import { decidePolicyProposal, fetchPolicyProposals } from "../../../model/api";
import type { PolicyProposal, ResolvedProposal } from "../../../model/types";
import { useI18n } from "../../../i18n/I18nContext";

// Policy-proposal resolution (approve/reject/apply/cancel) surfaced into the
// shipped dashboard tree. This panel is mounted by `DashboardPage`; it is the
// single live home of the resolution UI. It intentionally owns its own proposal
// state (fetch on mount + after every decision) because `useDashboardController`
// only carries the propose-only flow and is out of scope for this change.

type ProposalVerb = "approve" | "reject" | "apply" | "cancel";

/**
 * Pasiūlymo TAPATYBĖ yra trejetas, ne `setting_id`: tam pačiam nustatymui gali laukti keli
 * pasiūlymai, ir be laiko žymos „patvirtink atšaukimą" apginkluotų juos visus vienu paspaudimu.
 */
function proposalKey({ policy_file, setting_id, timestamp }: PolicyProposal): string {
  return `${policy_file}/${setting_id}/${timestamp}`;
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function PolicyProposalsPanel({ refreshToken = 0 }: { refreshToken?: number }) {
  const { t } = useI18n();
  const [proposals, setProposals] = useState<ResolvedProposal[] | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [status, setStatus] = useState<string | undefined>();
  const [view, setView] = useState<"active" | "history">("active");
  /**
   * Apginkluotas atšaukimas — VIENAS visai eilei, kaip `HumanReviewPanel`. `cancel` yra vienintelis
   * destruktyvus verb'as kortelėje (`approve`/`reject` juda audito žurnalu pirmyn, `cancel` uždaro
   * pasiūlymą neįvykdytą ir atgal jo nebegrąžina), tad kelios vienu metu apginkluotos eilutės tik
   * didintų prašaunamo paspaudimo kainą.
   */
  const [cancelArmedKey, setCancelArmedKey] = useState<string | undefined>();

  const load = useCallback(async () => {
    setError(undefined);
    try {
      const next = await fetchPolicyProposals();
      setProposals(next.proposals);
    } catch (nextError: unknown) {
      setError(toMessage(nextError));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, refreshToken]);

  const decide = useCallback(async (verb: ProposalVerb, proposal: PolicyProposal) => {
    const { policy_file, setting_id, reason } = proposal;
    const label = `${verb} ${policy_file}/${setting_id}`;
    setStatus(`${label}: vykdoma`);
    try {
      const next = await decidePolicyProposal(verb, { policy_file, setting_id, reason });
      setProposals(next.proposals);
      setError(undefined);
      setStatus(`${label}: ok`);
      // Nuginkluojama TIK pavykus: po 409 (pvz. pasiūlymas ką tik pritaikytas kitame skirtuke)
      // eilutė lieka apginkluota, kad klaida būtų matoma šalia mygtuko, kuris ją sukėlė.
      setCancelArmedKey(undefined);
    } catch (nextError: unknown) {
      setStatus(`${label}: klaida - ${toMessage(nextError)}`);
    }
  }, []);

  const activeProposals = (proposals ?? []).filter(({ status: proposalStatus }) =>
    proposalStatus === "pending" || proposalStatus === "approved");
  const historicalProposals = (proposals ?? []).filter(({ status: proposalStatus }) =>
    proposalStatus === "rejected" || proposalStatus === "applied" || proposalStatus === "cancelled");
  const visibleProposals = (view === "active" ? activeProposals : historicalProposals)
    .slice()
    .sort((left, right) => right.proposal.timestamp.localeCompare(left.proposal.timestamp));

  return (
    <section className="panel proposal-inbox" aria-labelledby="policy-proposals-title">
      <div className="panel-header">
        <div>
          <p className="usage-eyebrow">{t("Decision queue")}</p>
          <h2 id="policy-proposals-title">{t("Policy changes")}</h2>
          <p className="panel-subtitle">{t("Approve, reject, apply, and audit proposed policy changes.")}</p>
        </div>
        {proposals && <span className="badge status-neutral">{activeProposals.length} {t("requiring action")}</span>}
      </div>
      {error ? (
        <p role="alert" className="proposal-error">
          {t("Could not load policy proposals")}: {error}
        </p>
      ) : null}
      {error ? <button className="button ghost small-button" type="button" onClick={() => void load()}>
        {t("Try again")}
      </button> : null}
      {status ? <p role="status">{status}</p> : null}
      {!proposals && !error ? <p className="proposal-empty">{t("Loading...")}</p> : null}
      {proposals && (
        <div className="proposal-view-switch segmented-control" aria-label={t("Policy change views")}>
          <button type="button" className={view === "active" ? "active" : ""} aria-pressed={view === "active"} onClick={() => setView("active")}>
            {t("Needs action")} <b>{activeProposals.length}</b>
          </button>
          <button type="button" className={view === "history" ? "active" : ""} aria-pressed={view === "history"} onClick={() => setView("history")}>
            {t("Change history")} <b>{historicalProposals.length}</b>
          </button>
        </div>
      )}
      {proposals && visibleProposals.length === 0 ? (
        <div className="inbox-zero">
          <span>✓</span>
          <strong>{t(view === "active" ? "No policy changes awaiting review" : "No policy change history")}</strong>
          <p>{t(view === "active" ? "New proposals will appear here with a complete audit trail." : "Applied, rejected, and cancelled changes will appear here.")}</p>
        </div>
      ) : null}
      {visibleProposals.map((resolved) => (
        <PolicyProposalCard
          key={proposalKey(resolved.proposal)}
          resolved={resolved}
          onDecide={decide}
          cancelArmed={cancelArmedKey === proposalKey(resolved.proposal)}
          onArmCancel={setCancelArmedKey}
        />
      ))}
    </section>
  );
}

function PolicyProposalCard({
  resolved,
  onDecide,
  cancelArmed,
  onArmCancel,
}: {
  resolved: ResolvedProposal;
  onDecide: (verb: ProposalVerb, proposal: PolicyProposal) => Promise<void>;
  cancelArmed: boolean;
  onArmCancel: (key: string | undefined) => void;
}) {
  const { t } = useI18n();
  const { proposal, status, history } = resolved;
  const { policy_file, setting_id, old_value, requested_value, reason, routing, timestamp } = proposal;
  const lastDecision = history.length > 0 ? history[history.length - 1] : undefined;
  return (
    <article className={`proposal-card proposal-${status}`}>
      <div className="proposal-card-header">
        <div><span>{policy_file}</span><h3>{setting_id}</h3></div>
        <span className={`badge proposal-status proposal-status-${status}`}>{t(status)}</span>
      </div>
      <div className="proposal-value-change" aria-label={t("Requested change")}>
        <div><span>{t("Current value")}</span><strong>{String(old_value)}</strong></div>
        <span aria-hidden="true">→</span>
        <div><span>{t("Proposed value")}</span><strong>{String(requested_value)}</strong></div>
      </div>
      <div className="proposal-context">
        <p><span>{t("Reason")}</span><strong>{reason}</strong></p>
        <p><span>{t("Route")}</span><code>{routing}</code></p>
        <p><span>{t("Submitted")}</span><time dateTime={timestamp}>{timestamp}</time></p>
      </div>
      {status === "pending" || status === "approved" ? (
        <div className="proposal-actions">
          {cancelArmed ? (
            <>
              <button
                className="button danger small-button"
                type="button"
                onClick={() => void onDecide("cancel", proposal)}
              >
                {t("Confirm")}: {t("Cancel proposal")}
              </button>
              <button
                className="button ghost small-button"
                type="button"
                onClick={() => onArmCancel(undefined)}
              >
                {t("Keep proposal")}
              </button>
            </>
          ) : (
            <>
              {status === "pending" ? (
                <>
                  <button
                    className="button success small-button"
                    type="button"
                    onClick={() => void onDecide("approve", proposal)}
                  >
                    {t("Approve")}
                  </button>
                  <button
                    className="button danger small-button"
                    type="button"
                    onClick={() => void onDecide("reject", proposal)}
                  >
                    {t("Reject")}
                  </button>
                </>
              ) : (
                <button
                  className="button primary small-button"
                  type="button"
                  onClick={() => void onDecide("apply", proposal)}
                >
                  {t("Apply")}
                </button>
              )}
              <button
                className="button ghost small-button proposal-cancel"
                type="button"
                onClick={() => onArmCancel(proposalKey(proposal))}
              >
                {t("Cancel proposal")}
              </button>
            </>
          )}
        </div>
      ) : lastDecision ? (
        <div className="proposal-audit">
          <span>{t("Latest decision")}</span>
          <strong>{t(lastDecision.decision)} · {lastDecision.actor}</strong>
          <p>{lastDecision.reason}</p>
          <time dateTime={lastDecision.timestamp}>{lastDecision.timestamp}</time>
        </div>
      ) : null}
    </article>
  );
}
