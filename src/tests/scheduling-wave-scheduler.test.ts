// VQ-504 (49/N) testai — bangos planuoklio gyvavimo ciklas.
//
// Prikalama tai, kas laiko izoliaciją ir idempotenciją: slot'ų talpa gaunama iš LEIDIMO sprendimo,
// duplikatas fiksuojamas PRIEŠ vykdymą, nevykdytinas task'as blokuoja visą šaką, o resume kelias
// eina per tuos pačius vartus kaip įprastas.

import assert from "node:assert/strict";
import { test } from "node:test";
import { createWaveScheduler, type WaveSchedulerDeps } from "../application/scheduling/wave-scheduler.js";
import { computeTaskWriteSet } from "../application/scheduling/conflict-detector.js";
import type { SchedulableTask } from "../application/scheduling/schedule-next-wave.js";
import type { WorkerCandidate } from "../application/scheduling/worker-pool-admission.js";
import type { WaveProvisioningCoordinator } from "../application/scheduling/wave-provisioning.js";
import type { WaveIntegrationIo } from "../application/scheduling/wave-scheduler.js";
import type { SchedulerCheckpoint } from "../application/scheduling/wave-scheduler-contract.js";
import type { TaskGraph } from "../domain/tasks/graph/model.js";

const NOW = "2026-08-21T12:00:00.000Z";

function tasks(): SchedulableTask[] {
  return [
    { task_id: "0001", file: "AG/tasks/queue/0001.md", blocked_by: [] },
    { task_id: "0002", file: "AG/tasks/queue/0002.md", blocked_by: ["0001"] },
  ];
}

function emptyGraph(): TaskGraph {
  return { graph_version: 1, graph_hash: "g0", generated_at: NOW, nodes: [], dependencies: [] } as unknown as TaskGraph;
}

const integrationIo: WaveIntegrationIo = {
  resolveWorktreeLayout: (identity) => ({ relativePath: `.worktrees/${identity.worker_id}`, branch: `ag/${identity.task_id}` }),
  locateTask: () => Promise.resolve("terminal-bucket"),
  resolvePrimaryHead: () => Promise.resolve("head"),
  integrateBranch: () => Promise.resolve({ status: "integrated", mode: "merge", head: "head2" }),
  integrationTouchedSrc: () => Promise.resolve(false),
  rebuildDist: () => Promise.resolve({ ok: true, detail: "" }),
  pushPrimaryBranch: () => Promise.resolve({ ok: true, branch: "main" }),
  relocateTask: () => Promise.resolve("moved"),
  restoreDoneCopy: () => Promise.resolve({ ok: true, source: "HEAD^" }),
  cleanupWorktree: () => Promise.resolve({ worktree: "removed", branch: "deleted", detail: "" }),
  releaseLease: () => Promise.resolve("released"),
};

const provisioningCoordinator: WaveProvisioningCoordinator = {
  toWorkerCandidates: (list) =>
    list.map(
      (task): WorkerCandidate => ({
        task_id: task.task_id,
        file: task.file,
        write_set: computeTaskWriteSet({ task_id: task.task_id, allowed_paths: [`src/${task.task_id}.ts`] }),
      }),
    ),
  readIsolationInputs: () => Promise.resolve({ leases: [] }),
  provisionSlotLease: () => Promise.resolve(false),
  provisionMissingSlotLeases: () => Promise.resolve([]),
  releaseWaveProvisionLease: () => Promise.resolve(),
  candidateWriteSet: (taskId) => computeTaskWriteSet({ task_id: taskId, allowed_paths: [`src/${taskId}.ts`] }),
};

type World = {
  deps: WaveSchedulerDeps;
  logs: string[];
  events: { event: string; task_id?: string | undefined; reason?: string | undefined }[];
  snapshots: number;
  checkpoints: { status: string; task_id?: string }[];
};

