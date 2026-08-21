/**
 * Targeted repair use case (etalono task 1111).
 *
 * Repair perėjimas yra retry-bounded: `retry-guard` sprendžia, ar dar leidžiamas
 * bandymas, o task-scoped repair prompt'as tampa `error` bucket'o task'o kūnu ir
 * pakartotinai dispatch'inamas per tą pačią kanoninę `dispatch-task` seką (tie patys
 * konteksto, biudžeto ir model routing vartai kaip pirmam bandymui).
 *
 * Task failo kūnas yra ATSTATOMAS, kai dispatch'as vetuojamas dar nepaleidus vykdytojo
 * (etalono task 0058): parkuojama originali užduotis, ne repair šablonas.
 *
 * TIK `redispatched` grąžina vykdymą į verifikacijos ciklą. Kiekviena kita šaka yra
 * terminalinė ir jos perėjimą taiko `run-coordinator.ts` — antras diagnozės pass'as po
 * terminalinės šakos dirbtų su jau perkeltu failu.
 */
import { dispatchTask, type DispatchStage } from "./dispatch-task.js";
import type { TaskRunPorts } from "./run-coordinator-ports.js";
import type { TaskRunState } from "./task-run-state.js";

/** Repair'o infrastruktūros etapas: dispatch'o etapai + retry-guard'as, kuris eina prieš juos. */
export type RepairStage = DispatchStage | "retry-guard";

export type RepairTaskResult =
  | { kind: "redispatched" }
  | { kind: "retry-limit" }
  | { kind: "human-review"; reason: string }
  // `detail` yra tas pats dispatch'o laukas — repair kelias jo negeneruoja, tik persiunčia.
  | { kind: "infrastructure"; stage: RepairStage; exitCode: number; detail?: string };

/**
 * VIENINTELIS `retry-guard` exit kodas, reiškiantis „limitas pasiektas".
 *
 * Retry-guard CLI rašo `process.exitCode = 1` dviem sprendimams (limitas ir trūkstamas
 * task_id), o VISKAS kita — 2 (usage/sugadintas `retry-counts.json`) arba infrastruktūros
 * kodas iš bendro CLI catch-all'o. Iki etalono task 0058 bet koks nenulinis kodas reikšdavo
 * „limitas", tad sugadintas state failas ar užrakintas diskas paleisdavo DESTRUKTYVŲ
 * `rollback-stable` ir parkuodavo nekaltą task'ą.
 */
const RETRY_LIMIT_EXIT_CODE = 1;

/**
 * Sėkmės kelio išimtis, panaudojama NE DAUGIAU kaip kartą per vykdymą.
 *
 * `WeakSet` su `TaskRunState` raktu, o ne `Set<taskId>`: lygiagretūs `processQueuedTask` lane'ai
 * tame pačiame procese turi savo state objektą, tad vienas kito išimties nesuvalgo, o pasibaigęs
 * run'as iš karto tampa surenkamas atmintyje.
 */
const successPathRecheckUsed = new WeakSet<TaskRunState>();

/**
 * Ar tai SĖKMĖS kelias, klaidingai atsidūręs repair šakoje?
 *
 * Etalono task 0003 (incidentas 1228, 2026-08-13): repair sesija praėjo quality gates, diagnozė
 * įrašė `verdict=done`, ir task'as VIS TIEK buvo parkuotas su `task_scoped_repair_prompt_missing=1`
 * — nes `verdict=done` diagnozė repair prompt'ą sąmoningai palieka tuščią („repair nereikalingas"),
 * o verifikacijos ciklas tą praėjimą maršrutizavo pagal PASENUSĮ bandymo sprendimą. Šaknis
 * ištaisyta kompozicijos šaknyje (šviežia bandymo rezoliucija); ŠIS vartas yra fail-safe:
 * trūkstamas APSKAITOS artefaktas vienas pats nebegali paversti sėkmės parkavimu.
 *
 * Sąlygos tyčia siauros ir remiasi ĮRODYMU, ne prielaida:
 *   - sprendimas perskaitomas iš naujo ir turi būti `ok` + `verdict=done`;
 *   - quality gates žali TAME PAČIAME praėjime (`verify-task.ts` ką tik juos paleido);
 *   - vieną kartą per run'ą — kitaip bet koks kitas pasenęs skaitytojas suktų ciklą be pabaigos.
 *
 * Nesėkmės kelias (`verdict=repair`, raudoni gates) nė vienos sąlygos netenkina, tad fail-closed
 * `human-review` ir retry limitas ten lieka nepakitę.
 */
async function isMisroutedSuccess(state: TaskRunState, ports: TaskRunPorts): Promise<boolean> {
  if (state.lastQualityGateExitCode !== 0) return false;
  if (successPathRecheckUsed.has(state)) return false;

  const decision = await ports.state.readDecision(state.taskId);
  if (decision.status !== "ok" || decision.decision.verdict !== "done") return false;

  successPathRecheckUsed.add(state);
  return true;
}

