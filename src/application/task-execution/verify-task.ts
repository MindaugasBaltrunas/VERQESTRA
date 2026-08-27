/**
 * Verification use case (etalono task 1111).
 *
 * Vienas verifikacijos pass'as: quality gates -> supervisor diagnozė -> verdikto ir
 * darbo įrodymų klasifikacija. Rezultatas yra deskriptorius; ciklą suka ir terminalinį
 * perėjimą taiko `run-coordinator.ts`, todėl čia nėra nė vieno bucket perėjimo,
 * `markStable` ar priklausomybių kaskados kvietimo.
 */
import type {
  AlreadyImplementedVia,
  StopStatusSnapshot,
  TaskDecision,
  TaskRunPorts,
} from "./run-coordinator-ports.js";
import { decisionInvalidMarker } from "./run-coordinator-ports.js";
import type { TaskRunState } from "./task-run-state.js";

export type VerifyTaskResult =
  | { kind: "done" }
  /** `skip-dispatch` čia nepasiekiamas: pre-dispatch vartai nutinka anksčiau už verifikaciją. */
  | { kind: "done-already-implemented"; via: Exclude<AlreadyImplementedVia, "skip-dispatch"> }
  | { kind: "human-review"; reason: string }
  | { kind: "rollback-human-review"; decision: TaskDecision }
  | { kind: "repair" }
  | { kind: "infrastructure"; stage: "quality-gates" | "diagnose"; exitCode: number };

export async function verifyTask(
  state: TaskRunState,
  ports: TaskRunPorts,
  options: { diagnoseCmd: string },
): Promise<VerifyTaskResult> {
  const qualityGateExit = await ports.cli.run(["quality-gates"]);
  state.lastQualityGateExitCode = qualityGateExit;
  // Etalono task 0053: vartų komanda gali kristi ne dėl kodo, o dėl aplinkos (pasenęs dist = 78,
  // užrakintas failas = 74, usage limitas = 75, timeout = 124). Tokia baigtis nieko nesako apie
  // task'ą, tad ji nebegali virsti `quality_gates_failed=<kodas>` parku į human-review —
  // kiekvienas eilės task'as kristų lygiai taip pat. Nutraukiama PRIEŠ diagnozę, kad sugedusi
  // aplinka nedegintų dar vieno LLM kvietimo.
  if (qualityGateExit !== 0 && ports.failure.isInfrastructureExit(qualityGateExit)) {
    await ports.journal.recordPhaseFailure(state.taskId, "quality-gates", qualityGateExit, "");
    return { kind: "infrastructure", stage: "quality-gates", exitCode: qualityGateExit };
  }

  const diagnose = await ports.cli.runCaptured([options.diagnoseCmd, state.activeFile]);
  if (diagnose.code !== 0) {
    await ports.journal.recordPhaseFailure(state.taskId, "diagnose", diagnose.code, diagnose.output);
    if (ports.failure.isInfrastructureExit(diagnose.code)) {
      return { kind: "infrastructure", stage: "diagnose", exitCode: diagnose.code };
    }
    return { kind: "human-review", reason: `TASK HUMAN REVIEW: ${state.taskId} supervisor_diagnose_failed=${diagnose.code}` };
  }

  const decisionResult = await ports.state.readDecision(state.taskId);
  if (decisionResult.status === "invalid") {
    return { kind: "human-review", reason: `TASK HUMAN REVIEW: ${state.taskId} ${decisionInvalidMarker(decisionResult)}` };
  }

  const decision = decisionResult.decision;
  if (decision.verdict === "done") {
    return await classifyDoneVerdict(state, ports);
  }
  if (decision.verdict === "repair") {
    return { kind: "repair" };
  }
  if (decision.verdict === "rollback_stop" || decision.verdict === "human_review") {
    return { kind: "rollback-human-review", decision };
  }

  await ports.log.write(
    `WARNING: unknown or missing verdict in decision.json: "${decision.verdict ?? ""}" task=${state.taskId}`,
  );
  return { kind: "human-review", reason: `UNKNOWN DIAGNOSIS VERDICT: ${decision.verdict ?? ""} task=${state.taskId}` };
}