function world(options: {
  taskList?: SchedulableTask[];
  checkpoint?: SchedulerCheckpoint | undefined;
  duplicate?: boolean;
  workers?: number;
  locate?: () => Promise<"terminal-bucket" | "queue" | "resumable-bucket" | "absent">;
  accepted?: boolean;
  relocate?: () => Promise<"moved" | "already" | "kept" | "absent">;
} = {}): World {
  const logs: string[] = [];
  const events: World["events"] = [];
  const checkpoints: World["checkpoints"] = [];
  const state = { snapshots: 0 };

  const deps: WaveSchedulerDeps = {
    projectRoot: "D:/repo",
    runId: "r1",
    now: () => NOW,
    log: (message) => {
      logs.push(message);
      return Promise.resolve();
    },
    absolutePath: (file) => `D:/repo/${file}`,
    readTasks: () => Promise.resolve(options.taskList ?? tasks()),
    locateTask: options.locate ?? (() => Promise.resolve("queue")),
    hasAcceptedWork: () => Promise.resolve(options.accepted ?? false),
    readCheckpoint: () => Promise.resolve(options.checkpoint),
    readSnapshot: () => Promise.resolve(undefined),
    writeSnapshot: () => {
      state.snapshots += 1;
      return Promise.resolve();
    },
    recordEvent: (event) => {
      events.push({ event: event.event, task_id: event.task_id, reason: event.reason });
      return Promise.resolve();
    },
    recordCheckpoint: (checkpoint) => {
      checkpoints.push({ status: checkpoint.status, ...(checkpoint.task_id === undefined ? {} : { task_id: checkpoint.task_id }) });
      return Promise.resolve();
    },
    importGraph: () => Promise.resolve(emptyGraph()),
    writeGraphSnapshot: () => Promise.resolve(),
    readGraphSnapshot: () => Promise.resolve({ ok: false, reason: "missing", errors: [] }),
    readySetBudget: () => Promise.resolve(undefined),
    approvals: () => [],
    requestedWorkers: () => Promise.resolve(options.workers ?? 1),
    ledgerDuplicate: () => Promise.resolve(options.duplicate ?? false),
    integration: { ...integrationIo, ...(options.relocate === undefined ? {} : { relocateTask: options.relocate }) },
    // Fabrikas: planuoklis paduoda savo būseną, o testui pakanka vienos konstantos.
    provisioning: () => provisioningCoordinator,
    readWorkerLeases: () => Promise.resolve([]),
  };

  return {
    deps,
    logs,
    events,
    checkpoints,
    get snapshots() {
      return state.snapshots;
    },
  };
}

test("tuščia eilė grąžina `empty`", async () => {
  const w = world({ taskList: [] });
  assert.deepEqual(await createWaveScheduler(w.deps).nextTask(), { kind: "empty" });
});

test("pirmas task'as gauna absoliutų kelią ir pool'o planą", async () => {
  const w = world();
  const selection = await createWaveScheduler(w.deps).nextTask();

  assert.equal(selection.kind, "task");
  if (selection.kind !== "task") return;
  assert.equal(selection.task.task_id, "0001");
  assert.equal(selection.absoluteFile, "D:/repo/AG/tasks/queue/0001.md");
  assert.equal(selection.pool.slots.length >= 1, true);
});

test("paleidus blokatorių, likusi šaka duoda `exhausted`, o ne tylą", async () => {
  const w = world();
  const scheduler = createWaveScheduler(w.deps);
  const first = await scheduler.nextTask();
  assert.equal(first.kind, "task");
  if (first.kind !== "task") return;
  await scheduler.beginTask(first);

  const second = await scheduler.nextTask();
  assert.equal(second.kind, "exhausted");
  if (second.kind !== "exhausted") return;
  // 0002 laukia 0001 — kol tas dirba, banga neturi ką siūlyti, ir tai ĮVARDIJAMA.
  assert.equal(second.reason, "all-blocked");
  assert.ok(w.events.some((entry) => entry.event === "wave_blocked"));
});

test("antras task'as be laisvo slot'o META, o ne tyliai praeina", async () => {
  const w = world({ taskList: [
    { task_id: "0001", file: "AG/tasks/queue/0001.md", blocked_by: [] },
    { task_id: "0002", file: "AG/tasks/queue/0002.md", blocked_by: [] },
  ] });
  const scheduler = createWaveScheduler(w.deps);
  const first = await scheduler.nextTask();
  if (first.kind !== "task") throw new Error("laukiamas task");
  await scheduler.beginTask(first);

  // Tyliai leisti dar vieną task'ą reikštų neizoliuotą paralelizmą be konfliktų verdikto.
  await assert.rejects(
    () => scheduler.beginTask({ ...first, task: { ...first.task, task_id: "0002", file: "AG/tasks/queue/0002.md" } }),
    /still running/,
  );
});

