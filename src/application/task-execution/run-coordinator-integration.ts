/**
 * Integracijos vartai ir IVER-3 peržiūra kanoniniame vykdymo kelyje (VQ-304 2/3 skaidymo dalis).
 *
 * Terminalinis human-review perėjimas eina per tą patį `applyTerminal` sprendėją, kaip ir
 * kiekvienas kitas — integracija negauna savo lygiagretaus terminalinio kelio.
 */
import { POLICY_CONFIG_INVALID_EXIT_CODE } from "../../shared/exit-codes.js";
import { isPolicyConfigError } from "../../shared/errors.js";
import { isContractBearingPath } from "../integration/contract-paths.js";
import { evaluateIntegrationRisk } from "../integration/evaluate-integration-risk.js";
import { collectTaskIntegrationEvidence, summarizeTaskIntegrationEvidence } from "../integration/task-integration-evidence.js";
import { conflictForIntegrationRepair, createIntegrationRepair } from "../integration/create-integration-repair.js";
import { reviewIntegration, type IntegrationReviewScope } from "../integration/review-integration.js";
import type { IntegrationEnforcementMode } from "../integration/wave-gates-schema.js";
import type { IntegrationRunRequest, IntegrationRunResult, TaskRunPorts } from "./run-coordinator-ports.js";
import { createTaskRunState, type TaskRunState } from "./task-run-state.js";
import { applyTerminal } from "./run-coordinator-terminal.js";
import type { IntegrationGateOutcome } from "./run-coordinator-model.js";

/**
 * Etalono task 0045 — integracijos vartai kanoniniame done kelyje.
 *
 * Seka: task execution -> deterministinė verifikacija (quality gates žali) -> ŠIE vartai ->
 * `routine` praeina dabartine done eiga, `review-required` keliauja per ESAMĄ
 * `runIntegrationReview` kontraktą. Antro rizikos klasifikatoriaus ar lygiagretaus loop'o čia
 * nėra — visas sprendimas priimamas `application/integration/*` moduliais.
 *
 * Vartai TYLIAI praleidžia tris atvejus, ir kiekvienas jų yra „nėra ką vertinti", o ne
 * „nusprendėme praleisti": neprijungtas port'as, nežinoma task'o pradžios revizija ir nė vienas
 * kontraktus galintis nešti pakeistas kelias.
 */
export async function runDoneIntegrationGate(ports: TaskRunPorts, state: TaskRunState): Promise<IntegrationGateOutcome> {
  const gate = ports.integrationGate;
  if (!gate || !state.baseHead) {
    return { kind: "proceed" };
  }

  const changedPaths = await ports.git.changedProductPathsSince(state.baseHead);
  if (!changedPaths.some((filePath) => isContractBearingPath(filePath))) {
    return { kind: "proceed" };
  }

  let mode: IntegrationEnforcementMode;
  try {
    mode = await gate.mode();
  } catch (error: unknown) {
    // Sugadintas policy konfigas nėra ŠIO task'o savybė — jis vienodai liečia kiekvieną eilės
    // task'ą, tad klasifikuojamas kaip infrastruktūra su įvardytu failu (kaip `dispatch-task.ts`).
    if (isPolicyConfigError(error)) {
      await ports.log.write(
        `INTEGRATION POLICY CONFIG ERROR (infrastructure): task=${state.taskId} config=${error.configFile} reason=${error.message}`,
      );
      return { kind: "infrastructure", exitCode: POLICY_CONFIG_INVALID_EXIT_CODE, detail: `config=${error.configFile}` };
    }
    throw error;
  }

  const collected = await collectTaskIntegrationEvidence({
    baseRef: state.baseHead,
    headRef: "HEAD",
    changedPaths,
    readFile: (ref, filePath) => gate.readContractFile(ref, filePath),
  });
  if (collected.contentTruncatedPaths.length > 0) {
    // Apkarpymas paskelbiamas: šie keliai lieka `unverified`, tad verdiktas yra griežtesnis, o
    // ne tyliai siauresnis.
    await ports.log.write(
      `TASK INTEGRATION EVIDENCE TRUNCATED: ${state.taskId} content_not_read=${collected.contentTruncatedPaths.length}` +
        ` first=${collected.contentTruncatedPaths[0]}`,
    );
  }

  const result = await runIntegrationReview(ports, state, {
    taskFile: await state.resolveCurrentTaskFile(),
    waveId: `task:${state.taskId}`,
    evidence: collected.evidence,
    evidenceSummary: summarizeTaskIntegrationEvidence(collected),
    enforcement: mode,
  });
  return result.parked ? { kind: "parked" } : { kind: "proceed" };
}

/**
 * IVER-3 seka: deterministinis rizikos verdiktas -> semantinė peržiūra TIK esant
 * `review-required` -> siauras repair arba human-review.
 *
 * Būsena pasiimama iš vykdomo run'o, kai integracija tikrinama to paties task'o viduje
 * (`activeRun` paduoda `run-coordinator.ts` fasadas); atskirai (bangos lygio) kvietimui ji
 * atkuriama iš failo, kaip ir `resume` kelyje.
 */
