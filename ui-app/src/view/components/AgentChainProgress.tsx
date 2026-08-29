import { memo } from "react";
import type { AgentActivity, AgentStatus, SlotAgentActivity } from "../../model/types";
import { useI18n } from "../../i18n/I18nContext";

const statusIcon: Record<AgentStatus, string> = {
  done: "✅",
  error: "❌",
  active: "🔄",
  pending: "⬜",
};

/**
 * Būsenos raktai rašomi ANGLIŠKAI, nes anglų kalba yra `t()` raktų kalba. Mažosios raidės čia
 * reikšmingos: žodyne jau yra „Done", „Error", „Pending" ir „Idle" KITIems kontekstams, o `t()`
 * skiria raidžių dydį — grandinės legenda turi savo raktus ir svetimo vertimo neperrašo.
 */
const statusLabel: Record<AgentStatus, string> = {
  done: "done",
  error: "error",
  active: "active",
  pending: "waiting",
};

/** Dispatch'o režimas. Vertimas per `t()`, bet pati reikšmė lieka technine — žr. žodyno komentarą. */
const modeLabel: Record<AgentActivity["mode"], string> = {
  subagents: "subagents",
  inline: "inline",
  idle: "idle",
};

type Props = {
  activity: AgentActivity;
  /**
   * Kurio srauto grandinė rodoma. Abu laukai NEPRIVALOMI: be jų panelė elgiasi lygiai taip pat kaip
   * anksčiau — vieno srauto atveju priskyrimo klausimo iš viso nebuvo.
   */
  streamLabel?: string | null;
  /** `ambiguous`/`unknown` reiškia, kad priskirti NEĮMANOMA; spėti srautą būtų melas. */
  attribution?: "attached" | "ambiguous" | "unknown";
  /**
   * Kitų srautų gyva veikla (`/api/events` `slots[]`). Antra grandinės juosta rodoma TIK kai tarp
   * jų yra `w2` — sequential režime šio masyvo nebūna arba jame `w2` nėra, ir vaizdas lieka toks
   * pat kaip anksčiau.
   */
  slots?: SlotAgentActivity[];
};

function ChainSteps({ chain, statuses, t }: { chain: string[]; statuses: Record<string, AgentStatus>; t: (text: string) => string }) {
  return (
    <div className="agent-chain">
      {chain.map((agent, i) => {
        const status = statuses[agent] ?? "pending";
        return (
          // Agento vardas NEVERČIAMAS: tai identifikatorius iš grandinės konfigūracijos ir
          // log'o. Verčiama tik būsena, kurią ekrano skaitytuvas perskaito po dvitaškio.
          <div key={agent} className={`agent-step agent-step--${status}`} aria-label={`${agent}: ${t(statusLabel[status])}`}>
            <span className="agent-step-icon" aria-hidden="true">{statusIcon[status]}</span>
            <span className="agent-step-name">{agent}</span>
            {status === "active" && <span className="agent-step-pulse" aria-hidden="true" />}
            {i < chain.length - 1 && <span className="agent-step-arrow" aria-hidden="true">→</span>}
          </div>
        );
      })}
    </div>
  );
}

export const AgentChainProgress = memo(function AgentChainProgress({ activity, streamLabel, attribution, slots }: Props) {
  const { t } = useI18n();
  const { chain, statuses, currentActivity, taskId, claudeStatus, mode } = activity;

  const isLiveStatus = claudeStatus !== null && /^(started|running|active|dispatch|preflight|delegated)$/i.test(claudeStatus);
  const isIdle = chain.length === 0 && !currentActivity && !taskId && !isLiveStatus;
  const w2Slot = slots?.find((slot) => slot.worker_id === "w2");

  return (
    <section className="panel agent-chain-panel">
      <div className="panel-header">
        <div>
          <h2>{t("Active execution")}</h2>
          <p className="panel-subtitle">
            {taskId ? `${t("Task")}: ${taskId}` : t("Real-time execution status")}
            {mode !== "idle" ? ` · ${t(modeLabel[mode])}` : ""}
          </p>
        </div>
        {attribution && (
          <span className="slot-liveness">
            {attribution === "attached" && streamLabel ? streamLabel : t("Stream unknown")}
          </span>
        )}
        {claudeStatus && (
          <span className={`badge ${claudeStatusVariant(claudeStatus)}`}>{claudeStatus}</span>
        )}
      </div>

      {currentActivity ? (
        <div className="agent-current-activity">
          <span className="agent-step-pulse" />
          <span className="agent-activity-text">{currentActivity}</span>
        </div>
      ) : isLiveStatus ? (
        <div className="agent-current-activity">
          <span className="agent-step-pulse" />
          <span className="agent-activity-text">{t("Agent is working…")}</span>
        </div>
      ) : isIdle ? (
        <div className="agent-idle">{t("Waiting for a task…")}</div>
      ) : null}

      {chain.length > 0 && <ChainSteps chain={chain} statuses={statuses} t={t} />}

      {w2Slot && (
        <div className="agent-chain-secondary">
          <div className="agent-chain-secondary-header">
            <span className="agent-chain-secondary-label">{t("Second stream")}</span>
            <span className="agent-chain-secondary-task">{`${t("Task")}: ${w2Slot.task_id}`}</span>
          </div>
          <div className="agent-current-activity agent-chain-secondary-activity">
            <span className="agent-step-pulse" />
            <span className="agent-activity-text">
              {w2Slot.activity.currentActivity ?? w2Slot.activity.claudeStatus ?? t("Agent is working…")}
            </span>
          </div>
          {w2Slot.activity.chain.length > 0 && (
            <ChainSteps chain={w2Slot.activity.chain} statuses={w2Slot.activity.statuses} t={t} />
          )}
        </div>
      )}

      <div className="agent-legend">
        {(["done", "active", "error", "pending"] as AgentStatus[]).map((s) => (
          <span key={s} className="agent-legend-item">
            <span aria-hidden="true">{statusIcon[s]}</span> {t(statusLabel[s])}
          </span>
        ))}
      </div>
    </section>
  );
});

function claudeStatusVariant(status: string): string {
  if (/done|passed|ok/i.test(status)) return "status-good";
  if (/error|fail|blocked/i.test(status)) return "status-error";
  if (/running|active|working/i.test(status)) return "status-live";
  if (/human|pending|waiting/i.test(status)) return "status-warning";
  return "status-neutral";
}