test("duplikatas fiksuojamas PRIEŠ vykdymą", async () => {
  const w = world({ duplicate: true });
  const scheduler = createWaveScheduler(w.deps);
  const selection = await scheduler.nextTask();
  if (selection.kind !== "task") throw new Error("laukiamas task");
  await scheduler.beginTask(selection);
  await scheduler.recordOutcome("0001", false);

  // Po vykdymo eilės failo nebelieka, tad be šio įrašo slot'as būtų užverstas kaip žlugęs.
  assert.equal(scheduler.isSlotWithdrawn("0001"), true);
});

test("ledger'io klaida dispatch'o NENUTRAUKIA", async () => {
  const w = world();
  w.deps.ledgerDuplicate = () => Promise.reject(new Error("ledger unreadable"));
  const scheduler = createWaveScheduler(w.deps);
  const selection = await scheduler.nextTask();
  if (selection.kind !== "task") throw new Error("laukiamas task");

  await scheduler.beginTask(selection);
  assert.ok(w.logs.some((line) => line.includes("DUPLICATE PROBE FAILED")));
  assert.ok(w.events.some((entry) => entry.event === "task_started"));
});

test("`beginTask` rašo checkpoint'ą ir įvykį", async () => {
  const w = world();
  const scheduler = createWaveScheduler(w.deps);
  const selection = await scheduler.nextTask();
  if (selection.kind !== "task") throw new Error("laukiamas task");
  await scheduler.beginTask(selection);

  assert.deepEqual(w.checkpoints, [{ status: "started", task_id: "0001" }]);
  assert.ok(w.events.some((entry) => entry.event === "task_started" && entry.task_id === "0001"));
});

test("nevykdytinas task'as blokuoja VISĄ šaką, bet nėra `failed`", async () => {
  const w = world();
  const scheduler = createWaveScheduler(w.deps);
  await scheduler.nextTask();
  await scheduler.blockUnrunnableTask("0001", "adapteris neprieinamas");

  assert.ok(w.events.some((entry) => entry.event === "task_branch_blocked" && entry.task_id === "0001"));
  const next = await scheduler.nextTask();
  // 0002 priklauso nuo 0001 — jo vykdyti negalima.
  assert.equal(next.kind === "task" ? next.task.task_id : next.kind, "exhausted");
});

test("resume be checkpoint'o nieko nerašo į žurnalą", async () => {
  const w = world();
  const decision = await createWaveScheduler(w.deps).recoverFromCrash();

  assert.equal(decision.action, "no-checkpoint");
  assert.equal(w.events.some((entry) => entry.event === "resume_decision"), false);
});

test("priimtas darbas per resume UŽDAROMAS, o ne kartojamas", async () => {
  const w = world({
    checkpoint: { status: "finished", task_id: "0001", updated_at: NOW },
    locate: () => Promise.resolve("terminal-bucket"),
    accepted: true,
  });
  const scheduler = createWaveScheduler(w.deps);
  const decision = await scheduler.recoverFromCrash();

  assert.equal(decision.action, "skip-completed");
  assert.ok(w.logs.some((line) => line.includes("WAVE RESUME TASK CLOSED")));
  assert.ok(w.events.some((entry) => entry.event === "resume_task_closed"));

  // Uždarytas task'as antrą kartą nebesiūlomas.
  const next = await scheduler.nextTask();
  assert.equal(next.kind === "task" ? next.task.task_id : next.kind, "0002");
});

test("neatstatytas task failas per resume ESKALUOJAMAS", async () => {
  const w = world({
    checkpoint: { status: "finished", task_id: "0001", updated_at: NOW },
    locate: () => Promise.resolve("terminal-bucket"),
    accepted: true,
    relocate: () => Promise.resolve("absent"),
  });
  w.deps.integration = { ...w.deps.integration, restoreDoneCopy: () => Promise.resolve({ ok: false, detail: "istorijoje nėra" }) };

  await createWaveScheduler(w.deps).recoverFromCrash();
  assert.ok(w.logs.some((line) => line.includes("WAVE RESUME TASK ESCALATED")));
});

test("kiekvienas perskaičiavimas persistuoja snapshot'ą", async () => {
  const w = world();
  const scheduler = createWaveScheduler(w.deps);
  await scheduler.nextTask();
  assert.ok(w.snapshots >= 1);
});
