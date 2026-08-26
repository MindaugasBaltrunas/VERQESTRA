import { memo } from "react";
import type {
  LoopControlView,
  RuntimeProcessView,
  WorkerControlView,
} from "../../model/dashboardViewModel";
import { fill } from "../../model/fillTemplate";
import {
  buildLoopControlsView,
  startStreamCount,
  type LoopRunState,
} from "../../model/loopControlsViewModel";
import type { SlotProgressView } from "../../model/slotProgressViewModel";
import type { LoopWorkerId } from "../../model/types";
import { Badge } from "./Badge";
import { LoopControls } from "./LoopControls";
import { LoopStreamCards } from "./LoopStreamCards";
import { useI18n } from "../../i18n/I18nContext";

type Props = {
  processes: RuntimeProcessView[];
  root: string;
  /**
   * Ciklo paleidimas. Vienas veiksmas su vienu `loop-start` id, nesvarbu, ar jį paleidžia „Automatika
   * laukia" kortelė, ar ciklo valdymo juosta. Header'io „Paleisti" LIEKA atskiras kelias
   * (`/tasks/resume`) ir į šią suvienodintą schemą sąmoningai neįtrauktas — tai kitas ekranas ir kitas
   * task'as.
   */
  onStartLoop?: (workers: 1 | 2) => void;
  onRefresh?: () => void;
  /**
   * VIENINTELIS atsakymas į klausimą „ar ciklas veikia". Reikšmę skaičiuoja kontroleris
   * (`loopRunStateOf`: valdymo failas, o jo nesant — vykdymo procesai), o panelė jos nebeišvedinėja
   * iš `loopControl.loopStatus`: tas laukas neturi vykdymo procesų atsarginio šaltinio, tad serveriui
   * nesiunčiant `loopControl` bloko (senas `dist`) tame pačiame ekrane stovėdavo AKTYVUS „Paleisti"
   * signalo kortelėje ir IŠJUNGTAS „Paleisti ciklą" valdymo juostoje.
   *
   * Numatytoji reikšmė — `unknown`: nežinomybė uždaro paleidimą, o ne atveria jį.
   */
  loopRunState?: LoopRunState;
  /**
   * Worker slot'ų valdiklis. NEPRIVALOMAS sąmoningai: panelė lieka naudojama ir be jo (senas UI
   * serveris duomenų nesiunčia), o be `onSetWorkers` valdiklis rodomas tik skaitymui.
   */
  workerControl?: WorkerControlView;
  onSetWorkers?: (requested: number) => void;
  /**
   * Srautų (loop slot'ų) gyvavimo ciklas — task 0052. NEPRIVALOMAS dėl tos pačios priežasties kaip
   * `workerControl`; be veiksmų handler'ių blokas lieka tik skaitymui, o ne su negyvais mygtukais.
   */
  loopControl?: LoopControlView;
  onStopSlot?: (workerId: LoopWorkerId) => void;
  onResumeSlot?: (workerId: LoopWorkerId) => void;
  onAbortSlot?: (workerId: LoopWorkerId) => void;
  onStopLoop?: () => void;
  onRestartLoop?: (workers: 1 | 2) => void;
  /**
   * Srautų progreso rodinys (task 1233). NEPRIVALOMAS: be jo srautų kortelės lieka tokios, kokios
   * buvo — progresas yra papildomas sluoksnis, o ne nauja panelės prielaida.
   */
  slotProgress?: readonly SlotProgressView[];
  /** Vykdomų veiksmų id (task 1235) — mygtukai iš jų gauna `disabled`/`aria-busy`. */
  pendingActions?: ReadonlySet<string>;
  fixableTaskIds?: ReadonlySet<string>;
  onFixTask?: (taskId: string) => void;
};

/** Tuščias rinkinys yra pastovus: naujas `Set` kiekvienam renderiui griautų vaikų `memo` prasmę. */
const NO_PENDING: ReadonlySet<string> = new Set<string>();

const PROCESS_PURPOSE: Record<string, string> = {
  "AG UI": "Local operator interface and live status API.",
  "AG loop": "Processes queued tasks and coordinates execution agents.",
  "User Claude terminal": "Tracks the user-controlled Claude terminal session.",
};

function statusDescription(process: RuntimeProcessView): string {
  if (process.status === "running") return "Process is available and responding.";
  if (process.status === "stopped") return "Process is not running.";
  return "The process state could not be confirmed.";
}

