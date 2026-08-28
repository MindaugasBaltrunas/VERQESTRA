/**
 * KANONINIS TASK VYKDYMO KOORDINATORIUS (etalono task 1111; VQ-304 2/3).
 *
 * `RunCoordinator` yra vienintelis application lygio task vykdymo koordinatorius. Jis valdo
 * `start` / `resume` / `stop` seką ir deleguoja atskiriems use case moduliams:
 *
 *   dispatch-task.ts  — konteksto parengimas, biudžeto autorizavimas, model routing, dispatch
 *   verify-task.ts    — quality gates + supervisor diagnozė + verdikto klasifikacija
 *   repair-task.ts    — retry-bounded targeted repair perėjimas ir pakartotinis dispatch
 *
 * VIENAS SPRENDĖJAS: use case moduliai grąžina TIK rezultato deskriptorius. Terminalinius
 * bucket perėjimus ir infrastruktūros abort'ą taiko išimtinai `run-coordinator-terminal.ts`
 * (`applyTerminal` / `stopRun`) — vienintelės vietos, kur task'as palieka vykdymo ciklą.
 *
 * SLUOKSNIO RIBA: šis modulis (kaip ir use case moduliai) nevykdo Git, FS ar Claude procesų.
 * Visi efektai eina per `TaskRunPorts`, kuriuos sukonstruoja composition root (E5). Todėl čia
 * nėra `node:fs`, `node:child_process` ar `node:process` importų.
 *
 * ELGESIO KONTRAKTAS: skaidymas (etalono 1180 eil. -> model/terminal/cheap-finish/integration/
 * šis failas, pagal 500 eil. gate) yra elgesį išsaugantis: log tekstai, CLI kvietimų seka,
 * `task-events` įrašai, resume checkpoint'ai ir `WorkflowInfrastructureError` semantika
 * nepakitę.
 */
import {
  PREFLIGHT_FAILURE_MEMO_SCHEMA_VERSION,
  type PreflightFailureMemoRecord,
} from "../quality-gates/preflight-memo-schema.js";
import type { ResumeStateSnapshot, TaskRunPorts } from "./run-coordinator-ports.js";
import { decisionInvalidMarker } from "./run-coordinator-ports.js";
import { createTaskRunState, type TaskRunState } from "./task-run-state.js";
import { PREFLIGHT_START_FAILURE_CLASS, preflightRetryWithoutChange } from "./run-coordinator-guards.js";
import { dispatchTask } from "./dispatch-task.js";
import { repairTask } from "./repair-task.js";
import { confirmSkippedDispatch, probeWorkEvidence } from "./skip-dispatch.js";
import { verifyTask } from "./verify-task.js";
import { applyTerminal, stopRun } from "./run-coordinator-terminal.js";
import { tryCheapFinish } from "./run-coordinator-cheap-finish.js";
import { runDoneIntegrationGate, runIntegrationReview } from "./run-coordinator-integration.js";
import type { RunCoordinator, RunCoordinatorOptions } from "./run-coordinator-model.js";

export * from "./run-coordinator-ports.js";
export { createTaskRunState, type TaskRunState } from "./task-run-state.js";
export * from "./run-coordinator-guards.js";
export type { RunCoordinator, RunCoordinatorOptions } from "./run-coordinator-model.js";

