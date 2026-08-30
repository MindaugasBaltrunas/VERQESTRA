/**
 * Terminaliniai perėjimai ir infrastruktūros abort'as (VQ-304 2/3; etalono run-coordinator.ts dalis).
 *
 * VIENAS SPRENDĖJAS: use case moduliai grąžina TIK rezultato deskriptorius. Terminalinius
 * bucket perėjimus (done / human-review / duplicate) ir infrastruktūros abort'ą (`stopRun`)
 * taiko išimtinai šis modulis — `applyTerminal` / `stopRun` yra vienintelės vietos, kur
 * task'as palieka vykdymo ciklą. Taip to paties perėjimo nebeatlieka du komponentai
 * lygiagrečiai. Etalone šios funkcijos buvo `createRunCoordinator` closure'e; VERQESTRA jos
 * yra laisvos funkcijos su eksplicitiniais (ports, state) parametrais — elgesys tas pats.
 */
import type { TaskDecision, TaskRunPorts, TerminalTaskBucket } from "./run-coordinator-ports.js";
import { taskFileBasename, type TaskRunState } from "./task-run-state.js";
import { infrastructureFailureDisposition } from "./run-coordinator-guards.js";
import type { TerminalTransition } from "./run-coordinator-model.js";
import { DISPATCH_TIMEOUT_EXIT_CODE } from "../../shared/exit-codes.js";
import { evaluateRuntimeOversizeDisposition } from "../../domain/diagnosis/dispositions.js";
import { measureTaskSize } from "../../domain/tasks/size.js";
import { buildTaskSplitPlan, type TaskSplitPlan } from "./task-splitting.js";
import { DEFAULT_PREFLIGHT_LIMITS } from "../policy-governance/preflight-limits-policy.js";
import { extractSection } from "../../shared/markdown.js";

// Terminalinis bucket perėjimas su visų šio task'o žinomų failų sutvarkymu.
//
// Etalono task 0000-1: kai `from` nebeegzistuoja, perėjimas NEBEMETA `Unique move source file
// does not exist` (kuris užmušdavo visą run'ą exit 2). Vietoje to: (1) šaltiniu bandomas bet
// kuris kitas dar egzistuojantis žinomas šio task'o failas (kolizinio vardo kopijos gyvena tik
// `knownTaskFiles`, `resolveCurrentTaskFile` jų nemato); (2) nesant nė vieno, terminalinė kopija
// atkuriama iš run'o pradžioje paimto kūno snapshot'o — ledger'io būsena visada turi atitikti
// failą terminaliniame bucket'e. Snapshot'o nebuvimas palieka seną, garsų metimą.
async function finishKnownTaskState(
  ports: TaskRunPorts,
  state: TaskRunState,
  from: string,
  bucket: TerminalTaskBucket,
): Promise<string> {
  let source = from;
  if (!(await ports.tasks.exists(source))) {
    const fallback = await firstExistingKnownFile(ports, state, source);
    if (fallback !== undefined) {
       
      source = fallback;
    } else if (state.taskBodySnapshot !== undefined) {
      const restored = ports.tasks.bucketPath(bucket, state.taskName);
      await ports.tasks.writeTaskBody(restored, state.taskBodySnapshot);
      await ports.log.write(
        `TASK FILE RESTORED: task=${state.taskId} bucket=${bucket} source=snapshot — failas buvo dingęs iš visų bucket'ų`,
      );
      await ports.repairPrompt.remove(state.taskId);
      state.remember(restored);
      return restored;
    }
  }
  const cleanupFiles = Array.from(state.knownTaskFiles).filter((filePath) => filePath !== source);
  const moved = await ports.tasks.finish(source, bucket, state.taskName, cleanupFiles);
  await ports.repairPrompt.remove(state.taskId);
  state.remember(moved);
  return moved;
}

/** Pirmas dar egzistuojantis žinomas task failas, išskyrus jau atmestą `except` kelią. */
async function firstExistingKnownFile(
  ports: TaskRunPorts,
  state: TaskRunState,
  except: string,
): Promise<string | undefined> {
  for (const candidate of state.knownTaskFiles) {
    if (candidate === except) continue;
    if (await ports.tasks.exists(candidate)) return candidate;
  }
  return undefined;
}

