import { memo, useEffect, useState } from "react";
import { DASHBOARD_RELOAD_ACTION } from "../../controller/useDashboardController";
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
import { fetchWaves, rebuildUiBundle, setWorktreePolicyEnabled } from "../../model/api";
import type { LoopWorkerId } from "../../model/types";
import { Badge } from "./Badge";
import { LoopControls } from "./LoopControls";
import { LoopStreamCards } from "./LoopStreamCards";
import { useI18n } from "../../i18n/I18nContext";

type UiRebuildState = "idle" | "running" | "succeeded" | "failed" | "unavailable";

/**
 * W2 lygiagretumo (worktree izoliacijos) politikos būsena ekrane (task 088-c-04).
 *
 * `unknown` NĖRA „išjungta": `/api/waves` lauką praleidžia, kai politikos failo nepavyko
 * perskaityti arba serveris jo dar nesiunčia. Spėjimas čia būtų melas apie tai, ką darys kita
 * banga, tad nežinomybė uždaro jungiklį, o ne piešia jį „off".
 */
type WorktreePolicyState =
  | { kind: "loading" }
  | { kind: "unknown" }
  | { kind: "known"; enabled: boolean; gitignoreOk: boolean | undefined };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Politikos būseną visada pasako `/api/waves` vaizdas — TAS PATS šaltinis, kurį kitą bangą skaitys
 * planuoklė. Mutacijos atsakymas liudytų tik apie įrašytą norą, tad jis čia nedalyvauja.
 */
async function readWorktreePolicy(): Promise<WorktreePolicyState> {
  const policy = (await fetchWaves()).worktree_policy;
  if (policy === undefined) return { kind: "unknown" };
  return { kind: "known", enabled: policy.enabled, gitignoreOk: policy.worktree_gitignore_ok };
}

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
  /**
   * Bundle senumo požymis iš `/api/dashboard` (`bundle_stale`, task 058). NEPRIVALOMAS: senesnis
   * `dist` šio lauko dar nesiunčia, o be jo įspėjimas tiesiog nerodomas — nežinojimas nėra „šviežia".
   */
  bundleStale?: boolean;
};

/** Tuščias rinkinys yra pastovus: naujas `Set` kiekvienam renderiui griautų vaikų `memo` prasmę. */
const NO_PENDING: ReadonlySet<string> = new Set<string>();

const PROCESS_PURPOSE: Record<string, string> = {
  "AG UI": "Local operator interface and live status API.",
  "AG loop": "Processes queued tasks and coordinates execution agents.",
  "User Claude terminal": "Tracks the user-controlled Claude terminal session.",
};

/**
 * Šis procesas neturi „start" veiksmo — jį paleidžia pats vartotojas terminale, ne UI. Kortelė
 * todėl (a) be sesijos gauna paaiškinimą, kad tai stebėjimo, o ne valdymo blokas, ir (b) niekada
 * neturi hover pakėlimo, nes paspaudimas jos niekur neveda.
 */
const CLAUDE_TERMINAL_PROCESS = "User Claude terminal";

