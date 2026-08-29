// Task 066-b-03: pasikartojantis dispatch timeout (exit 124) domain 'split' verdiktas
// (066-a-02, evaluateRuntimeOversizeDisposition) sujungtas su vykdymu per run-coordinator.ts.
// Jokios realios FS/git/CLI — tik fake TaskRunPorts.
import assert from "node:assert/strict";
import test from "node:test";
import { createRunCoordinator } from "../application/task-execution/run-coordinator.js";
import type { CheapFinishPort, TaskDecision } from "../application/task-execution/run-coordinator-ports.js";
import { createFakeTaskRunEnv, fakeBucketPath, type FakeTaskRunEnv } from "./helpers/fake-task-run-ports.js";

const TASK = "0042";
const TASK_MD = `${TASK}.md`;

const DIVISIBLE_TASK = `# Task

## Spec source
openspec/changes/x

## Tikslas
Do the big thing

## Failai
Leidžiama:
- \`src/a.ts\`
- \`src/b.ts\`

## Veiksmas
- Do A
- Do B

## Patikra
- \`pnpm test\`

## Stop
Stop when green.

## Neįtraukta
Nothing.
`;

const INDIVISIBLE_TASK = `# Task

## Spec source
openspec/changes/x

## Tikslas
Do the one thing

## Failai
Leidžiama:
- \`src/a.ts\`

## Veiksmas
- Do A

## Patikra
- \`pnpm test\`

## Stop
Stop when green.

## Neįtraukta
Nothing.
`;

function seedQueue(env: FakeTaskRunEnv, body: string): string {
  const queuedFile = fakeBucketPath("queue", TASK_MD);
  env.files.set(queuedFile, body);
  return queuedFile;
}

function fakeCheapFinish(count: number): CheapFinishPort {
  return {
    read: async () => ({ status: "absent" }),
    async arm() {},
    retryBudget: async () => ({ count, max: 3, nextWouldReachLimit: false }),
    prepareDispatch: async () => ({ ok: true, attemptSequence: count + 1, selectedModel: "sonnet", errors: [] }),
  };
}

function armTimeoutDispatch(env: FakeTaskRunEnv): void {
  env.behavior.decision = { status: "ok", decision: { verdict: "delegate" } };
  env.behavior.cli = (args) => (args[0] === "claude-dispatch" ? 124 : 0);
  env.behavior.dispatchInfrastructureFailure = true;
}

test("dispatch timeout ×1: repair kaip dabar — nepakitęs infra abort, joks split", async () => {
  const env = createFakeTaskRunEnv();
  const queuedFile = seedQueue(env, DIVISIBLE_TASK);
  armTimeoutDispatch(env);
  env.ports.cheapFinish = fakeCheapFinish(1);
  const coordinator = createRunCoordinator(env.ports);

  await assert.rejects(
    () => coordinator.start(queuedFile),
    (error: Error & { taskReturnedToQueue?: boolean }) => {
      assert.match(error.message, /dispatch infrastructure failure exit=124/);
      return true;
    },
  );

  assert.ok(!env.files.has(fakeBucketPath("done", TASK_MD)), "vienas timeout dar nesplitina tėvo");
  assert.ok(!env.logs.some((line) => line.includes("TASK SPLIT (runtime-oversize)")));
});