export async function runIntegrationReview(
  ports: TaskRunPorts,
  activeRun: TaskRunState | undefined,
  request: IntegrationRunRequest,
): Promise<IntegrationRunResult> {
  const taskId = ports.tasks.taskIdOf(request.taskFile);
  const state =
    activeRun && activeRun.taskId === taskId
      ? activeRun
      : await createTaskRunState(request.taskFile, ports, { interrupted: true });

  const risk = evaluateIntegrationRisk(request.evidence);
  const scope: IntegrationReviewScope = {
    taskId: state.taskId,
    waveId: request.waveId,
    ...(request.acceptanceCriteria === undefined ? {} : { acceptanceCriteria: request.acceptanceCriteria }),
    contractDiff: request.evidence.contractDiff,
    ...(request.evidence.gates === undefined ? {} : { gates: request.evidence.gates }),
    ...(request.evidence.conflicts === undefined ? {} : { conflicts: request.evidence.conflicts }),
    ...(request.modules === undefined ? {} : { modules: request.modules }),
  };

  const enforcement = request.enforcement ?? "enforce";
  // Etalono task 0046: `advisory` neišleidžia semantinio kvietimo — ir tai turi galioti TAIP PAT
  // tada, kai kompozicijos šaknis realų reviewer'į jau paduoda. Be šio filtro kiekvienas
  // `review-required` rizikos task'as sudegintų modelio kvietimą dar prieš pasiekdamas žemiau
  // esantį advisory trumpinį, t. y. numatytoji konfigūracija nebebūtų „elgesys nepakitęs":
  // task'o eiga liktų ta pati, bet kaina — ne. Be reviewer'io peržiūra lieka deterministinė:
  // `routine` -> `no-review`, `review-required` -> `human-review` (nieko neparkuojant).
  const reviewDeps = enforcement === "enforce" ? ports.integration : undefined;
  const review = await reviewIntegration({
    risk,
    scope,
    ...(reviewDeps === undefined ? {} : { deps: reviewDeps }),
    ...(request.model === undefined ? {} : { model: request.model }),
  });
  const verdictSummary =
    `mode=${enforcement} risk=${risk.level} status=${review.status}` +
    ` llm_invoked=${review.llm_invoked ? 1 : 0} verdict=${risk.verdict_hash}`;
  await ports.log.write(
    `TASK INTEGRATION REVIEW: ${state.taskId} wave=${request.waveId} ${verdictSummary}`,
  );
  // Pėdsakas diagnose ir final-audit'ui: verdiktas, lygis ir apimtis, iš kurios jis išvestas.
  // `to_state` čia nėra bucket'as — task'as lieka ten, kur buvo; terminalinį perėjimą (jei jo
  // reikia) atskiru įrašu užfiksuoja `applyTerminal`.
  await ports.journal.recordEvent({
    task_id: state.taskId,
    to_state: "integration-review",
    phase: "integration-review",
    reason: `integration_review wave=${request.waveId} ${verdictSummary}${
      request.evidenceSummary ? ` ${request.evidenceSummary}` : ""
    }`,
  });

  // `advisory`: verdiktas jau apskaičiuotas ir užregistruotas, ir tuo vartų darbas baigiasi.
  // Nė vienas žemiau esantis kelias (parkavimas, siauras repair'as) čia neveikia — būtent tai
  // reiškia „numatytoji konfigūracija palieka produkcinį elgesį nepakitusį".
  if (enforcement === "advisory") {
    return { risk, review, parked: false };
  }

  async function park(reason: string, alternatives: string[]): Promise<IntegrationRunResult> {
    const detail = alternatives.length > 0 ? ` alternatives=${alternatives.join(" | ")}` : "";
    await applyTerminal(ports, state, {
      kind: "human-review",
      reason: `TASK HUMAN REVIEW: ${state.taskId} integration_review=${review.status} wave=${request.waveId} ${reason}${detail}`,
    });
    return { risk, review, parked: true };
  }

  if (review.status === "human-review") {
    return await park(review.reason, review.alternatives);
  }
  if (review.status !== "repair-required") {
    return { risk, review, parked: false };
  }

  const conflict = conflictForIntegrationRepair(risk, request.evidence.conflicts ?? []);
  const repairScope = request.repairScope;
  if (!conflict || !repairScope) {
    // Peržiūra pareikalavo pakeitimų, bet apimties (konflikto arba task'o ribų) nėra —
    // siauro repair'o suformuluoti neįmanoma, o platus repair'as yra būtent tai, ko šis
    // vartas neleidžia.
    return await park("integration_repair_scope_missing=1", []);
  }

  const decision = createIntegrationRepair({
    taskId: state.taskId,
    waveId: request.waveId,
    conflict,
    taskAllowedPaths: repairScope.allowedPaths,
    ...(repairScope.forbiddenPaths === undefined ? {} : { taskForbiddenPaths: repairScope.forbiddenPaths }),
    targetedTests: repairScope.targetedTests,
    ...(repairScope.checks === undefined ? {} : { checks: repairScope.checks }),
    findings: review.findings,
    risk,
  });
  if (decision.kind === "human-review") {
    return await park(decision.reason, decision.alternatives);
  }

  await ports.integration?.writeRepairPrompt?.(state.taskId, decision.repair.body);
  await ports.log.write(
    `TASK INTEGRATION REPAIR: ${state.taskId} conflict=${decision.repair.conflict_id}` +
      ` paths=${decision.repair.allowed_paths.length} ${decision.repair.repair_hash}`,
  );
  return { risk, review, repair: decision.repair, parked: false };
}