export async function repairTask(state: TaskRunState, ports: TaskRunPorts): Promise<RepairTaskResult> {
  const retryCode = await ports.cli.run(["retry-guard", "--task-id", state.taskId]);
  if (retryCode !== 0) {
    if (retryCode !== RETRY_LIMIT_EXIT_CODE) {
      // Ne limitas, o aplinka: rollback'as čia ištrintų darbą dėl gedimo, kurio task'as nesukėlė.
      await ports.log.write(
        `RETRY GUARD FAILED (infrastructure): task=${state.taskId} exit=${retryCode} rollback_skipped=1`,
      );
      return { kind: "infrastructure", stage: "retry-guard", exitCode: retryCode };
    }

    const rollbackCode = await ports.cli.run(["rollback-stable", "--allow-task-changes", "--task-id", state.taskId]);
    if (rollbackCode !== 0) {
      return { kind: "human-review", reason: `TASK HUMAN REVIEW: ${state.taskId} rollback_failed=${rollbackCode} retry_limit` };
    }
    return { kind: "retry-limit" };
  }

  const repairPrompt = await ports.repairPrompt.read(state.taskId);
  if (!repairPrompt.trim()) {
    if (await isMisroutedSuccess(state, ports)) {
      await ports.log.write(
        `WARNING: repair prompt missing on the success path task=${state.taskId} verdict=done quality_gates=passed ` +
          "— re-verifying instead of parking (task_scoped_repair_prompt_missing not applied)",
      );
      // Grįžtama į verifikacijos ciklą NIEKO nepajudinus: task'as lieka ten, kur buvo, o `done`
      // ir toliau suteikia tik kanoninis `verify-task` kelias su visais savo įrodymais (gates,
      // stop status, commit'ai). Šis vartas jų nepakeičia ir nepraleidžia — jis tik neleidžia
      // trūkstamam apskaitos artefaktui tapti VIENINTELE parkavimo priežastimi.
      return { kind: "redispatched" };
    }
    return { kind: "human-review", reason: `TASK HUMAN REVIEW: ${state.taskId} task_scoped_repair_prompt_missing=1` };
  }

  const repairSourceFile = await state.resolveCurrentTaskFile();
  /**
   * Originalus užduoties tekstas išsaugomas PRIEŠ perrašymą (etalono task 0058, „repair-clobber").
   *
   * Vartai (biudžetas, `decision.json`, adapterio rolė, context-pack) privalo vertinti BŪTENT
   * repair prompt'ą, o `contextPack` priima tik `AG/tasks/<bucket>/` failus — tad prompt'as
   * turi tapti task'o kūnu dar prieš vartus. Anksčiau vetuotas repair'as būdavo parkuojamas
   * su jau sunaikintu originaliu tekstu, ir žmogus nebeturėdavo ko peržiūrėti.
   *
   * Skaitymo klaida čia nėra fatali: tokiu atveju atstatyti nebus ko, bet repair'as vis tiek
   * turi vykti — pats prompt'as niekur nedingsta (`vq/state/repair/<task_id>.md`).
   */
  const originalTaskBody = await ports.tasks.readTaskBody(repairSourceFile).catch(() => undefined);

  const movedErrorFile = await ports.tasks.move(repairSourceFile, "error", state.taskName);
  state.errorFile = state.remember(movedErrorFile);
  await ports.tasks.writeTaskBody(state.errorFile, repairPrompt);
  const fingerprint = await ports.tasks.fingerprint(state.errorFile);
   
  state.fingerprint = fingerprint;
  await ports.ledger.recordState(state.taskId, state.taskName, "error", state.errorFile, state.fingerprint);
  await ports.journal.recordCheckpoint({
    actor: "supervisor",
    phase: "repair",
    status: "waiting",
    task_id: state.taskId,
    task_file: state.errorFile,
    log_file: state.errorFile,
    next_action: "Wait for Claude repair result",
  });
  await ports.log.write(`TASK ERROR/REPAIR IN PROGRESS: ${state.taskId}`);
  await ports.log.write(`TASK REPAIR DELEGATED TO CLAUDE: ${state.taskId}`);

  const dispatched = await dispatchTask(state, ports, {
    promptFile: state.errorFile,
    fromTaskFile: state.errorFile,
    isRepair: true,
  });
  if (dispatched.kind !== "ok") {
    // Biudžeto veto / adapterio draudimas / infrastruktūros gedimas — perduodama
    // koordinatoriui; repair ratas nesikartoja.
    //
    // Vetuota PRIEŠ vykdytoją => sesijos nebuvo, tad repair prompt'as failo kūne yra tik
    // paruošimo artefaktas: jis atstatomas į originalų tekstą, kad į human-review keliautų
    // peržiūrima užduotis, o ne šablonas. Po `claude-dispatch` kilę verdiktai (`preExecution`
    // nėra) failo NELIEČIA — ten prompt'as reikalingas `resumeInterruptedTask` tęsimui.
    if (dispatched.preExecution === true && originalTaskBody !== undefined) {
      await ports.tasks.writeTaskBody(state.errorFile, originalTaskBody);
      state.fingerprint = await ports.tasks.fingerprint(state.errorFile);
      await ports.ledger.recordState(state.taskId, state.taskName, "error", state.errorFile, state.fingerprint);
      await ports.log.write(`TASK REPAIR PROMPT REVERTED (dispatch vetoed before execution): ${state.taskId}`);
    }
    return dispatched;
  }

  await ports.journal.recordCheckpoint({
    actor: "supervisor",
    phase: "post-claude-repair-diagnosis",
    status: "started",
    task_id: state.taskId,
    task_file: state.activeFile,
    log_file: ports.state.logPath("claude-last.log"),
    next_action: "Run quality gates and supervisor diagnosis after repair",
  });
  await ports.log.write(`TASK RETURNED TO ORCHESTRATOR ACTIVE AFTER REPAIR: ${state.taskId}`);
  return { kind: "redispatched" };
}