export function createRunCoordinator(ports: TaskRunPorts, options: RunCoordinatorOptions = {}): RunCoordinator {
  const preflightCmd = options.preflightCmd ?? "claude-preflight";
  const diagnoseCmd = options.diagnoseCmd ?? "claude-diagnose";
  // `exactOptionalPropertyTypes`: portas keliauja į verifyTask per sąlyginį spread'ą, kad
  // jo nebuvimas liktų „lauko nėra", o ne `preservedWorkReview: undefined`.
  const preservedWorkReviewOption =
    options.preservedWorkReview === undefined ? {} : { preservedWorkReview: options.preservedWorkReview };
  let activeRun: TaskRunState | undefined;

  function currentRun(): TaskRunState {
    if (!activeRun) {
      throw new TypeError("RunCoordinator.stop called without an active run");
    }
    return activeRun;
  }

  function stop(stage: string, exitCode: number, detail?: string): Promise<never> {
    return stopRun(ports, currentRun(), stage, exitCode, detail);
  }

  async function runDispatch(state: TaskRunState, promptFile: string, fromTaskFile: string, isRepair: boolean): Promise<boolean> {
    const result = await dispatchTask(state, ports, { promptFile, fromTaskFile, isRepair });
    if (result.kind === "infrastructure") {
      return await stopRun(ports, state, result.stage, result.exitCode, result.detail);
    }
    if (result.kind === "human-review") {
      return await applyTerminal(ports, state, { kind: "human-review", reason: result.reason });
    }
    return true;
  }

  async function delegateToClaude(state: TaskRunState): Promise<boolean> {
    const decisionResult = await ports.state.readDecision(state.taskId);
    if (decisionResult.status === "invalid") {
      return await applyTerminal(ports, state, {
        kind: "human-review",
        reason: `TASK HUMAN REVIEW: ${state.taskId} ${decisionInvalidMarker(decisionResult)}`,
      });
    }

    const childOutcome = await ports.completion.enqueueChildTasks(state.taskId, decisionResult.decision);
    if (!childOutcome.ok) {
      if ("depth_exceeded" in childOutcome) {
        return await applyTerminal(ports, state, {
          kind: "human-review",
          reason: `TASK HUMAN REVIEW: ${state.taskId} split_depth_exceeded=${childOutcome.depth_exceeded.parent_depth + 1}>${childOutcome.depth_exceeded.max_depth}`,
        });
      }
      const detail = childOutcome.invalid
        .map((child) => `${child.title || "<untitled>"}:[${child.missingSections.join(",")}]`)
        .join("; ");
      return await applyTerminal(ports, state, {
        kind: "human-review",
        reason: `TASK HUMAN REVIEW: ${state.taskId} invalid_child_tasks=${detail}`,
      });
    }

    await ports.tasks.installReformulatedTask(state.activeFile);
    state.remember(state.activeFile);
    const preSplitFingerprint = await ports.tasks.fingerprint(state.activeFile);
     
    state.fingerprint = preSplitFingerprint;
    const movedDelegatedFile = await ports.tasks.move(state.activeFile, "delegated", state.taskName);
    state.delegatedFile = state.remember(movedDelegatedFile);
    await ports.ledger.recordState(state.taskId, state.taskName, "delegated", state.delegatedFile, state.fingerprint);
    await ports.journal.recordCheckpoint({
      actor: "supervisor",
      phase: "delegated",
      status: "waiting",
      task_id: state.taskId,
      task_file: state.delegatedFile,
      log_file: ports.state.logPath("orchestrator.log"),
      next_action: "Wait for Claude to finish this delegated task",
    });
    await ports.log.write(`TASK DELEGATED TO CLAUDE: ${state.taskId}`);
    return true;
  }

  async function handlePreflightVerdict(state: TaskRunState): Promise<boolean> {
    const decisionResult = await ports.state.readDecision(state.taskId);
    if (decisionResult.status === "invalid") {
      return await applyTerminal(ports, state, {
        kind: "human-review",
        reason: `TASK HUMAN REVIEW: ${state.taskId} ${decisionInvalidMarker(decisionResult)}`,
      });
    }

    const verdict = decisionResult.decision.verdict;
    if (verdict === "delegate" || verdict === "reformulate_delegate") {
      return await delegateToClaude(state);
    }
    if (verdict === "human_review" || verdict === "reject") {
      return await applyTerminal(ports, state, {
        kind: "human-review",
        reason: `TASK HUMAN REVIEW: ${state.taskId} preflight_verdict=${verdict}`,
      });
    }
    return await applyTerminal(ports, state, {
      kind: "human-review",
      reason: `UNKNOWN PREFLIGHT VERDICT: ${verdict ?? ""} task=${state.taskId}`,
    });
  }

  /**
   * Verifikacijos ciklas. Tik `repair` verdiktas su sėkmingu pakartotiniu dispatch'u
   * (`redispatched`) suka antrą ratą — kiekviena terminalinė repair šaka task'ą jau
   * išvedė iš `active`, tad pakartotinis quality-gates/diagnose pass'as bandytų dirbti
   * su nebeegzistuojančiu failu.
   */
  async function runVerificationLoop(state: TaskRunState): Promise<boolean> {
    while (true) {
      const verdict = await verifyTask(state, ports, { diagnoseCmd, ...preservedWorkReviewOption });
      if (verdict.kind === "infrastructure") {
        return await stopRun(ports, state, verdict.stage, verdict.exitCode);
      }
      if (verdict.kind === "human-review") {
        return await applyTerminal(ports, state, { kind: "human-review", reason: verdict.reason });
      }
      if (verdict.kind === "rollback-human-review") {
        return await applyTerminal(ports, state, { kind: "rollback-human-review", decision: verdict.decision });
      }
      if (verdict.kind === "done") {
        // Etalono task 0045: deterministinė verifikacija žalia -> integracijos rizikos vartai.
        // Vartai stovi PRIEŠ terminalinį perėjimą, nes po `applyTerminal` task'as jau būtų
        // išėjęs iš vykdymo ciklo ir „review-required" nebeturėtų kur grįžti.
        const gate = await runDoneIntegrationGate(ports, state);
        if (gate.kind === "infrastructure") {
          return await stopRun(ports, state, "integration-gate", gate.exitCode, gate.detail);
        }
        if (gate.kind === "parked") {
          return false;
        }
        return await applyTerminal(ports, state, { kind: "done" });
      }
      if (verdict.kind === "done-already-implemented") {
        return await applyTerminal(ports, state, { kind: "done-already-implemented", via: verdict.via });
      }

      // Cheap finish jau buvo panaudotas, o verdiktas vėl `repair`: antro papildomo dispatch'o
      // nėra ir įprastas repair ratas čia nebeprasideda. `rollback-stable` SĄMONINGAI
      // praleidžiamas — dalinis produkto darbas lieka žmogui, o ne sunaikinamas.
      if (state.cheapFinishUsed === true) {
        return await applyTerminal(ports, state, {
          kind: "human-review",
          reason: `TASK HUMAN REVIEW: ${state.taskId} cheap_finish_failed=1`,
        });
      }

      const beforeRepair = await tryCheapFinish(ports, state, { stage: "pre-repair" });
      if (beforeRepair.kind === "dispatched") {
        continue;
      }
      if (beforeRepair.kind === "terminal") {
        return beforeRepair.result;
      }

      const repair = await repairTask(state, ports);
      if (repair.kind === "redispatched") {
        continue;
      }
      if (repair.kind === "infrastructure") {
        return await stopRun(ports, state, repair.stage, repair.exitCode, repair.detail);
      }
      if (repair.kind === "retry-limit") {
        return await applyTerminal(ports, state, { kind: "retry-limit-human-review" });
      }

      const afterVeto = await tryCheapFinish(ports, state, { stage: "post-veto", budgetVetoReason: repair.reason });
      if (afterVeto.kind === "dispatched") {
        continue;
      }
      if (afterVeto.kind === "terminal") {
        return afterVeto.result;
      }
      return await applyTerminal(ports, state, { kind: "human-review", reason: repair.reason });
    }
  }

  async function continueActiveTask(state: TaskRunState): Promise<boolean> {
    // Korumpuota resume būsena nėra fatališka — saugus kelias yra pakartoti preflight.
    const resumeResult = await ports.state.readResumeState(state.taskId);
    if (resumeResult.status === "corrupted") {
      await ports.log.write(
        `WARNING: korumpuotas supervisor-resume.json task=${state.taskId} - preflight kartojamas: ${resumeResult.error}`,
      );
    }
    const supervisorResume: ResumeStateSnapshot = resumeResult.status === "ok" ? resumeResult.value : {};
    const decisionResult = await ports.state.readDecision(state.taskId);
    const verdict = decisionResult.status === "ok" ? decisionResult.decision.verdict : undefined;
    const phase = supervisorResume.phase ?? "";

    // Kito task'o resume būsena traktuojama kaip švarus startas — preflight kartojamas.
    const resumeMatchesTask = supervisorResume.task_id === state.taskId;
    const needsPreflight =
      !resumeMatchesTask ||
      phase.startsWith("preflight") ||
      ["delegate", "reformulate_delegate", "human_review", "reject"].includes(verdict ?? "");

    if (!needsPreflight) {
      return await runVerificationLoop(state);
    }

    const skipPreflight = resumeMatchesTask && phase === "preflight" && supervisorResume.status === "finished";
    const preflight = skipPreflight
      ? { code: 0, output: "" }
      : await ports.cli.runCaptured([preflightCmd, state.activeFile]);
    if (preflight.code !== 0) {
      await ports.journal.recordPhaseFailure(state.taskId, "resumed-preflight", preflight.code, preflight.output);
      if (ports.failure.isInfrastructureExit(preflight.code)) {
        return await stopRun(ports, state, "resumed-preflight", preflight.code);
      }
      return await applyTerminal(ports, state, {
        kind: "human-review",
        reason: `TASK HUMAN REVIEW: ${state.taskId} resumed_preflight_failed=${preflight.code}`,
      });
    }

    if (!(await handlePreflightVerdict(state))) {
      return false;
    }
    if (!(await runDispatch(state, state.delegatedFile, state.delegatedFile, false))) {
      return false;
    }
    return await runVerificationLoop(state);
  }

  async function continueDelegatedTask(state: TaskRunState): Promise<boolean> {
    await ports.journal.recordCheckpoint({
      actor: "supervisor",
      phase: "resume-delegated",
      status: "started",
      task_id: state.taskId,
      task_file: state.delegatedFile,
      log_file: ports.state.logPath("orchestrator.log"),
      next_action: "Dispatch interrupted delegated task to Claude",
    });
    if (!(await runDispatch(state, state.delegatedFile, state.delegatedFile, false))) {
      return false;
    }
    return await runVerificationLoop(state);
  }

  async function continueErrorTask(state: TaskRunState): Promise<boolean> {
    const repairPrompt = await ports.repairPrompt.read(state.taskId);
    if (!repairPrompt.trim()) {
      const movedActiveFile = await ports.tasks.move(state.errorFile, "active", state.taskName);
      state.activeFile = state.remember(movedActiveFile);
      await ports.ledger.recordState(
        state.taskId,
        state.taskName,
        "active",
        state.activeFile,
        await ports.tasks.fingerprint(state.activeFile),
      );
      await ports.log.write(`TASK RESUME ERROR WITHOUT REPAIR TASK: ${state.taskId}`);
      return await runVerificationLoop(state);
    }

    await ports.tasks.writeTaskBody(state.errorFile, repairPrompt);
    const resumeFingerprint = await ports.tasks.fingerprint(state.errorFile);
     
    state.fingerprint = resumeFingerprint;
    await ports.journal.recordCheckpoint({
      actor: "supervisor",
      phase: "resume-repair",
      status: "started",
      task_id: state.taskId,
      task_file: state.errorFile,
      log_file: state.errorFile,
      next_action: "Dispatch interrupted repair task to Claude",
    });
    if (!(await runDispatch(state, state.errorFile, state.errorFile, true))) {
      return false;
    }
    return await runVerificationLoop(state);
  }

  /**
   * Etalono task 1204 — guard hit'as parkuoja task'ą į human-review BE preflight kvietimo.
   *
   * Grąžinama reikšmė yra „ar guard'as suveikė", o NE task'o baigtis: `applyTerminal`
   * human-review šakoje visada grąžina `false`, tad tą rezultatą čia sąmoningai ignoruojame ir
   * grąžiname `true`. Kvietėjas `start()` iš to daro `return false;` — tą pačią baigtį, kurią
   * duotų įprastas preflight kritimas.
   *
   * APIMTIS: tikrinama TIK `queue -> start()` kelyje. `continueActiveTask` resumed-preflight
   * lieka nepaliestas, nes (1) auditinis ping-pongas eina išimtinai šiuo keliu, o
   * `resume("active", …)` yra to paties, jau vykdomo bandymo crash-recovery tęsinys;
   * (2) rašymas ten sulaužytų invariantą „rašomas hash == tikrinamas hash".
   */
  async function preflightRetryGuard(state: TaskRunState): Promise<boolean> {
    const memo = ports.preflightMemo;
    if (!memo) return false;
    const read = await memo.read(state.taskId);
    const record = read.status === "hit" ? read.record : undefined;
    if (
      !preflightRetryWithoutChange(record, {
        taskId: state.taskId,
        contentHash: state.fingerprint,
        failureClass: PREFLIGHT_START_FAILURE_CLASS,
      })
    ) {
      return false;
    }
    const hit = record as PreflightFailureMemoRecord;
    const repeat = hit.repeat_count + 1;
    await memo.record({ ...hit, repeat_count: repeat }); // failed_at NEKEIČIAMAS
    await ports.log.write(
      `TASK PREFLIGHT RETRY GUARD: ${state.taskId} preflight-retry-without-change` +
        ` hash=${state.fingerprint} class=${hit.failure_class} prev_exit=${hit.exit_code}` +
        ` first_failed_at=${hit.failed_at} repeat=${repeat}` +
        ` remedy=edit-task-or-remove-vq/state/preflight-failure-memo/${state.taskId}.json`,
    );
    await ports.journal.recordEvent({
      task_id: state.taskId,
      to_state: "human-review",
      phase: "preflight-retry-guard",
      exit_code: hit.exit_code,
      reason: `preflight_retry_without_change=1 class=${hit.failure_class} repeat=${repeat}`,
      detail: `hash=${state.fingerprint} first_failed_at=${hit.failed_at}`,
    });
    await applyTerminal(ports, state, {
      kind: "human-review",
      reason: `TASK HUMAN REVIEW: ${state.taskId} preflight_retry_without_change=1 repeat=${repeat}`,
    });
    return true;
  }

  /** Rašoma TIK po `isInfrastructureExit` patikros; hash = PRIEŠ preflight matuotas (task 1204). */
  async function recordPreflightFailureMemo(state: TaskRunState, exitCode: number): Promise<void> {
    const memo = ports.preflightMemo;
    if (!memo || !state.fingerprint) return;
    const read = await memo.read(state.taskId);
    const previous = read.status === "hit" ? read.record : undefined;
    const continues = preflightRetryWithoutChange(previous, {
      taskId: state.taskId,
      contentHash: state.fingerprint,
      failureClass: PREFLIGHT_START_FAILURE_CLASS,
    });
    await memo.record({
      schema_version: PREFLIGHT_FAILURE_MEMO_SCHEMA_VERSION,
      task_id: state.taskId,
      content_hash: state.fingerprint,
      failure_class: PREFLIGHT_START_FAILURE_CLASS,
      exit_code: exitCode,
      failed_at: new Date().toISOString(),
      repeat_count: continues ? (previous as PreflightFailureMemoRecord).repeat_count + 1 : 1,
    });
  }

  return {
    async start(queuedFile: string): Promise<boolean> {
      const state = await createTaskRunState(queuedFile, ports);
      activeRun = state;

      await ports.ledger.init();
      if (await ports.ledger.seenBefore(state.taskId, state.fingerprint)) {
        return await applyTerminal(ports, state, { kind: "duplicate", queuedFile });
      }

      // Etalono task 1187 — pre-dispatch work-evidence probe. Vieta yra dalis kontrakto:
      // įrodymo intervalą riboja šio task'o `task-start-status.json` baseline, o
      // `recordTaskStartStatus` (žemiau) jį perrašo į dabartinį HEAD. Po to intervalas būtų
      // tuščias (`HEAD..HEAD`) ir ankstesnio bandymo commit'as — nematomas, t. y. vartai
      // niekada nesuveiktų. Probe yra read-only ir be įrodymo nepalieka jokio pėdsako, tad
      // ankstyva vieta nieko nekeičia task'ui, kurio darbo istorijoje nėra.
      const workEvidence = await probeWorkEvidence(state, ports);

      state.activeFile = state.remember(await ports.tasks.activateQueued(queuedFile, state.taskId));
      await ports.state.recordTaskStartStatus(state.taskId);
      state.fingerprint = await ports.tasks.fingerprint(state.activeFile);
      await ports.ledger.recordState(state.taskId, state.taskName, "active", state.activeFile, state.fingerprint);
      await ports.log.write(`TASK ACTIVE: ${state.taskId}`);

      // Įrodymas praleidžia LLM sesiją, o ne patikras: `confirmSkippedDispatch` paleidžia tuos
      // pačius `quality-gates`, ir tik jiems žaliems task'as užsidaro. Vartams kritus krentama į
      // įprastą preflight -> dispatch -> verify/repair kelią, kuris tą baigtį klasifikuos pats.
      if (workEvidence.kind === "skip") {
        const skipped = await confirmSkippedDispatch(state, ports, workEvidence.commit);
        if (skipped.kind === "infrastructure") {
          return await stopRun(ports, state, "quality-gates", skipped.exitCode);
        }
        if (skipped.kind === "already-implemented") {
          return await applyTerminal(ports, state, { kind: "done-already-implemented", via: "skip-dispatch" });
        }
      }

      // Etalono task 1204 — preflight requeue ping-pong vartai. Vieta yra dalis kontrakto:
      //   (1) PO `state.fingerprint` perskaičiavimo (aukščiau) — tai vienintelis taškas, kur
      //       hash'as matuojamas TO PATIES failo, kurį hash'uos ir kitas ratas; `activateQueued`
      //       yra grynas rename, tad `hash(queue) === hash(active)`;
      //   (2) PO skip-dispatch bloko — work-evidence kelias uždaro task'ą kaip DONE, o tai
      //       geresnė baigtis nei human-review, ir guard'as neturi teisės jos preempt'inti.
      // Naudojamas būtent `state.fingerprint`, o ne po preflight'o perskaičiuotas hash'as:
      // preflight task failo neperrašinėja (visi jo rašymai eina į `decision.json`,
      // `reformulated-task.md`, prompt'ą ir supervisor logą), tad pre- ir post-preflight
      // hash'as sutampa ir guard'as pataiko jau antrame bandyme.
      if (await preflightRetryGuard(state)) {
        return false;
      }

      const preflight = await ports.cli.runCaptured([preflightCmd, state.activeFile]);
      if (preflight.code !== 0) {
        await ports.journal.recordPhaseFailure(state.taskId, "preflight", preflight.code, preflight.output);
        if (ports.failure.isInfrastructureExit(preflight.code)) {
          return await stopRun(ports, state, "preflight", preflight.code);
        }
        await recordPreflightFailureMemo(state, preflight.code);
        return await applyTerminal(ports, state, {
          kind: "human-review",
          reason: `TASK HUMAN REVIEW: ${state.taskId} preflight_failed=${preflight.code}`,
        });
      }

      // Žalias preflight'as = turinys pajudėjo arba priežastis dingo: memo nebegalioja.
      await ports.preflightMemo?.clear(state.taskId);

      if (!(await handlePreflightVerdict(state))) {
        return false;
      }
      if (!(await runDispatch(state, state.delegatedFile, state.delegatedFile, false))) {
        return false;
      }
      return await runVerificationLoop(state);
    },

    async resume(bucket, taskFile) {
      const state = await createTaskRunState(taskFile, ports, { interrupted: true });
      activeRun = state;

      await ports.ledger.init();
      await ports.state.setCurrentTask(state.taskId, taskFile);
      await ports.log.write(`TASK RESUME: bucket=${bucket} task=${state.taskId}`);

      if (bucket === "active") {
        return await continueActiveTask(state);
      }
      if (bucket === "delegated") {
        return await continueDelegatedTask(state);
      }
      return await continueErrorTask(state);
    },

    reviewIntegration: (request) => runIntegrationReview(ports, activeRun, request),

    stop,
  };
}
