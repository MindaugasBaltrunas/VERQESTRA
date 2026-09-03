import { memo } from "react";
import type { AgentActivity, AgentStatus, SlotAgentActivity } from "../../../model/types";
import { useI18n } from "../../../i18n/I18nContext";

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

/** Gyva Claude sesijos būsena — tik ji leidžia panelę vadinti „aktyviu vykdymu". */
const LIVE_STATUS = /^(started|running|active|dispatch|preflight|delegated)$/i;

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
   * Gyvų srautų veikla (`/api/events` `slots[]`). Kai sąrašas netuščias, JIS yra panelės turinys:
   * kiekvienas įrašas ateina iš savo bandymo log'o, o globalus `activity` yra tik paskutinio
   * rašytojo veidrodis — 2026-09-02 auditas: worktree bangos metu jis rodė vakarykštę, jau baigtą
   * grandinę su „Srautas nežinomas", o dviejų dirbančių srautų grandinės nebuvo matomos niekur.
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

function Legend({ t }: { t: (text: string) => string }) {
  return (
    <div className="agent-legend">
      {(["done", "active", "error", "pending"] as AgentStatus[]).map((s) => (
        <span key={s} className="agent-legend-item">
          <span aria-hidden="true">{statusIcon[s]}</span> {t(statusLabel[s])}
        </span>
      ))}
    </div>
  );
}

/** Srauto numeris ekrane: `w1`/`w2` yra vidiniai vardai, operatorius mato 1 ir 2. */
function streamIndex(workerId: string): number {
  return workerId === "w2" ? 2 : 1;
}

/** Vieno gyvo srauto juosta. Klasės tos pačios kaip buvusio „Antro srauto" bloko — CSS nekinta. */
function SlotLane({ slot, t }: { slot: SlotAgentActivity; t: (text: string) => string }) {
  return (
    <div className="agent-chain-secondary">
      <div className="agent-chain-secondary-header">
        <span className="agent-chain-secondary-label">{`${t("Stream")} ${streamIndex(slot.worker_id)}`}</span>
        <span className="agent-chain-secondary-task">{`${t("Task")}: ${slot.task_id}`}</span>
      </div>
      <div className="agent-current-activity agent-chain-secondary-activity">
        <span className="agent-step-pulse" />
        <span className="agent-activity-text">
          {slot.activity.currentActivity ?? slot.activity.claudeStatus ?? t("Agent is working…")}
        </span>
      </div>
      {slot.activity.chain.length > 0 && <ChainSteps chain={slot.activity.chain} statuses={slot.activity.statuses} t={t} />}
    </div>
  );
}

export const AgentChainProgress = memo(function AgentChainProgress({ activity, streamLabel, attribution, slots }: Props) {
  const { t } = useI18n();
  const liveSlots = [...(slots ?? [])].sort((a, b) => streamIndex(a.worker_id) - streamIndex(b.worker_id));

  if (liveSlots.length > 0) {
    return (
      <section className="panel agent-chain-panel">
        <div className="panel-header">
          <div>
            <h2>{t("Active execution")}</h2>
            <p className="panel-subtitle">{t("Real-time execution status")}</p>
          </div>
        </div>
        {liveSlots.map((slot) => <SlotLane key={slot.worker_id} slot={slot} t={t} />)}
        <Legend t={t} />
      </section>
    );
  }

  const { chain, statuses, currentActivity, taskId, claudeStatus, mode } = activity;
  const isLiveStatus = claudeStatus !== null && LIVE_STATUS.test(claudeStatus);
  const isIdle = chain.length === 0 && !currentActivity && !taskId && !isLiveStatus;
  // Užbaigtas vykdymas NĖRA aktyvus (task 106): antraštė sako „Paskutinis vykdymas", o srauto
  // atribucija slepiama — baigtam darbui ji nebeturi prasmės ir tik atrodo kaip gedimas.
  const finished = !isLiveStatus && !isIdle;

  return (
    <section className="panel agent-chain-panel">
      <div className="panel-header">
        <div>
          <h2>{finished ? t("Last execution") : t("Active execution")}</h2>
          <p className="panel-subtitle">
            {taskId ? `${t("Task")}: ${taskId}` : t("Real-time execution status")}
            {mode !== "idle" ? ` · ${t(modeLabel[mode])}` : ""}
          </p>
        </div>
        {attribution && !finished && (
          <span className="slot-liveness">
            {attribution === "attached" && streamLabel ? streamLabel : t("Stream unknown")}
          </span>
        )}
        {claudeStatus && (
          <span className={`badge ${claudeStatusVariant(claudeStatus)}`}>{claudeStatus}</span>
        )}
      </div>

      {currentActivity && !finished ? (
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

      <Legend t={t} />
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