/**
 * VIENINTELĖ vieta, taikanti terminalinį perėjimą. Žingsnių tvarka ir fingerprint
 * politika kiekvienoje šakoje yra tyčinė ir pinning'inama testais:
 * `human-review`/`duplicate` naudoja ESAMĄ fingerprint, `done`/`retry-limit`/`rollback`
 * — perskaičiuotą iš jau perkelto failo.
 */
export async function applyTerminal(
  ports: TaskRunPorts,
  state: TaskRunState,
  transition: TerminalTransition,
): Promise<boolean> {
  if (transition.kind === "duplicate") {
    const duplicateFile = state.remember(
      await ports.tasks.move(transition.queuedFile, "human-review", state.taskName),
    );
    await ports.ledger.recordState(state.taskId, state.taskName, "duplicate", duplicateFile, state.fingerprint);
    await ports.journal.recordEvent({
      task_id: state.taskId,
      to_state: "duplicate",
      reason: "duplicate moved_to=human-review",
    });
    await ports.log.write(`TASK DUPLICATE: ${state.taskId} moved_to=human-review`);
    // A duplicate is PARKED in human-review, never finished: `taskSeenBefore` also flags task
    // ids last seen as active/error/human-review, i.e. tasks that never completed. Reporting
    // success here made the wave scheduler mark it `task_completed` and release its blocked
    // dependents, dispatching work whose prerequisite was never actually done. Same disposition
    // as the human-review branch below: not-succeeded, and dependents stay blocked.
    await ports.completion.cascadeBlockedDependents(state.taskId);
    return false;
  }

  if (transition.kind === "human-review") {
    const moved = await finishKnownTaskState(ports, state, await state.resolveCurrentTaskFile(), "human-review");
    await ports.ledger.recordState(state.taskId, state.taskName, "human-review", moved, state.fingerprint);
    await ports.journal.recordEvent({ task_id: state.taskId, to_state: "human-review", reason: transition.reason });
    await ports.log.write(transition.reason);
    await ports.completion.cascadeBlockedDependents(state.taskId);
    return false;
  }

  if (transition.kind === "retry-limit-human-review") {
    // RT-06 (terminal-state-vocabulary): „failed" nėra realus bucket'as — ledger'is ir įvykių
    // žurnalas fiksuoja tą pačią „human-review" būseną, kurioje failas realiai atsiduria;
    // priežastis išsaugo, kaip jis ten pateko.
    const moved = await finishKnownTaskState(ports, state, await state.resolveCurrentTaskFile(), "human-review");
    await ports.ledger.recordState(
      state.taskId,
      state.taskName,
      "human-review",
      moved,
      await ports.tasks.fingerprint(moved),
    );
    await ports.journal.recordEvent({ task_id: state.taskId, to_state: "human-review", reason: "failed retry_limit" });
    await ports.log.write(`TASK FAILED AFTER RETRY LIMIT: ${state.taskId}`);
    await ports.completion.cascadeBlockedDependents(state.taskId);
    return false;
  }

  if (transition.kind === "rollback-human-review") {
    // Fazinis „diagnosis" įrašas rašomas PRIEŠ rollback: learning emiteris atmeta
    // apibendrinančią „TASK HUMAN REVIEW:" eilutę kaip preflight dublikatą, tad be šio
    // įrašo dažniausia parkų klasė nekauptų failure_pattern statistikos.
    const { decision } = transition;
    await ports.journal.recordEvent({
      task_id: state.taskId,
      to_state: "human-review",
      phase: "diagnosis",
      reason: decision.reason ?? `verdict=${decision.verdict ?? "unknown"}`,
    });
    // Cheap finish egzistuoja tam, kad IŠSAUGOTŲ dalinį produkto darbą, tad nė viena cheap
    // finish sesijos baigtis negali jo sunaikinti. `rollback_stop` / `human_review` verdiktas
    // po cheap finish dispatch'o čia atsuktų būtent tą darbą, dėl kurio papildomas dispatch'as
    // ir buvo leistas — vietoje to task'as parkuojamas su įvardyta priežastimi, o darbas
    // lieka worktree, kur žmogus jį ras.
    if (state.cheapFinishUsed === true) {
      return await applyTerminal(ports, state, {
        kind: "human-review",
        reason:
          `TASK HUMAN REVIEW: ${state.taskId} cheap_finish_rollback_suppressed=1` +
          ` verdict=${decision.verdict ?? "unknown"}`,
      });
    }
    const rollbackCode = await ports.cli.run(["rollback-stable", "--allow-task-changes", "--task-id", state.taskId]);
    if (rollbackCode !== 0) {
      return await applyTerminal(ports, state, {
        kind: "human-review",
        reason: `TASK HUMAN REVIEW: ${state.taskId} rollback_failed=${rollbackCode} verdict=${decision.verdict}`,
      });
    }

    const moved = await finishKnownTaskState(ports, state, await state.resolveCurrentTaskFile(), "human-review");
    await ports.ledger.recordState(
      state.taskId,
      state.taskName,
      "human-review",
      moved,
      await ports.tasks.fingerprint(moved),
    );
    await ports.log.write(`TASK HUMAN REVIEW/ROLLBACK: task=${state.taskId} verdict=${decision.verdict}`);
    await ports.completion.cascadeBlockedDependents(state.taskId);
    return false;
  }

  const alreadyImplemented = transition.kind === "done-already-implemented";
  // Checkpoint'as turi rodyti į logą, kuriame tas sprendimas realiai matomas: po dispatch'o tai
  // Claude sesijos logas, po commit'o — commit logas, o pre-dispatch praleidimo atveju sesijos
  // apskritai nebuvo, tad vienintelis pėdsakas yra orkestratoriaus logas.
  const doneLogFile =
    transition.kind === "done-already-implemented" && transition.via === "skip-dispatch"
      ? "orchestrator.log"
      : alreadyImplemented
        ? "claude-last.log"
        : "commit.log";
  if (!alreadyImplemented) {
    await ports.completion.markStable();
  }
  const moved = await finishKnownTaskState(ports, state, await state.resolveCurrentTaskFile(), "done");
  await ports.ledger.recordState(state.taskId, state.taskName, "done", moved, await ports.tasks.fingerprint(moved));
  await ports.journal.recordCheckpoint({
    actor: "supervisor",
    phase: "done",
    status: "finished",
    task_id: state.taskId,
    task_file: moved,
    log_file: ports.state.logPath(doneLogFile),
    next_action: "Pick next task from queue",
  });
  // Task 095: `audit-complete` NĖRA ALREADY_IMPLEMENTED semantiškai (žr. `AlreadyImplementedVia`
  // komentarą) — žurnalo ir log'o eilutė jį įvardija atskirai, kad operatorius neieškotų
  // markerio, kurio sesija niekada neparašė.
  const isAuditComplete = transition.kind === "done-already-implemented" && transition.via === "audit-complete";
  await ports.journal.recordEvent({
    task_id: state.taskId,
    to_state: "done",
    reason: alreadyImplemented
      ? isAuditComplete
        ? `done audit_complete (${transition.via})`
        : `done already_implemented (${transition.via})`
      : "done",
  });
  await ports.log.write(
    alreadyImplemented
      ? isAuditComplete
        ? `TASK DONE (AUDIT_COMPLETE): ${state.taskId} via=${transition.via}`
        : `TASK DONE (ALREADY_IMPLEMENTED): ${state.taskId} via=${transition.via}`
      : `TASK DONE: ${state.taskId}`,
  );
  await ports.completion.syncArchitectureCompletion(state.taskId, moved);
  await ports.completion.archiveAutoOpenSpecChange?.(state.taskId, moved);
  return true;
}

