import { memo } from "react";
import type { WorkerControlView } from "../../../model/dashboardViewModel";
import { fill } from "../../../model/fillTemplate";
import {
  buildLoopControlsView,
  LOOP_RESTART_ACTION,
  LOOP_START_ACTION,
  LOOP_STOP_ACTION,
  startStreamCount,
  workerChoices,
  workersActionId,
  type LoopButtonView,
  type LoopControlsView,
  type LoopRunState,
} from "../../../model/loopControlsViewModel";
import { useI18n } from "../../../i18n/I18nContext";
import { ConfirmButton } from "../shared/ConfirmButton";

/**
 * Du AIŠKŪS mygtukai vietoje skaičių jungiklio (operatoriaus 2026-08-26 prašymas: „1|2" atrodė
 * kaip kiekis, o ne kaip W1/W2 paleidimas — w2 slot'o `run` niekur nevedė, nes prašymas liko 1).
 * W1 yra bazinis srautas: jis „paspaustas" visada, o jo paspaudimas reiškia „palikti tik W1".
 * W2 yra perjungiklis: paspaudimas įjungia antrą srautą (requested=2) arba jį atleidžia (1).
 */

/** Tuščias rinkinys yra pastovus: naujas `Set` kiekvienam renderiui griautų `memo` prasmę. */
const NO_PENDING: ReadonlySet<string> = new Set<string>();

function anyLoopActionPending(pending: ReadonlySet<string>): boolean {
  return pending.has(LOOP_START_ACTION) || pending.has(LOOP_STOP_ACTION) || pending.has(LOOP_RESTART_ACTION);
}

/** Bendra „kodėl neaktyvus" priežastis, kai KITAS iš trijų ciklo veiksmų dar vyksta. */
function pendingReason(t: (text: string) => string): string {
  return t("A loop action is currently in progress; wait for it to finish.");
}

function startDisabledReason(t: (text: string) => string, status: LoopRunState, pending: boolean): string {
  if (pending) return pendingReason(t);
  if (status === "running") return t("The loop is already running.");
  return t("Starting is blocked while the loop state is unconfirmed.");
}

function stopDisabledReason(t: (text: string) => string, pending: boolean): string {
  if (pending) return pendingReason(t);
  return t("The loop is already stopped.");
}

function restartDisabledReason(t: (text: string) => string, pending: boolean): string {
  if (pending) return pendingReason(t);
  return t("Restart requires the loop to be running.");
}

type LoopActionButtonProps = {
  label: string;
  toneClassName: string;
  button: LoopButtonView;
  disabledReason: string;
  /** Pasekmės sakinys — VISADA matomas, ne tik `hover`, kad paaiškinimas nepriklausytų nuo pelės. */
  subtext?: string;
  onClick: () => void;
};

/**
 * Vienas šablonas visiems trims ciklo mygtukams (task 059-d): tas pats išjungimo `title`
 * skaičiavimas ir ta pati subteksto vieta, kad kiekvienas mygtukas atsakytų į „kodėl neaktyvus"
 * ir „kokia pasekmė" vienodai, o ne kaskart iš naujo išgalvota.
 */
function LoopActionButton({ label, toneClassName, button, disabledReason, subtext, onClick }: LoopActionButtonProps) {
  return (
    <div className="loop-action">
      <button
        className={toneClassName} type="button"
        disabled={!button.enabled}
        aria-busy={button.busy || undefined}
        title={!button.enabled ? disabledReason : undefined}
        onClick={onClick}
      >
        {label}
        {button.busy && <span className="button-spinner" aria-hidden="true" />}
      </button>
      {subtext && <p className="runtime-explanation">{subtext}</p>}
    </div>
  );
}

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
  // Bendra priežastis visiems trims: kol vienas iš trijų ciklo veiksmų dar vyksta, likę du yra
  // uždaryti dėl TOS PAČIOS priežasties, o ne dėl savo statuso.
  const anyPending = anyLoopActionPending(pendingActions);
  // Vykdomas VIENO workerių skaičiaus prašymas užrakina abu mygtukus: kol serveris neatsakė, kuris
  // skaičius įsigaliojo, antras paspaudimas būtų prašymas spėlioti.
  const choices = workerChoices(workerControl);
  const workersPending = choices.some((choice) => pendingActions.has(workersActionId(choice.count)));
  const w1Available = choices.find((choice) => choice.count === 1)?.available ?? true;
  const w2Available = choices.find((choice) => choice.count === 2)?.available ?? true;

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
            <button
              type="button"
              className="active"
              aria-pressed="true"
              title={
                !workerControl.canEdit
                  ? t("Controlled by the AG_MAX_WORKERS environment variable in this UI process; the on-screen control is disabled.")
                  : !w1Available
                    ? fill(t("This worker count is unavailable: the environment limits this loop to {max} worker(s)."), {
                        max: workerControl.max,
                      })
                    : t("The base stream — always on while the loop runs. Click to keep only W1.")
              }
              aria-busy={pendingActions.has(workersActionId(1)) || undefined}
              disabled={!workerControl.canEdit || !onSetWorkers || workersPending || !w1Available}
              onClick={() => onSetWorkers?.(1)}
            >
              W1
            </button>
            <button
              type="button"
              className={workerControl.requested >= 2 ? "active" : ""}
              aria-pressed={workerControl.requested >= 2}
              title={
                !workerControl.canEdit
                  ? t("Controlled by the AG_MAX_WORKERS environment variable in this UI process; the on-screen control is disabled.")
                  : workerControl.requested >= 2
                    ? t("Click to release W2 — it stops after its current task.")
                    : !w2Available
                      ? fill(t("This worker count is unavailable: the environment limits this loop to {max} worker(s)."), {
                          max: workerControl.max,
                        })
                      : t("Click to start W2 — the loop picks it up on the next wave.")
              }
              aria-busy={pendingActions.has(workersActionId(workerControl.requested >= 2 ? 1 : 2)) || undefined}
              disabled={
                !workerControl.canEdit ||
                !onSetWorkers ||
                workersPending ||
                (workerControl.requested < 2 && !w2Available)
              }
              onClick={() => onSetWorkers?.(workerControl.requested >= 2 ? 1 : 2)}
            >
              W2
            </button>
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

      <div className="loop-toolbar">
        <LoopActionButton
          label={fill(t("Start loop ({count} stream(s))"), { count: streams })}
          toneClassName="button success small-button"
          button={buttons.start}
          disabledReason={startDisabledReason(t, loopStatus, anyPending)}
          onClick={() => onStartLoop?.(streams)}
        />
        <LoopActionButton
          label={t("Stop loop")}
          toneClassName="button ghost small-button"
          button={buttons.stop}
          disabledReason={stopDisabledReason(t, anyPending)}
          subtext={t("Stopping does not force-kill the loop — the running task finishes first, then the loop stops.")}
          onClick={() => onStopLoop?.()}
        />
        {/* Perkrovimas patvirtinamas dviem paspaudimais: jis SUSTABDO veikiantį orkestratorių, o
            1-as srautas valdo visą ciklą. Paleidimas, stabdymas ir workerių pasirinkimas
            patvirtinimo neturi — jie grįžtami. */}
        <div className="loop-action">
          <ConfirmButton
            label={t("Restart loop")}
            confirmLabel={t("Confirm restart")}
            cancelLabel={t("Cancel")}
            tone="ghost"
            disabled={!buttons.restart.enabled}
            busy={buttons.restart.busy}
            title={restartDisabledReason(t, anyPending)}
            onConfirm={() => onRestartLoop?.(streams)}
          />
        </div>
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