test("dispatch timeout ×2, dalomas taskas: buildTaskSplitPlan -> vaikai queue, tėvas superseded, žurnalo eilutė", async () => {
  const env = createFakeTaskRunEnv();
  const queuedFile = seedQueue(env, DIVISIBLE_TASK);
  armTimeoutDispatch(env);
  env.ports.cheapFinish = fakeCheapFinish(2);
  const enqueueCalls: { taskId: string; decision: TaskDecision }[] = [];
  env.ports.completion.enqueueChildTasks = async (taskId, decision) => {
    enqueueCalls.push({ taskId, decision });
    return { ok: true };
  };
  const coordinator = createRunCoordinator(env.ports);

  const result = await coordinator.start(queuedFile);

  assert.equal(result, false, "split niekada nedeklaruoja sėkmės — vaikai dar nebaigti");
  assert.equal(enqueueCalls.length, 1);
  assert.equal(enqueueCalls[0]?.taskId, TASK);
  const childTasks = enqueueCalls[0]?.decision.child_tasks ?? [];
  assert.equal(childTasks.length, 2, "dvi dalys iš buildTaskSplitPlan (2 keliai, 2 veiksmai) tampa dviem vaikais");
  for (const child of childTasks) {
    assert.ok(child.title?.trim());
    assert.ok(child.claude_task?.includes("# Task"));
  }

  assert.ok(!env.files.has(fakeBucketPath("active", TASK_MD)));
  assert.ok(!env.files.has(fakeBucketPath("delegated", TASK_MD)));
  const doneFile = env.files.get(fakeBucketPath("done", TASK_MD));
  assert.ok(doneFile !== undefined, "tėvas persikėlė į done (archyvas)");
  assert.ok(doneFile?.startsWith("# Superseded"), "tėvas pažymėtas superseded stub'u");
  assert.ok(doneFile?.includes("# Task"), "originalus turinys išsaugotas po stub'u");

  assert.ok(
    env.logs.some((line) => line === "TASK SPLIT (runtime-oversize): parent=0042 parts=2 po 2 timeout"),
    "reikalaujama žurnalo eilutė",
  );
  assert.equal(env.journalEvents.at(-1)?.to_state, "superseded");
  assert.ok(env.ledgerRecords.some((entry) => entry.state === "superseded" && entry.taskId === TASK));
});

test("dispatch timeout ×2, nedalomas taskas (1 veiksmas, 1 kelias): human-review, joks split", async () => {
  const env = createFakeTaskRunEnv();
  const queuedFile = seedQueue(env, INDIVISIBLE_TASK);
  armTimeoutDispatch(env);
  env.ports.cheapFinish = fakeCheapFinish(2);
  const enqueueCalls: unknown[] = [];
  env.ports.completion.enqueueChildTasks = async () => {
    enqueueCalls.push(1);
    return { ok: true };
  };
  const coordinator = createRunCoordinator(env.ports);

  const result = await coordinator.start(queuedFile);

  assert.equal(result, false);
  assert.equal(enqueueCalls.length, 0, "nedalomas taskas niekada nekviečia enqueueChildTasks");
  assert.ok(env.files.has(fakeBucketPath("human-review", TASK_MD)));
  assert.ok(!env.files.has(fakeBucketPath("done", TASK_MD)));
  assert.ok(
    env.journalEvents.some(
      (event) => event.to_state === "human-review" && event.reason.includes("runtime_oversize_indivisible=1"),
    ),
  );
  assert.ok(!env.logs.some((line) => line.includes("TASK SPLIT (runtime-oversize)")));
});

test("repair ciklo dispatch timeout ×2 (repairTask kelias): tas pats maršrutas kaip pradinis dispatch'as", async () => {
  const env = createFakeTaskRunEnv();
  const activeFile = fakeBucketPath("active", TASK_MD);
  env.files.set(activeFile, DIVISIBLE_TASK);
  env.ports.state.readResumeState = async () => ({
    status: "ok",
    value: { task_id: TASK, phase: "verify", status: "started" },
  });
  env.behavior.repairPrompt = "# Repair Task\nfix";
  env.behavior.decision = { status: "ok", decision: { verdict: "repair" } };
  env.behavior.cli = (args) => (args[0] === "claude-dispatch" ? 124 : 0);
  env.behavior.dispatchInfrastructureFailure = true;
  env.ports.cheapFinish = fakeCheapFinish(2);
  const enqueueCalls: unknown[] = [];
  env.ports.completion.enqueueChildTasks = async () => {
    enqueueCalls.push(1);
    return { ok: true };
  };
  const coordinator = createRunCoordinator(env.ports);

  const result = await coordinator.resume("active", activeFile);

  assert.equal(result, false);
  assert.equal(enqueueCalls.length, 1, "repairTask() kelio timeout'as veda per tą patį maršrutizatorių");
  assert.ok(env.logs.some((line) => line === "TASK SPLIT (runtime-oversize): parent=0042 parts=2 po 2 timeout"));
});