/**
 * Infrastruktūros abort: preserve-vs-requeue + `WorkflowInfrastructureError` metimas.
 * Etalone tai buvo koordinatoriaus `stop`; `RunCoordinator.stop` fasadas (run-coordinator.ts)
 * čia paduoda aktyvaus run'o būseną eksplicitiškai.
 */
export async function stopRun(
  ports: TaskRunPorts,
  state: TaskRunState,
  stage: string,
  exitCode: number,
  detail?: string,
): Promise<never> {
  const currentFile = await state.resolveCurrentTaskFile();
  const currentBucket = ports.tasks.bucketOf(currentFile);
  const hasRepairPrompt = Boolean((await ports.repairPrompt.read(state.taskId)).trim());
  // Vienintelė vieta, kur `detail` įsilieja į tekstą: tuščias detail palieka ir žinutę, ir
  // abi abort'o eilutes nepakitusias, tad kiekvienas kitas abort'o šaltinis lieka toks pat.
  const suffix = detail ? ` ${detail}` : "";
  const message = `${stage} infrastructure failure exit=${exitCode} task=${state.taskId}${suffix}`;

  if (infrastructureFailureDisposition(currentBucket, hasRepairPrompt) === "preserve") {
    const bucketState = ["active", "delegated", "error"].includes(currentBucket) ? currentBucket : "error";
    state.fingerprint = await ports.tasks.fingerprint(currentFile);
    await ports.ledger.recordState(state.taskId, state.taskName, bucketState, currentFile, state.fingerprint);
    await ports.journal.recordCheckpoint({
      actor: "supervisor",
      phase: stage,
      status: "failed",
      task_id: state.taskId,
      task_file: currentFile,
      log_file: ports.state.logPath("orchestrator.log"),
      exit_code: exitCode,
      next_action: "Fix infrastructure and resume the preserved repair workflow",
    });
    await ports.journal.recordEvent({
      task_id: state.taskId,
      to_state: bucketState,
      phase: stage,
      exit_code: exitCode,
      reason: `infra_abort repair_preserved=1 stage=${stage} exit=${exitCode}`,
    });
    await ports.log.write(
      `LOOP ABORT (infrastruktura): stage=${stage} exit=${exitCode} task=${state.taskId}${suffix} repair_preserved_in=${bucketState}`,
    );
    throw ports.failure.infrastructureError(message, {
      taskReturnedToQueue: false,
      taskPreservedForResume: true,
      exitCode,
    });
  }

  const moved = await ports.tasks.move(currentFile, "queue", state.taskName, { updateCurrent: false });
  await ports.ledger.clearEntry(state.taskId);
  await ports.journal.recordEvent({
    task_id: state.taskId,
    to_state: "queue",
    phase: stage,
    exit_code: exitCode,
    reason: `infra_abort stage=${stage} exit=${exitCode}`,
  });
  await ports.log.write(
    `LOOP ABORT (infrastruktura): stage=${stage} exit=${exitCode} task=${state.taskId}${suffix} returned_to_queue=${taskFileBasename(moved)}`,
  );
  throw ports.failure.infrastructureError(message, { taskReturnedToQueue: true, exitCode });
}