function statusDescription(process: RuntimeProcessView): string {
  if (process.name === CLAUDE_TERMINAL_PROCESS && process.status !== "running") {
    return "This block observes a Claude terminal session that you start yourself; none is currently active.";
  }
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
  bundleStale,
}: Props) {
  const { t } = useI18n();
  const [rebuildState, setRebuildState] = useState<UiRebuildState>("idle");
  const [rebuildReason, setRebuildReason] = useState<string | undefined>(undefined);
  const [worktreePolicy, setWorktreePolicy] = useState<WorktreePolicyState>({ kind: "loading" });
  const [worktreeChanging, setWorktreeChanging] = useState(false);
  const [worktreeError, setWorktreeError] = useState<string | undefined>(undefined);

  // VIENAS skaitymas sumontavus, be pollingo: politika keičiasi tik per šį jungiklį, o antras
  // periodinis `/api/waves` skaitytojas reikštų dvi lenktynėse esančias to paties lauko versijas.
  useEffect(() => {
    let active = true;
    void readWorktreePolicy().then(
      (next) => {
        if (active) setWorktreePolicy(next);
      },
      (error: unknown) => {
        if (!active) return;
        setWorktreePolicy({ kind: "unknown" });
        setWorktreeError(errorMessage(error));
      },
    );
    return () => {
      active = false;
    };
  }, []);

  // `bundle_stale` ateina iš tėvo periodinio `/api/dashboard` polling'o (jis JAU vyksta kas 30 s) —
  // antras pollingas ČIA reikštų dvi lenktynėse esančias tiesos versijas tam pačiam laukui. Kai
  // vykstantis perbuild'as pamato, kad tėvas atsiuntė šviežų bundle'ą, tai IR YRA sėkmės įrodymas.
  useEffect(() => {
    if (rebuildState === "running" && bundleStale === false) setRebuildState("succeeded");
  }, [bundleStale, rebuildState]);

  const triggerUiRebuild = () => {
    setRebuildState("running");
    setRebuildReason(undefined);
    void rebuildUiBundle()
      .then((result) => {
        if (result.status === "started" || result.status === "already-running") {
          // „Jau vyksta" NĖRA klaida — tai tas pats vykdomas darbas, kurio operatorius jau paprašė.
          setRebuildState("running");
        } else if (result.status === "disabled") {
          setRebuildState("unavailable");
        } else {
          setRebuildState("failed");
          setRebuildReason(result.reason);
        }
      })
      .catch((error: unknown) => {
        setRebuildState("failed");
        setRebuildReason(error instanceof Error ? error.message : String(error));
      });
  };
  /**
   * Perjungimas ir PO JO — serverio tiesa, ne optimistinis spėjimas.
   *
   * Vaizdas perskaitomas ir po nesėkmės: nepavykusi mutacija galėjo spėti įrašyti konfigą prieš
   * kritdama ties `.gitignore`, tad „liko kaip buvo" būtų spėjimas, o ne serverio pasakytas faktas.
   */
  const toggleWorktreePolicy = () => {
    if (worktreePolicy.kind !== "known" || worktreeChanging) return;
    const next = !worktreePolicy.enabled;
    setWorktreeChanging(true);
    setWorktreeError(undefined);
    void (async () => {
      let failure: string | undefined;
      try {
        await setWorktreePolicyEnabled(next);
      } catch (error) {
        failure = errorMessage(error);
      }
      try {
        setWorktreePolicy(await readWorktreePolicy());
      } catch (error) {
        setWorktreePolicy({ kind: "unknown" });
        failure ??= errorMessage(error);
      }
      setWorktreeError(failure);
      setWorktreeChanging(false);
    })();
  };
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
  // `ui` nematomas PID sekikliui ("unknown" arba visai nerastas) NĖRA "critical": operatorius tuo
  // metu žiūri būtent į šią sąsają, tad jos realaus neveikimo tvirtinti negalima — tai neaiškumas,
  // ne gedimas. "critical" lieka TIK patvirtintam "stopped" signalui.
  const overall =
    ui?.status === "stopped" ? "critical" : unknown.length > 0 || ui === undefined ? "attention" : "healthy";

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
          <span className={`badge ${unknown.length || loopRunState === "stopped" ? "status-warning" : "status-good"}`}>
            {unknown.length + (loopRunState === "stopped" ? 1 : 0)}
          </span>
        </div>
        <div className="system-signal-list">
          {/* Kortelės rodymas IR mygtuko leidimas skaito TĄ PATĮ šaltinį (`loopRunState`) — ne
              kortelė iš `processes`, o mygtukas iš `loopControl`. Du šaltiniai anksčiau reiškė, kad
              nesutapus jiems kortelė kviesdavo veikti su amžinai išjungtu mygtuku be paaiškinimo. */}
          {loopRunState === "stopped" && (
            <article className="system-signal signal-neutral">
              <span className="signal-icon" aria-hidden="true">Ⅱ</span>
              <div>
                <strong>{t("Automation is idle")}</strong>
                <p>{t("VERQESTRA is stopped; queued work will not start automatically.")}</p>
                {/* PID sekiklis dar mato `AG loop` procesą gyvą, nors valdymo failas (VIENINTELIS
                    mygtuko šaltinis) sako „sustabdytas". Paaiškinimas, ne tylus prieštaravimas. */}
                {loop && loop.status !== "unknown" && loop.status !== loopRunState && (
                  <p className="runtime-explanation">
                    {fill(
                      t("The process tracker still reports the loop process as {status}; the control file decides whether start is allowed here."),
                      { status: t(loop.status) },
                    )}
                  </p>
                )}
              </div>
              {/* Tas pats veiksmas kaip ciklo valdymo juostoje: du įėjimo taškai, VIENAS ketinimas,
                  vienas `loop-start` id ir ta pati mygtukų matrica, tad antras paspaudimas nepaleidžia
                  antros užklausos, o abu mygtukai negali skirtingai atsakyti „ar dabar galima paleisti". */}
              {onStartLoop && (
                <button
                  className="button success small-button"
                  type="button"
                  onClick={() => onStartLoop(startStreamCount(workerControl))}
                  disabled={!loopButtons.start.enabled}
                  aria-busy={loopButtons.start.busy || undefined}
                  title={!loopButtons.start.enabled ? t("A loop action is currently in progress; wait for it to finish.") : undefined}
                >
                  {t("Start loop")}
                </button>
              )}
            </article>
          )}
          {unknown.length > 0 && (
            <article className="system-signal signal-warning">
              <span className="signal-icon" aria-hidden="true">!</span>
              <div>
                <strong>{t("Runtime state is unknown")}: {unknown.map((process) => process.name).join(", ")}</strong>
                <p>{t("Refresh the status; if it remains unknown, verify that the PID tracker is connected.")}</p>
              </div>
              {/* VIENAS mygtukas visai sekcijai: kiekvienas nežinomas procesas anksčiau gaudavo savo
                  kopiją, o visos jos kvietė tą patį globalų `reload()` — N kopijų to paties veiksmo. */}
              {onRefresh && (
                <button
                  className="button ghost small-button"
                  type="button"
                  onClick={onRefresh}
                  disabled={pendingActions.has(DASHBOARD_RELOAD_ACTION)}
                  aria-busy={pendingActions.has(DASHBOARD_RELOAD_ACTION) || undefined}
                >
                  {t("Check again")}
                </button>
              )}
            </article>
          )}
          {/* Mygtukas šalia įspėjimo (058-b spec): operatorius sprendžia „senas bundle" akimirksniu,
              o ne ieško jo žemiau esančioje sekcijoje. Abu mygtukai skaito TĄ PATĮ `rebuildState`,
              tad jie negali skirtingai atsakyti „ar dabar vyksta perbuild'as". */}
          {bundleStale === true && (
            <article className="system-signal signal-warning">
              <span className="signal-icon" aria-hidden="true">⟳</span>
              <div>
                <strong>{t("Dashboard bundle is stale")}</strong>
                <p>{t("The dashboard you are viewing is older than its sources.")}</p>
              </div>
              <button
                className="button ghost small-button"
                type="button"
                onClick={triggerUiRebuild}
                disabled={rebuildState === "running"}
                aria-busy={rebuildState === "running" || undefined}
                title={rebuildState === "running" ? t("Rebuild is already running") : undefined}
              >
                {t("Rebuild dashboard")}
              </button>
            </article>
          )}
          {loopRunState !== "stopped" && unknown.length === 0 && bundleStale !== true && (
            <div className="system-all-clear"><span>✓</span><div><strong>{t("No runtime issues detected")}</strong><p>{t("All observable processes report a known state.")}</p></div></div>
          )}
        </div>
      </section>

      {/* Bundle rebuild (task 058) — savarankiškas veiksmas, ne per kontrolerį: šis mygtukas
          POST'ina `/api/ui/rebuild` TIESIOGIAI, kad panelė nepriklausytų nuo eilinio dispatch'o. */}
      <section className="panel" aria-labelledby="system-rebuild-title">
        <div className="panel-header">
          <div>
            <h2 id="system-rebuild-title">{t("Dashboard bundle")}</h2>
            <p className="panel-subtitle">
              {t("Rebuild the UI bundle from the latest source (pnpm --dir ui-app build).")}
            </p>
          </div>
          <button
            className="button ghost small-button"
            type="button"
            onClick={triggerUiRebuild}
            disabled={rebuildState === "running"}
            aria-busy={rebuildState === "running" || undefined}
            title={rebuildState === "running" ? t("Rebuild is already running") : undefined}
          >
            {t("Rebuild dashboard")}
          </button>
        </div>
        {rebuildState === "running" && (
          <p className="runtime-explanation">{t("Rebuild is running in the background; this can take a moment.")}</p>
        )}
        {rebuildState === "succeeded" && (
          <p className="notice" role="status">
            {t("Rebuild finished.")}{" "}
            <button className="button ghost small-button" type="button" onClick={() => window.location.reload()}>
              {t("Reload page")}
            </button>
          </p>
        )}
        {rebuildState === "failed" && (
          <p className="notice notice-error" role="alert">
            {t("Rebuild failed")}
            {rebuildReason ? `: ${rebuildReason}` : ""}
          </p>
        )}
        {rebuildState === "unavailable" && (
          <p className="runtime-explanation">{t("Rebuild is not available in this deployment.")}</p>
        )}
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

      {/* W2 lygiagretumo jungiklis (task 088-c-04) stovi ciklo valdymo zonoje — iškart po juostos,
          kurioje pasirenkamas srautų skaičius: „W2 prašomas" ir „W2 apskritai leidžiamas" yra du
          skirtingi sprendimai, ir antrasis be pirmojo nieko neduoda. Blokas rodomas VISADA (ne kaip
          `loopControl`/`workerControl`), nes politika egzistuoja ir tada, kai ciklas nedirba. */}
      <section className="panel worktree-policy" aria-labelledby="worktree-policy-title">
        <div className="panel-header">
          <div>
            <h2 id="worktree-policy-title">{t("W2 parallelism (worktree)")}</h2>
            <p className="panel-subtitle">
              {t("The change applies from the NEXT wave; it does not stop the wave that is already running.")}
            </p>
          </div>
          <div className="worktree-policy-control">
            <button
              type="button"
              className="button ghost small-button worktree-toggle"
              // `aria-pressed` tik ŽINOMAI būsenai: nepatvirtinta politika su `false` skambėtų kaip
              // „išjungta", nors serveris nieko tokio nesakė.
              aria-pressed={worktreePolicy.kind === "known" ? worktreePolicy.enabled : undefined}
              aria-busy={worktreeChanging || undefined}
              disabled={worktreeChanging || worktreePolicy.kind !== "known"}
              title={
                worktreeChanging
                  ? t("The change is still being applied; wait until the server confirms it.")
                  : worktreePolicy.kind === "loading"
                    ? t("The worktree policy is still being read from the server.")
                    : worktreePolicy.kind !== "known"
                      ? t("The worktree policy state is not confirmed, so it cannot be changed here.")
                      : worktreePolicy.enabled
                        ? t("Click to turn W2 parallelism off — the next wave plans a single stream.")
                        : t("Click to turn W2 parallelism on — the next wave may provision a second worktree.")
              }
              onClick={toggleWorktreePolicy}
            >
              {t("W2 parallelism")}
            </button>
            <span
              className={
                worktreeChanging || worktreePolicy.kind === "loading"
                  ? "badge status-warning worktree-policy-status"
                  : worktreePolicy.kind === "known" && worktreePolicy.enabled
                    ? "badge status-good worktree-policy-status"
                    : "badge status-neutral worktree-policy-status"
              }
              role="status"
            >
              {worktreeChanging
                ? t("Changing")
                : worktreePolicy.kind === "loading"
                  ? t("Reading")
                  : worktreePolicy.kind !== "known"
                    ? t("Unknown")
                    : worktreePolicy.enabled
                      ? t("On")
                      : t("Off")}
            </span>
          </div>
        </div>

        {/* PARENGTIES eilutė: įjungta politika dar nereiškia, kad repozitorija paruošta. Trys
            atsakymai, ne du — „nežinoma" turi savo eilutę ir NIEKADA nevirsta įspėjimu. */}
        {worktreePolicy.kind === "known" && worktreePolicy.enabled && (
          worktreePolicy.gitignoreOk === false ? (
            <p
              className="notice notice-warning"
              role="alert"
              title={t("The project .gitignore does not ignore the worktree directory, so a provisioned worktree shows up as project changes and the wave sees a dirty tree.")}
            >
              ⚠ {t("W2 parallelism is on, but the repository is not ready: .gitignore does not ignore the worktree directory.")}
            </p>
          ) : worktreePolicy.gitignoreOk === true ? (
            <p className="runtime-explanation">
              {t("Ready: .gitignore ignores the worktree directory.")}
            </p>
          ) : (
            <p
              className="runtime-explanation"
              title={t("The server did not report the .gitignore state — either the port is not wired or the file could not be read.")}
            >
              {t("Worktree readiness is unknown: the server did not report the .gitignore state.")}
            </p>
          )
        )}
        {worktreePolicy.kind === "unknown" && (
          <p className="runtime-explanation">
            {t("The worktree policy state could not be read, so the switch stays closed — an unconfirmed state is not the same as off.")}
          </p>
        )}
        {worktreeError !== undefined && (
          <p className="notice notice-error" role="alert">
            {t("Worktree policy change failed")}: {worktreeError}
          </p>
        )}
      </section>

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
          {onRefresh && (
            <button
              className="button ghost small-button"
              type="button"
              onClick={onRefresh}
              disabled={pendingActions.has(DASHBOARD_RELOAD_ACTION)}
              aria-busy={pendingActions.has(DASHBOARD_RELOAD_ACTION) || undefined}
            >
              ↻ {t("Refresh status")}
            </button>
          )}
        </div>
        <div className="runtime-grid">
          {processes.map((process) => (
            <article
              key={process.name}
              className={`runtime-card runtime-${process.status}${process.name === CLAUDE_TERMINAL_PROCESS ? " runtime-card-passive" : ""}`}
            >
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