export const RuntimePanel = memo(function RuntimePanel({
  processes,
  root,
  onStartLoop,
  onRefresh,
  loopRunState = "unknown",
  workerControl,
  onSetWorkers,
  loopControl,
  onStopSlot,
  onResumeSlot,
  onAbortSlot,
  onStopLoop,
  onRestartLoop,
  slotProgress,
  pendingActions = NO_PENDING,
  fixableTaskIds,
  onFixTask,
}: Props) {
  const { t } = useI18n();
  // Ciklo mygtukų matrica skaičiuojama VIENĄ kartą ir maitina abu ekrano įėjimo taškus: „Automatika
  // laukia" kortelę ir ciklo valdymo juostą. Du skaičiavimai reikštų du atsakymus tam pačiam
  // klausimui — būtent tai ir buvo 1235 review radinys.
  const loopButtons = buildLoopControlsView({
    status: loopRunState,
    handlers: {
      start: onStartLoop !== undefined,
      stop: onStopLoop !== undefined,
      restart: onRestartLoop !== undefined,
    },
    pending: pendingActions,
  });
  const running = processes.filter((process) => process.status === "running").length;
  const known = processes.filter((process) => process.status !== "unknown").length;
  const ui = processes.find((process) => process.name === "AG UI");
  const loop = processes.find((process) => process.name === "AG loop");
  const unknown = processes.filter((process) => process.status === "unknown");
  const overall = ui?.status !== "running" ? "critical" : unknown.length > 0 ? "attention" : "healthy";

  return (
    <div className="system-console">
      <section className={`system-health-hero system-health-${overall}`} aria-labelledby="system-health-title">
        <div>
          <p className="usage-eyebrow">{t("Overall status")}</p>
          {/* ANTRAŠTĖ ĮVARDIJA SAVO DALYKĄ, o ne „sistemą". `overall` remiasi TIK dviem faktais:
              ar veikia UI procesas ir ar nėra `unknown` būsenų. Sustabdytas ciklas į verdiktą
              NEĮEINA — todėl „Sistema veikia" šalia „Ciklas: sustabdytas" ir „1/3" skambėjo kaip
              prieštaravimas, nors abu teiginiai teisingi.

              Pirmas taisymas (dešimtas ratas) pakeitė tik SAKINĮ po antrašte; operatorius tą patį
              konfliktą pamatė vėl, nes skaitomas dydis ekrane yra H2. „Valdymo sąsaja pasiekiama"
              ir „Ciklas: sustabdytas" viena kitai neprieštarauja — tai du skirtingi dalykai, ir
              dabar taip ir pavadinti. */}
          <h2 id="system-health-title">{t(overall === "healthy" ? "Operator interface available" : overall === "attention" ? "Runtime state is incomplete" : "Operator interface unavailable")}</h2>
          <p>{t(overall === "healthy"
            ? "The operator interface is available and every component reported a definite state."
            : overall === "attention"
              ? "Core services are available, but some runtime state is not confirmed."
              : "The operator interface runtime is not confirmed as available.")}</p>
        </div>
        <div className="system-health-metrics">
          {/* Ciklo būsena rodoma ATSKIRAI, nes ji yra vienintelė, kurios operatorius klausia.
              Be jos `1/3` skaitosi kaip gedimas, nors sustabdytas ciklas ir nedirbantis
              vartotojo terminalas yra visiškai normalios būsenos: trys procesai NĖRA lygiaverčiai,
              ir jų sudėjimas į vieną santykį sulygina tai, kas nesulyginama. */}
          <div>
            <span>{t("Loop")}</span>
            <strong>{t(loop?.status === "running" ? "running" : loop?.status === "stopped" ? "stopped" : "unknown")}</strong>
          </div>
          <div><span>{t("Running")}</span><strong>{running} / {processes.length}</strong></div>
          <div><span>{t("State visibility")}</span><strong>{known} / {processes.length}</strong></div>
        </div>
      </section>

      <section className="panel" aria-labelledby="system-signals-title">
        <div className="panel-header">
          <div>
            <h2 id="system-signals-title">{t("Attention signals")}</h2>
            <p className="panel-subtitle">{t("Human-readable runtime findings and the next useful action")}</p>
          </div>
          <span className={`badge ${unknown.length || loop?.status === "stopped" ? "status-warning" : "status-good"}`}>
            {unknown.length + (loop?.status === "stopped" ? 1 : 0)}
          </span>
        </div>
        <div className="system-signal-list">
          {loop?.status === "stopped" && (
            <article className="system-signal signal-neutral">
              <span className="signal-icon" aria-hidden="true">Ⅱ</span>
              <div><strong>{t("Automation is idle")}</strong><p>{t("VERQESTRA is stopped; queued work will not start automatically.")}</p></div>
              {/* Tas pats veiksmas kaip ciklo valdymo juostoje: du įėjimo taškai, VIENAS ketinimas,
                  vienas `loop-start` id ir ta pati mygtukų matrica, tad antras paspaudimas nepaleidžia
                  antros užklausos, o abu mygtukai negali skirtingai atsakyti „ar dabar galima paleisti". */}
              {onStartLoop && <button className="button success small-button" type="button" onClick={() => onStartLoop(startStreamCount(workerControl))} disabled={!loopButtons.start.enabled} aria-busy={loopButtons.start.busy || undefined}>{t("Start loop")}</button>}
            </article>
          )}
          {unknown.map((process) => (
            <article className="system-signal signal-warning" key={process.name}>
              <span className="signal-icon" aria-hidden="true">!</span>
              <div><strong>{t("Runtime state is unknown")}: {process.name}</strong><p>{t("Refresh the status; if it remains unknown, verify that the PID tracker is connected.")}</p></div>
              {onRefresh && <button className="button ghost small-button" type="button" onClick={onRefresh}>{t("Check again")}</button>}
            </article>
          ))}
          {loop?.status !== "stopped" && unknown.length === 0 && (
            <div className="system-all-clear"><span>✓</span><div><strong>{t("No runtime issues detected")}</strong><p>{t("All observable processes report a known state.")}</p></div></div>
          )}
        </div>
      </section>

      {/* Ciklo valdymas (task 1235) stovi PRIEŠ srautus: pirma sprendimas „ar ciklas apskritai veikia
          ir su keliais srautais", tik paskui atskirų srautų būsena. Blokas yra PAPILDOMAS — be abiejų
          duomenų šaltinių jo nėra. */}
      {(loopControl || workerControl) && (
        <LoopControls
          loopStatus={loopRunState}
          buttons={loopButtons}
          stopRequested={loopControl?.stopRequested ?? false}
          workerControl={workerControl}
          pendingActions={pendingActions}
          onSetWorkers={onSetWorkers}
          onStartLoop={onStartLoop}
          onStopLoop={onStopLoop}
          onRestartLoop={onRestartLoop}
        />
      )}

      {/* Srautų blokas gyvena savo komponente (task 1233): panelė lieka vykdymo aplinkos suvestinė,
          o srautų gyvavimo ciklas — vienas, jam skirtas failas. */}
      {loopControl && (
        <LoopStreamCards
          loopControl={loopControl}
          onStopSlot={onStopSlot}
          onResumeSlot={onResumeSlot}
          onAbortSlot={onAbortSlot}
          slotProgress={slotProgress}
          fixableTaskIds={fixableTaskIds}
          onFixTask={onFixTask}
          pendingActions={pendingActions}
        />
      )}

      {workerControl && (
        <section className="panel" aria-labelledby="worker-slots-title">
          <div className="panel-header">
            <div>
              <h2 id="worker-slots-title">{t("Worker slots")}</h2>
              {/* Panelė nebeturi valdiklio (jis persikėlė į „Ciklo valdymą"), tad ir antraštė kalba
                  apie tai, kas čia LIKO: bangos rezultatą, o ne apie prašymą. */}
              <p className="panel-subtitle">
                {t("What the last wave actually granted, and why any slot was rejected.")}
              </p>
            </div>
          </div>
          {workerControl.lastWaveKnown ? (
            <>
              <p className="runtime-explanation">
                {fill(t("Last wave: granted {granted} of {requested} requested (limit {max})."), {
                  granted: workerControl.granted,
                  requested: workerControl.grantedOf,
                  max: workerControl.max,
                })}
              </p>
              {workerControl.rejected.length > 0 && (
                <ul className="system-signal-list">
                  {workerControl.rejected.map((rejection) => (
                    <li key={`${rejection.taskId}-${rejection.reason}`}>
                      <code>{rejection.taskId}</code> {rejection.reason}
                      {rejection.detail ? ` — ${rejection.detail}` : ""}
                    </li>
                  ))}
                </ul>
              )}
            </>
          ) : (
            <p className="runtime-explanation">{t("No wave has planned a worker pool yet.")}</p>
          )}
        </section>
      )}

      <section className="panel" aria-labelledby="runtime-processes-title">
        <div className="panel-header">
          <div>
            <h2 id="runtime-processes-title">{t("Runtime processes")}</h2>
            <p className="panel-subtitle">{t("Availability, purpose, and process identity")}</p>
          </div>
          {onRefresh && <button className="button ghost small-button" type="button" onClick={onRefresh}>↻ {t("Refresh status")}</button>}
        </div>
        <div className="runtime-grid">
          {processes.map((process) => (
            <article key={process.name} className={`runtime-card runtime-${process.status}`}>
              <div className="runtime-card-top">
                <div><h3>{process.name}</h3><p>{t(PROCESS_PURPOSE[process.name] ?? "Runtime process")}</p></div>
                <Badge text={t(process.status)} variant={process.variant} />
              </div>
              <p className="runtime-explanation">{t(statusDescription(process))}</p>
              <div className="runtime-detail"><span>{t("Process identity")}</span><code>{process.detail}</code></div>
            </article>
          ))}
        </div>
      </section>

      <section className="panel system-project-card" aria-labelledby="system-project-title">
        <div>
          <p className="usage-eyebrow">{t("Runtime context")}</p>
          <h2 id="system-project-title">{t("Connected project")}</h2>
          <p>{t("The repository currently controlled by this VERQESTRA instance.")}</p>
        </div>
        <code>{root}</code>
      </section>
    </div>
  );
});