/**
 * Stop įrodymo kilmė iš `RuntimeStatePort.readStopStatus()` momentinės nuotraukos.
 *
 * `StopStatusSnapshot` kontraktas šio lauko dar neskelbia — jį galės pridėti tik port'o
 * savininkas. Todėl skaitoma struktūriškai ir konservatyviai: be aiškaus `source: "attempt"`
 * antspaudo įrodymas laikomas legacy, tad F7 vartai lieka galioti lygiai kaip iki šiol. Kai
 * adapteris pradės žymėti kilmę, attempt šaka įsijungs be jokio kito pakeitimo šiame faile.
 */
function stopEvidenceOrigin(snapshot: StopStatusSnapshot): "attempt" | "legacy" {
  return (snapshot as { source?: unknown }).source === "attempt" ? "attempt" : "legacy";
}

/**
 * „done" verdiktas dar nėra užbaigimas — jis tikrinamas prieš nepriklausomus įrodymus:
 * quality gates, Claude stop status, ir realų produkto pakeitimų pėdsaką.
 */
async function classifyDoneVerdict(state: TaskRunState, ports: TaskRunPorts): Promise<VerifyTaskResult> {
  if (state.lastQualityGateExitCode !== 0) {
    return {
      kind: "human-review",
      reason: `TASK NOT DONE: ${state.taskId} quality_gates_failed=${state.lastQualityGateExitCode ?? "unknown"}`,
    };
  }

  const stopStatusResult = await ports.state.readStopStatus();
  if (stopStatusResult.status === "corrupted") {
    await ports.log.write(
      `WARNING: korumpuotas claude-stop-status.json task=${state.taskId}: ${stopStatusResult.error}`,
    );
    return { kind: "human-review", reason: `TASK NOT DONE: ${state.taskId} stop_status_corrupted=1` };
  }

  const stopStatus = stopStatusResult.value;
  // F7: kito task'o antspaudu pažymėtas stop status yra svetimas įrodymas — juo negalima
  // nei suteikti, nei blokuoti šio task'o „done" verdikto. Trūkstamas `task_id`
  // (pre-hardening failas) svetimu nelaikomas dėl backward compatibility.
  //
  // Etalono task 0042: vartai taikomi TIK legacy kilmės įrodymui. Attempt-scoped
  // `stop-state.json` tapatybę jau įrodė manifestas (svetimas bandymas saugykloje yra
  // `identity-mismatch` ir nieko negrąžina), tad `task_id` palyginimas ten nieko neprideda.
  // Kol RuntimeStatePort kilmės nepraneša, numatytoji prielaida yra `legacy` — griežtesnė pusė.
  const stopStatusForeign =
    stopEvidenceOrigin(stopStatus) === "legacy" &&
    stopStatus.task_id !== undefined &&
    stopStatus.task_id !== state.taskId;
  if (stopStatusForeign) {
    await ports.log.write(
      `WARNING: foreign claude-stop-status.json task=${state.taskId} status_task_id=${stopStatus.task_id} — ignoring stale stop status`,
    );
  }
  if (!stopStatusForeign && stopStatus.status === "error") {
    return { kind: "human-review", reason: `TASK NOT DONE: ${state.taskId} stop_status=error` };
  }

  const isRepo = await ports.git.isRepository();
  // Etalono task 1076: vien HEAD pajudėjimas NĖRA darbo įrodymas — stop hook'o lifecycle
  // commit'as dispatch lange uždarydavo taską kaip done be jokio deliverable. Done leidžiamas
  // tik kai commit'ai nuo baseHead liečia PRODUKTO kelius.
  const headAdvanced = isRepo && (await ports.git.hasNewHeadSince(state.baseHead));
  const productCommitted =
    headAdvanced &&
    state.baseHead !== undefined &&
    (await ports.git.changedProductPathsSince(state.baseHead)).length > 0;
  if (productCommitted) {
    return { kind: "done" };
  }

  // Jau įgyvendinta užduotis neturi ko commitinti — tai sėkmė, ne klaida. Du signalai tą
  // patvirtina (šiame taške gates jau žali ir stop != error):
  //   1) vykdytojas parašė ALREADY_IMPLEMENTED markerį, arba
  //   2) medis švarus nuo PRODUKTO pakeitimų IR deliverable matomas branch istorijoje.
  // RT-08: ne-git projekte `git status` visada tuščias, todėl purviną būseną atstoja
  // `logs/changes.log` pagrindu surinkti pakeitimai, o work evidence netaikoma.
  const claudeLog = await ports.state.readClaudeLog(state.taskId);
  const hasMarker = ports.rules.hasAlreadyImplementedMarker(claudeLog);
  const writeActivity = ports.rules.readExecutorWriteActivity(claudeLog);
  const productDirtyCount = isRepo ? await ports.git.productDirtyCount() : await ports.git.recordedChangeCount();
  const noCommitInputs = {
    hasAlreadyImplementedMarker: hasMarker,
    productDirtyCount,
    // Etalono task 890: švarus medis uždaro task'ą kaip done tik su įrodymu, kad deliverable
    // užcommitintas; be jo (pvz. darbas atsuktas rollback'u) task'as eina į human-review.
    //
    // 2026-08-14 false-done epidemija: įrodymu čia buvo laikomas BET KOKS lango commit'as su
    // task id žinutėje (`committedWorkShaFor`), o loop'o paties bookkeeping commit'ai
    // (`chore(AG/tasks): <id>.md`, openspec auto-docs) task id neša failų KELIUOSE — tuščias
    // run'as užsidarydavo kaip done. Įrodymas dabar reikalauja PRODUKTO kelių diff'e (ta pati
    // taisyklė kaip pre-dispatch skip vartuose, etalono task 1187): bookkeeping commit'ai
    // praleidžiami, ne sertifikuojami.
    hasWorkEvidence: isRepo ? Boolean(await ports.git.committedProductWorkShaFor(state.taskId)) : true,
    // Task 032: rašymo-įrankio aktyvumas naudojamas TIK human-review priežasties eilutei
    // (`resolveNoCommitReviewReason`) — disposition (done/rollback/human-review) šio lauko
    // nekeičia.
    writeActivity,
  };
  const disposition = ports.rules.resolveNoCommitDisposition(noCommitInputs);
  if (disposition === "done") {
    return { kind: "done-already-implemented", via: hasMarker ? "marker" : "clean-tree" };
  }

  // `rollback` (necommit'intas produkto darbas) arba `human-review` (švarus medis be
  // įrodymo). Task-scoped rollback yra no-op jau švariam medžiui, tad abi šakos saugiai
  // parkuojamos po scope atstatymo.
  //
  // `runCaptured` (o ne `run`) — 021-c-04: rollback CLI, kai išsaugo necommit'intą turinį
  // prieš atstatymą, atspausdina kanoninę `ROLLBACK PRESERVED: … ref=<ref> …` eilutę į
  // stdout (021 design C2/C3). Ta eilutė yra vienintelis būdas priežastyje pasakyti
  // operatoriui, kur guli darbas — be jos „TASK NOT DONE" atrodo kaip darbo praradimas.
  const rollback = await ports.cli.runCaptured(["rollback-stable", "--allow-task-changes", "--task-id", state.taskId]);
  if (rollback.code !== 0) {
    return { kind: "human-review", reason: `TASK HUMAN REVIEW: ${state.taskId} rollback_failed=${rollback.code} missing_commit` };
  }

  const noCompletionSignalReason =
    disposition === "human-review"
      ? ports.rules.resolveNoCommitReviewReason(noCommitInputs)
      : isRepo
        ? "Claude did not create a new commit"
        : "no verified product changes (non-git project)";
  const preservedRef = /^ROLLBACK PRESERVED: .*\bref=(\S+)/m.exec(rollback.output)?.[1];
  const preservedSuffix = preservedRef === undefined ? "" : ` preserved_work=${preservedRef}`;
  return { kind: "human-review", reason: `TASK NOT DONE: ${state.taskId} ${noCompletionSignalReason}${preservedSuffix}` };
}