// ---------------------------------------------------------------------------------------------
// Runtime-oversize dispatch timeout routing (task 066-b-03, GeoGravity 1178).
//
// `evaluateRuntimeOversizeDisposition` (domain/diagnosis/dispositions.ts, task 066-a-02) says
// WHAT to do; this module says WHERE the decision plugs in — the one place, right before an
// infrastructure abort, that both dispatch call sites (initial/resumed dispatch via
// `run-coordinator.ts#runDispatch`, and the repair-cycle dispatch via `repair-task.ts#repairTask`)
// already funnel through. Both produce the same `{ stage, exitCode, detail? }` shape on a
// dispatch-stage timeout, so one router serves both without either caller growing.
// ---------------------------------------------------------------------------------------------

/** Structural shape shared by `DispatchTaskResult`'s and `RepairTaskResult`'s `infrastructure` variants. */
export type InfrastructureFailureDescriptor = { stage: string; exitCode: number; detail?: string };

/**
 * Kartojimo skaitiklis — TAS PATS durabilus `vq/state/retry-counts.json` skaitiklis, kurį jau
 * naudoja retry-limit kelias (`cheap-finish-adapters.ts#retryBudget`). Jokio naujo porto: kai
 * `cheapFinish` neprijungtas, `attempts` lieka `0` ir maršrutas visada krenta į `undefined`
 * (nepakitęs `stopRun` elgesys).
 */
async function routeRuntimeOversizeTimeout(
  ports: TaskRunPorts,
  state: TaskRunState,
  exitCode: number,
  taskTextOverride?: string,
): Promise<boolean | undefined> {
  const attempts = (await ports.cheapFinish?.retryBudget(state.taskId))?.count ?? 0;
  const currentFile = await state.resolveCurrentTaskFile();
  // Repair kelyje failo kūnas yra repair PROMPT'as (repair-task.ts jį perrašė paruošdama
  // dispatch'ą) — dalomumas ir split planas vertinami iš kvietėjo paduoto ORIGINALAUS
  // teksto, kitaip kiekvienas repair timeout'as atrodytų nedalomas ir keliautų human-review.
  const taskText = taskTextOverride?.trim()
    ? taskTextOverride
    : await ports.tasks.readTaskBody(currentFile).catch(() => "");
  const metrics = measureTaskSize(taskText);
  const isDivisible = metrics.actionBullets > 1 || metrics.allowedPaths > 1;
  const verdict = evaluateRuntimeOversizeDisposition({ exitCode, repeatedSignatureAttempts: attempts, isDivisible });

  if (verdict === "repair") return undefined;
  if (verdict === "human-review") {
    return await applyTerminal(ports, state, {
      kind: "human-review",
      reason: `TASK HUMAN REVIEW: ${state.taskId} runtime_oversize_indivisible=1 attempts=${attempts}`,
    });
  }

  const plan = buildTaskSplitPlan(taskText, state.taskId, DEFAULT_PREFLIGHT_LIMITS);
  return await applySplitSupersede(ports, state, { taskText, plan, attempts });
}

