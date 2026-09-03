import { fill } from "../../../model/fillTemplate";
import type { LoopRunState } from "../../../model/loopControlsViewModel";
import { useI18n } from "../../../i18n/I18nContext";

export type SystemStatusHeroProps = {
  loopRunState: LoopRunState;
  /** Šiuo metu vykdomos užduoties ID (`raw.currentTaskId`); `null`, kai ciklas tarp užduočių. */
  currentTaskId: string | null;
  queueCount: number;
  humanReviewCount: number;
  /** Ta pati leidimo taisyklė kaip Header'io „Paleisti" mygtukas — vienas šaltinis, ne antra kopija. */
  canStartLoop: boolean;
  startLoopBusy: boolean;
  onStartLoop: () => void;
  onGoToReviews: () => void;
};

type HeroState = "running" | "blocked-by-review" | "blocked-by-queue" | "idle" | "unknown";

/**
 * Vienintelė vieta, kur sprendžiama, KODĖL ciklas sustojęs. `humanReviewCount` turi pirmenybę
 * prieš `queueCount`: kai laukia ir sprendimas, ir eilė, paleidimas vis tiek nepajudins užduoties,
 * kurios sprendimas blokuoja — operatoriui pirmiausia reikia atsakyti į TĄ klausimą.
 */
function resolveHeroState(loopRunState: LoopRunState, queueCount: number, humanReviewCount: number): HeroState {
  if (loopRunState === "running") return "running";
  if (loopRunState === "unknown") return "unknown";
  if (humanReviewCount > 0) return "blocked-by-review";
  if (queueCount > 0) return "blocked-by-queue";
  return "idle";
}

const TONE_BY_STATE: Record<HeroState, "live" | "warning" | "neutral"> = {
  running: "live",
  "blocked-by-review": "warning",
  "blocked-by-queue": "warning",
  unknown: "warning",
  idle: "neutral",
};

const HEADLINE_BY_STATE: Record<HeroState, string> = {
  running: "Loop is running",
  "blocked-by-review": "Stopped — waiting on a decision",
  "blocked-by-queue": "Stopped — work is waiting",
  unknown: "Loop state unknown",
  idle: "Stopped — no work queued",
};

/** Vienintelis kontekstinis veiksmas rodomas TIK ten, kur jis realiai pajudina reikalą į priekį. */
export function SystemStatusHero({
  loopRunState,
  currentTaskId,
  queueCount,
  humanReviewCount,
  canStartLoop,
  startLoopBusy,
  onStartLoop,
  onGoToReviews,
}: SystemStatusHeroProps) {
  const { t } = useI18n();
  const state = resolveHeroState(loopRunState, queueCount, humanReviewCount);
  const tone = TONE_BY_STATE[state];

  const body =
    state === "running"
      ? currentTaskId
        ? fill(t("Currently executing {task}."), { task: currentTaskId })
        : t("Between tasks — the loop is running.")
      : state === "blocked-by-review"
        ? fill(t("{count} task(s) need a human decision before the loop can continue."), { count: humanReviewCount })
        : state === "blocked-by-queue"
          ? fill(t("{count} queued task(s) are ready to run."), { count: queueCount })
          : state === "unknown"
            ? t("The control file could not be read; refresh to confirm before starting the loop.")
            : t("The queue is empty; there is nothing for the loop to do.");

  return (
    <section className={`system-status-hero system-status-hero--${tone}`} aria-labelledby="system-status-hero-title">
      <div className="system-status-hero-primary">
        <p className="usage-eyebrow">{t("System status")}</p>
        <h2 id="system-status-hero-title">{t(HEADLINE_BY_STATE[state])}</h2>
        <p>{body}</p>
        {state === "blocked-by-queue" && (
          <button
            className="button success small-button"
            type="button"
            onClick={onStartLoop}
            disabled={!canStartLoop}
            aria-busy={startLoopBusy || undefined}
          >
            {t("Start loop")}
          </button>
        )}
      </div>
      <div className="system-status-hero-stats">
        <div className="system-status-hero-stat">
          <span>{t("In queue")}</span>
          <strong>{queueCount}</strong>
        </div>
        <button className="system-status-hero-stat system-status-hero-stat-link" type="button" onClick={onGoToReviews}>
          <span>{t("Needs review")}</span>
          <strong>{humanReviewCount}</strong>
        </button>
      </div>
    </section>
  );
}
