// Preflight verdikto vykdymas — delegate žingsnis, iškeltas iš `run-coordinator.ts`
// (file-length riba; atsakomybė vientisa: „preflight sprendimas -> task'as delegated
// bucket'e arba terminalinė šaka"). Efektai — tik per `TaskRunPorts`, kaip ir visame
// koordinatoriuje; terminaliniai perėjimai — išimtinai per `run-coordinator-terminal.ts`.

import { decisionInvalidMarker, type TaskRunPorts } from "./run-coordinator-ports.js";
import type { TaskRunState } from "./task-run-state.js";
import { applyTerminal } from "./run-coordinator-terminal.js";

async function delegateToClaude(ports: TaskRunPorts, state: TaskRunState): Promise<boolean> {
  const decisionResult = await ports.state.readDecision(state.taskId);
  if (decisionResult.status === "invalid") {
    return await applyTerminal(ports, state, {
      kind: "human-review",
      reason: `TASK HUMAN REVIEW: ${state.taskId} ${decisionInvalidMarker(decisionResult)}`,
    });
  }

  // Tuščias sprendimas enqueue kelio NEKVIEČIA: `enqueueChildTasks` be vaikų yra no-op
  // (`enqueued: 0`), o runtime-oversize split maršrutas (066-b-03) remiasi tuo, kad
  // enqueue kvietimas reiškia REALŲ skaidymą — ne kiekvieną delegate žingsnį.
  if ((decisionResult.decision.child_tasks?.length ?? 0) > 0) {
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

/** Preflight verdiktas -> delegate arba terminalinė human-review šaka. */
export async function handlePreflightVerdict(ports: TaskRunPorts, state: TaskRunState): Promise<boolean> {
  const decisionResult = await ports.state.readDecision(state.taskId);
  if (decisionResult.status === "invalid") {
    return await applyTerminal(ports, state, {
      kind: "human-review",
      reason: `TASK HUMAN REVIEW: ${state.taskId} ${decisionInvalidMarker(decisionResult)}`,
    });
  }

  const verdict = decisionResult.decision.verdict;
  if (verdict === "delegate" || verdict === "reformulate_delegate") {
    return await delegateToClaude(ports, state);
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