/**
 * VIENINTELĖ vieta prieš infrastruktūros abort'ą — patikrina, ar tai pasikartojantis
 * runtime-oversize dispatch timeout'as; kitaip (arba pirmas šios signatūros bandymas) elgesys
 * nepakitęs — `stopRun`, kaip ir anksčiau.
 */
export async function routeRepairInfrastructureFailure(
  ports: TaskRunPorts,
  state: TaskRunState,
  failure: InfrastructureFailureDescriptor,
  options?: { taskText?: string },
): Promise<boolean> {
  if (failure.stage === "dispatch" && failure.exitCode === DISPATCH_TIMEOUT_EXIT_CODE) {
    const routed = await routeRuntimeOversizeTimeout(ports, state, failure.exitCode, options?.taskText);
    if (routed !== undefined) return routed;
  }
  return await stopRun(ports, state, failure.stage, failure.exitCode, failure.detail);
}

/**
 * Tėvas žymimas `# Superseded` stub'u ir keliauja į `done` (archyvas — `backlog-audit.ts` jį
 * jau atpažįsta kaip nebeaktyvų per `isSupersededStub`, `done/` jam netaiko numerių higienos).
 * Vaikai — TAS PATS `ports.completion.enqueueChildTasks` kelias, kurį naudoja LLM-driven
 * `delegateToClaude` split'as; nesėkmės šaka (nevalidūs vaikai, gylio limitas) elgiasi
 * identiškai jam.
 */
async function applySplitSupersede(
  ports: TaskRunPorts,
  state: TaskRunState,
  input: { taskText: string; plan: TaskSplitPlan; attempts: number },
): Promise<boolean> {
  const { plan, attempts } = input;
  // Tėvas superseduojamas VISIŠKAI (ne pratęsiamas kaip preflight'o `first_task` kelyje), tad
  // ir pirmoji dalis tampa vaiku — kitaip jos apimtis dingtų niekur neįrašyta.
  const decision: TaskDecision = {
    child_tasks: [{ title: firstPartTitle(plan.first_task), claude_task: plan.first_task }, ...plan.child_tasks],
  };
  const childOutcome = await ports.completion.enqueueChildTasks(state.taskId, decision);
  if (!childOutcome.ok) {
    if ("depth_exceeded" in childOutcome) {
      return await applyTerminal(ports, state, {
        kind: "human-review",
        reason:
          `TASK HUMAN REVIEW: ${state.taskId} split_depth_exceeded=` +
          `${childOutcome.depth_exceeded.parent_depth + 1}>${childOutcome.depth_exceeded.max_depth}`,
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

  const currentFile = await state.resolveCurrentTaskFile();
  const supersededBody = [
    "# Superseded",
    "",
    `Split into ${plan.parts} parts after ${attempts} repeated runtime-oversize timeouts.`,
    "",
    input.taskText.trimEnd(),
    "",
  ].join("\n");
  await ports.tasks.writeTaskBody(currentFile, supersededBody);
  const moved = await finishKnownTaskState(ports, state, currentFile, "done");
  await ports.ledger.recordState(state.taskId, state.taskName, "superseded", moved, await ports.tasks.fingerprint(moved));
  await ports.journal.recordEvent({
    task_id: state.taskId,
    to_state: "superseded",
    reason: `split parts=${plan.parts} after ${attempts} timeouts`,
  });
  await ports.log.write(
    `TASK SPLIT (runtime-oversize): parent=${state.taskId} parts=${plan.parts} po ${attempts} timeout`,
  );
  await ports.completion.cascadeBlockedDependents(state.taskId);
  return false;
}

/** `## Tikslas` pirma neturia eilutė iš skaidymo dalies — tas pats tekstas, kurį `renderTaskPart` įrašė. */
function firstPartTitle(taskText: string): string {
  const goal = extractSection(taskText, "## Tikslas")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  return goal ?? "Split part 1";
}
