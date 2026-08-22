import { memo } from "react";
import type { WorkerControlView } from "../../model/dashboardViewModel";
import { fill } from "../../model/fillTemplate";
import {
  buildLoopControlsView,
  startStreamCount,
  workersActionId,
  type LoopControlsView,
  type LoopRunState,
} from "../../model/loopControlsViewModel";
import { useI18n } from "../../i18n/I18nContext";
import { ConfirmButton } from "./ConfirmButton";

const WORKER_CHOICES = [1, 2] as const;

/** Tuščias rinkinys yra pastovus: naujas `Set` kiekvienam renderiui griautų `memo` prasmę. */
const NO_PENDING: ReadonlySet<string> = new Set<string>();

type Props = {
  loopStatus: LoopRunState;
  /**
   * Jau apskaičiuota mygtukų matrica. Ją paduoda `RuntimePanel`, kad VISAS ekranas (signalo kortelė
   * ir ši juosta) remtųsi vienu skaičiavimu. Nepaduota ji skaičiuojama čia iš to paties `loopStatus`
   * — ta pati gryna funkcija su tais pačiais įėjimais, tad kitokio atsakymo gauti neįmanoma.
   */
  buttons?: LoopControlsView;
  stopRequested?: boolean;
  /** Be jo workerių blokas NErodomas: valdiklio be duomenų nėra ko piešti. */
  workerControl?: WorkerControlView;
  pendingActions?: ReadonlySet<string>;
  onSetWorkers?: (requested: number) => void;
  onStartLoop?: (workers: 1 | 2) => void;
  onStopLoop?: () => void;
  onRestartLoop?: (workers: 1 | 2) => void;
};

/**
 * Ciklo gyvavimo ciklo valdymas VIENOJE vietoje (task 1235): paleisti, sustabdyti, perkrauti ir
 * pasirinkti srautų skaičių.
 *
 * Anksčiau tie patys veiksmai gyveno trijose panelėse (srautų antraštėje, workerių slot'ų antraštėje
 * ir signalų kortelėje), tad tas pats ketinimas turėdavo kelis šeimininkus ir kelias skirtingas
 * `disabled` taisykles. Čia komponentas neturi NEI užklausų, NEI būsenos (išskyrus `ConfirmButton`
 * paruoštą vėliavą): ką galima paspausti, sako gryna `buildLoopControlsView`.
 */
export const LoopControls = memo(function LoopControls({
  loopStatus,
  buttons: providedButtons,
  stopRequested = false,
  workerControl,
  pendingActions = NO_PENDING,
  onSetWorkers,
  onStartLoop,
  onStopLoop,
  onRestartLoop,
}: Props) {
  const { t } = useI18n();
  const streams = startStreamCount(workerControl);
  const buttons =
    providedButtons ??
    buildLoopControlsView({
      status: loopStatus,
      handlers: {
        start: onStartLoop !== undefined,
        stop: onStopLoop !== undefined,
        restart: onRestartLoop !== undefined,
      },
      pending: pendingActions,
    });
  // Vykdomas VIENO workerių skaičiaus prašymas užrakina abu mygtukus: kol serveris neatsakė, kuris
  // skaičius įsigaliojo, antras paspaudimas būtų prašymas spėlioti.
  const workersPending = WORKER_CHOICES.some((count) => pendingActions.has(workersActionId(count)));

  return (
    <section className="panel" aria-labelledby="loop-controls-title">
      <div className="panel-header">
        <div>
          <h2 id="loop-controls-title">{t("Loop controls")}</h2>
          <p className="panel-subtitle">
            {t("Start, stop, and restart the loop, and choose how many streams it may use.")}
          </p>
        </div>
        {workerControl && (
          <div className="segmented-control" aria-label={t("Requested worker slots")}>
            {WORKER_CHOICES.map((count) => (
              <button
                key={count}
                type="button"
                className={workerControl.requested === count ? "active" : ""}
                aria-pressed={workerControl.requested === count}
                aria-busy={pendingActions.has(workersActionId(count)) || undefined}
                disabled={!workerControl.canEdit || !onSetWorkers || workersPending}
                onClick={() => onSetWorkers?.(count)}
              >
                {count}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Sakiniai apie workerių prašymą keliauja KARTU su valdikliu: jie paaiškina būtent šį mygtuką,
          o ne bangos rezultatą, likusį „Workerių slot'ų" panelėje. */}
      {workerControl && (
        <>
          <p className="runtime-explanation">
            {t("Requesting 2 workers does not grant them — every wave re-checks isolation and may reject the second slot.")}
          </p>
          {!workerControl.canEdit && (
            <p className="runtime-explanation">
              {t("Controlled by the AG_MAX_WORKERS environment variable in this UI process; the on-screen control is disabled.")}
            </p>
          )}
          {workerControl.invalid && (
            <p className="runtime-explanation">
              ⚠ {t("The worker request file is unreadable; the loop is using 1 worker.")}
            </p>
          )}
        </>
      )}

      <div className="toolbar">
        <button
          className="button success small-button" type="button"
          disabled={!buttons.start.enabled}
          aria-busy={buttons.start.busy || undefined}
          onClick={() => onStartLoop?.(streams)}
        >
          {fill(t("Start loop ({count} stream(s))"), { count: streams })}
          {buttons.start.busy && <span className="button-spinner" aria-hidden="true" />}
        </button>
        <button
          className="button ghost small-button" type="button"
          disabled={!buttons.stop.enabled}
          aria-busy={buttons.stop.busy || undefined}
          onClick={() => onStopLoop?.()}
        >
          {t("Stop loop")}
          {buttons.stop.busy && <span className="button-spinner" aria-hidden="true" />}
        </button>
        {/* Perkrovimas patvirtinamas dviem paspaudimais: jis SUSTABDO veikiantį orkestratorių, o
            1-as srautas valdo visą ciklą. Paleidimas, stabdymas ir workerių pasirinkimas
            patvirtinimo neturi — jie grįžtami. */}
        <ConfirmButton
          label={t("Restart loop")}
          confirmLabel={t("Confirm restart")}
          cancelLabel={t("Cancel")}
          tone="ghost"
          disabled={!buttons.restart.enabled}
          busy={buttons.restart.busy}
          onConfirm={() => onRestartLoop?.(streams)}
        />
      </div>

      {stopRequested && <p className="runtime-explanation">⏹ {t("Stop requested")}</p>}
      {loopStatus === "unknown" && (
        <p className="runtime-explanation">
          {t("The loop process state is not confirmed. Starting is blocked so a second orchestrator cannot be launched; stopping stays available.")}
        </p>
      )}
    </section>
  );
});
