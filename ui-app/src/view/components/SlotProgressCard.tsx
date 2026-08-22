import { memo, type ReactNode } from "react";
import { fill } from "../../model/fillTemplate";
import { formatAge, formatElapsed } from "../../model/slotProgressFormat";
import type {
  SlotLiveness,
  SlotProgressBar,
  SlotProgressPhase,
  SlotProgressView,
} from "../../model/slotProgressViewModel";
import type { LoopSlotState } from "../../model/types";
import { EtaBadge } from "./EtaBadge";
import { ProgressBar } from "./ProgressBar";
import { useI18n } from "../../i18n/I18nContext";

/** Raktai rašomi ANGLIŠKAI, nes anglų kalba yra `t()` raktų kalba. `unknown` turi SAVO tekstą. */
const PHASE_LABEL: Record<SlotProgressPhase, string> = {
  idle: "Idle",
  waiting: "Waiting for a slot",
  preparing: "Preparing",
  preflight: "Preflight",
  implementation: "Implementation",
  review: "Review",
  diagnosis: "Diagnosis",
  finishing: "Finishing",
  unknown: "Phase unknown",
};

const STATE_LABEL: Record<LoopSlotState, string> = {
  running: "Running",
  draining: "Draining",
  aborting: "Aborting",
  idle: "Idle",
};

/** `idle` sąmoningai be modifikatoriaus: laukimas nėra nei gerai, nei blogai. */
const STATE_MODIFIER: Record<LoopSlotState, string> = {
  running: " slot-state-badge--live",
  draining: " slot-state-badge--warning",
  aborting: " slot-state-badge--error",
  idle: "",
};

const WORKTREE_LABEL: Record<"yes" | "no" | "unknown", string> = { yes: "Yes", no: "No", unknown: "unknown" };

/** Kodėl gyvo srauto nepavyksta priskirti — paaiškinimas eina į `title`, ne į patį ženkliuką. */
const LIVENESS_TITLE: Partial<Record<SlotLiveness, string>> = {
  ambiguous: "Live activity matches more than one stream",
  detached: "Live stream cannot be matched to a slot",
};

/** Juostos paaiškinimas. Biudžeto `normal` gauna neutralų užrašą: procentas jau pasako viską. */
function progressLabelOf(progress: SlotProgressBar, t: (text: string) => string): string | null {
  if (progress.signal === "chain") {
    return fill(t("{done} of {total} agents"), { done: progress.done, total: progress.total });
  }
  if (progress.signal !== "budget") return null;
  if (progress.level === "over") return t("Over budget");
  if (progress.level === "warning") return t("Budget almost used up");
  return t("Progress");
}

type Props = {
  view: SlotProgressView;
  variant: "full" | "compact";
  /** Mygtukai ir pastabos ateina IŠ IŠORĖS: kortelė pati nieko nevaldo ir nieko nerašo į serverį. */
  children?: ReactNode;
};

export const SlotProgressCard = memo(function SlotProgressCard({ view, variant, children }: Props) {
  const { t } = useI18n();
  const streamName = `${t("Stream")} ${view.index}`;
  // `key` pagal būseną: perpiešiant tą patį mazgą CSS morph animacija nebepasileistų, o būtent ji
  // ir parodo, kad būsena PASIKEITĖ, o ne buvo tokia visą laiką.
  const stateBadge = (
    <span key={view.state} className={`slot-state-badge${STATE_MODIFIER[view.state]}`}>
      {t(STATE_LABEL[view.state])}
    </span>
  );

  if (variant === "compact") {
    // Apžvalgos kortelė yra santrauka, o ne antra valdymo vieta: mygtukai, darbo kopija ir klaidų
    // istorija lieka `#/system`, kad tas pats veiksmas neturėtų dviejų šeimininkų.
    return (
      <article className="runtime-card slot-card slot-card--compact" aria-label={streamName}>
        <div className="runtime-card-top">
          <strong>{streamName} · {view.taskId ?? "—"}</strong>
          {stateBadge}
        </div>
        <span className="slot-phase">{t(PHASE_LABEL[view.phase])}</span>
        <ProgressBar progress={view.progress} />
        {view.eta.state === "available" && <EtaBadge eta={view.eta} />}
      </article>
    );
  }

  const livenessTitle = LIVENESS_TITLE[view.liveness];

  return (
    <article className="runtime-card slot-card" aria-label={streamName}>
      <div className="runtime-card-top">
        <div>
          <h3>{streamName}</h3>
          <p>
            {view.taskId
              ? fill(t("Task {task}, attempt {attempt}"), { task: view.taskId, attempt: view.attempt ?? "—" })
              : t("No task assigned")}
          </p>
        </div>
        {stateBadge}
      </div>

      {/* `attached` reiškia, kad gyvas srautas yra ŠIO slot'o — tada ženkliuko nereikia. `offline`
          irgi tylus: sustabdytame cikle nėra ko sieti, ir „srautas nežinomas" ten būtų triukšmas. */}
      {view.liveness !== "attached" && view.liveness !== "offline" && (
        <span className="slot-liveness" title={livenessTitle ? t(livenessTitle) : undefined}>
          {t("Stream unknown")}
        </span>
      )}

      <span className="slot-phase">
        {t(PHASE_LABEL[view.phase])}
        {/* Agento vardas NEVERČIAMAS: tai identifikatorius, kurio ieškoma log'e ir konfigūracijoje. */}
        {view.phaseDetail && <small><code>{view.phaseDetail}</code></small>}
      </span>

      <div className="slot-card__row"><span>{t("Elapsed")}</span><strong>{formatElapsed(view.elapsedMs)}</strong></div>

      {view.progress.signal === "none" ? (
        <p className="slot-card__row">{t("Progress not available")}</p>
      ) : (
        <ProgressBar progress={view.progress} label={progressLabelOf(view.progress, t)} />
      )}

      <EtaBadge eta={view.eta} />

      <div className="slot-card__row"><span>{t("Worktree")}</span><strong>{t(WORKTREE_LABEL[view.worktree])}</strong></div>

      {view.lease.known && (
        <div className="slot-card__row">
          <span>{t("Heartbeat")}</span>
          <strong>
            {formatAge(view.lease.heartbeatAgeMs)}
            {view.lease.stale ? ` ⚠ ${t("Stale lease")}` : ""}
          </strong>
        </div>
      )}
      {/* Žinomas „reused-lease" defektas: lease'as gali nešti KITOS užduoties vardą, ir tada nei
          trukmė, nei darbo kopija šiam bandymui negalioja. */}
      {view.lease.mismatchedTask && <p className="runtime-explanation">⚠ {t("Lease belongs to another task")}</p>}

      {view.lastError && (
        <div className="slot-card__row">
          <span>{t("Last error")}</span>
          <strong title={`${view.lastError.ts} — ${view.lastError.taskId}`}>{view.lastError.reason}</strong>
        </div>
      )}
      {view.blocked && (
        <p className="runtime-explanation">
          {t("Blocked")}: {view.blocked.reason}
          {view.blocked.detail ? ` — ${view.blocked.detail}` : ""}
        </p>
      )}

      {children}
    </article>
  );
});
