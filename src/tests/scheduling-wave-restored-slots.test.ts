// 152-a-02: koordinatorius prieš planWorkerIntegration kviečia ports.locateTask atkurtiems
// (`restored: true`) slot'ams ir perduoda planui task id sąrašą, kurių bucket'as `queue`.
//
// Be šio sąrašo operatoriaus į `queue` grąžintas task'as po loop'o restarto parkuojamas kaip
// `task-failed`, nors jo baigtis tiesiog nežinoma (proceso lūžis, ne task'o kaltė).

import assert from "node:assert/strict";
import { test } from "node:test";
import { createWaveIntegrationCoordinator, type WaveIntegrationCoordinatorPorts } from "../application/scheduling/wave-integration-coordinator.js";
import { createWaveScheduler, type WaveIntegrationIo, type WaveSchedulerDeps } from "../application/scheduling/wave-scheduler.js";
import { computeTaskWriteSet } from "../application/scheduling/conflict-detector.js";
import type { FinishedWorkerSlot, IntegrationCheckpoint } from "../application/scheduling/worker-integration.js";
import type { BranchIntegrationOutcome, TaskLocation } from "../application/scheduling/wave-integration-ports.js";
import type { SchedulableTask } from "../application/scheduling/schedule-next-wave.js";
import type { WorkerCandidate } from "../application/scheduling/worker-pool-admission.js";
import type { WaveProvisioningCoordinator } from "../application/scheduling/wave-provisioning.js";
import type { WaveSnapshot } from "../application/scheduling/wave-snapshot.js";
import type { TaskGraph } from "../domain/tasks/graph/model.js";
import { buildTaskGraph } from "../domain/tasks/graph/build.js";

const QUIESCENT: IntegrationCheckpoint = {
  tree_quiescent: true,
  live_task_ids: [],
  release_lease_ids: [],
  reason: "medis nurimęs",
};

function restoredSlot(taskId: string): FinishedWorkerSlot {
  return {
    worker_id: "w2",
    worker_index: 2,
    task_id: taskId,
    file: `AG/tasks/queue/${taskId}.md`,
    attempt: 1,
    succeeded: false,
    worktree_path: `.worktrees/w2`,
    restored: true,
  };
}

type World = {
  ports: WaveIntegrationCoordinatorPorts;
  logs: string[];
  events: { event: string; reason?: string | undefined }[];
  parked: () => boolean;
};

function world(options: {
  slots?: FinishedWorkerSlot[];
  locate?: (taskId: string) => Promise<TaskLocation>;
  merge?: BranchIntegrationOutcome;
} = {}): World {
  const logs: string[] = [];
  const events: World["events"] = [];
  const slots = options.slots ?? [restoredSlot("0042")];

  const ports: WaveIntegrationCoordinatorPorts = {
    runId: "r1",
    waveContext: () => ({ waveId: "w1", graphHash: "h" }),
    safeLog: (message) => {
      logs.push(message);
      return Promise.resolve();
    },
    safeEvent: (event) => {
      events.push({ event: event.event, reason: event.reason });
      return Promise.resolve();
    },
    resolveWorktreeLayout: (identity) => ({
      relativePath: `.worktrees/${identity.worker_id}`,
      branch: `ag/${identity.task_id}`,
    }),
    locateTask: options.locate ?? (() => Promise.resolve("queue")),
    resolvePrimaryHead: () => Promise.resolve("headbefore"),
    integrateBranch: () => Promise.resolve(options.merge ?? { status: "integrated", mode: "merge", head: "headafter" }),
    integrationTouchedSrc: () => Promise.resolve(true),
    rebuildDist: () => Promise.resolve({ ok: true, detail: "" }),
    pushPrimaryBranch: () => Promise.resolve({ ok: true, branch: "main" }),
    relocateTask: () => Promise.resolve("moved"),
    restoreDoneCopy: () => Promise.resolve({ ok: true, source: "HEAD^:AG/..." }),
    collectWorktreeTelemetry: () => Promise.resolve({ appended: 0, detail: "" }),
    cleanupWorktree: () => Promise.resolve({ worktree: "removed", branch: "deleted", detail: "" }),
    releaseLease: () => Promise.resolve("released"),
    finishedSlots: new Map(slots.map((slot) => [slot.task_id, slot])),
    releasedLeaseIds: new Set<string>(),
    liveSlots: () => [],
  };

  return { ports, logs, events, parked: () => events.some((entry) => entry.event === "worker_integration_parked") };
}

test("atkurtas slot'as + locateTask=queue: jokio parko, slot'as išimtas, task'as vėl dispatch'inamas", async () => {
  const w = world({ locate: () => Promise.resolve("queue") });
  await createWaveIntegrationCoordinator(w.ports).integrateFinishedSlots(QUIESCENT);

  assert.equal(w.parked(), false, "atkūrimas nėra nesėkmė — task-failed parkas čia meluotų apie kaltę");
  assert.equal(w.ports.finishedSlots.size, 0, "slot'as išimtas, kad neužstrigtų vėlesniuose checkpoint'uose");
  assert.ok(w.logs.some((line) => line.includes("restored-requeued")));
});

test("atkurtas slot'as + locateTask=human-review: parkas kaip anksčiau", async () => {
  const w = world({ locate: () => Promise.resolve("terminal-bucket") });
  await createWaveIntegrationCoordinator(w.ports).integrateFinishedSlots(QUIESCENT);

  assert.ok(w.parked(), "task'as NEgrąžintas į queue — baigtis lieka task-failed");
  assert.equal(w.ports.finishedSlots.size, 0);
});

test("atkurtas slot'as + locateTask=absent: parkas kaip anksčiau (bucket'as nežinomas)", async () => {
  const w = world({ locate: () => Promise.resolve("absent") });
  await createWaveIntegrationCoordinator(w.ports).integrateFinishedSlots(QUIESCENT);

  assert.ok(w.parked());
  assert.equal(w.ports.finishedSlots.size, 0);
});

test("atkurtas slot'as + locateTask meta klaidą: parkas kaip anksčiau, klaida ĮVARDIJAMA", async () => {
  const w = world({ locate: () => Promise.reject(new Error("ENOENT: AG/tasks nerastas")) });
  await createWaveIntegrationCoordinator(w.ports).integrateFinishedSlots(QUIESCENT);

  assert.ok(w.parked(), "locateTask klaida = bucket'as nežinomas, fail-closed parkas kaip anksčiau");
  assert.equal(w.ports.finishedSlots.size, 0);
  assert.ok(
    w.logs.some((line) => line.includes("WAVE RESTORED SLOT LOCATE FAILED") && line.includes("ENOENT")),
    "klaida rašoma žurnale, ne nutylima",
  );
});

test("locateTask kviečiamas TIK atkurtiems slot'ams, ne įprastam sėkmingam slot'ui", async () => {
  const ordinary: FinishedWorkerSlot = {
    worker_id: "w3",
    worker_index: 3,
    task_id: "0099",
    file: "AG/tasks/queue/0099.md",
    attempt: 1,
    succeeded: false,
    worktree_path: ".worktrees/w3",
  };
  const located: string[] = [];
  const w = world({
    slots: [restoredSlot("0042"), ordinary],
    locate: (taskId) => {
      located.push(taskId);
      return Promise.resolve("queue");
    },
  });
  await createWaveIntegrationCoordinator(w.ports).integrateFinishedSlots(QUIESCENT);

  assert.deepEqual(located, ["0042"], "tik restored slot'as tikrinamas per locateTask");
});

// Audito P1 (2026-09-05, task 166): `planPool` planavo kandidatus iš VISO `current.ready`, o
// `selectNextWaveTask` (kuris renka `selection.task`) tuos pačius kandidatus filtravo per
// `started ∪ finishedSlots`. Nesutapę filtrai leisdavo `pool.slots` gauti slot'ą jau `started`
// arba atkurtam (crash'o po nesulietos šakos) task'ui — jis būtų dispatch'intas per SAVO worker
// slot'ą lygiagrečiai su tuo, kurį jau vykdo `selected.task`, nors dėl to jis ir buvo pašalintas
// iš pasirinkimo.

function twoTaskList(): SchedulableTask[] {
  return [
    { task_id: "0001", file: "AG/tasks/queue/0001.md", blocked_by: [] },
    { task_id: "0002", file: "AG/tasks/queue/0002.md", blocked_by: [] },
  ];
}

function twoTaskGraph(list: readonly SchedulableTask[]): TaskGraph {
  return buildTaskGraph({
    nodes: list.map((task) => ({
      task_id: task.task_id,
      file: task.file,
      checks: ["pnpm test"],
      scope: [`src/${task.task_id}.ts`],
    })),
  });
}

const schedulerIntegrationIo: WaveIntegrationIo = {
  resolveWorktreeLayout: (identity) => ({ relativePath: `.worktrees/${identity.worker_id}`, branch: `ag/${identity.task_id}` }),
  locateTask: () => Promise.resolve("queue"),
  resolvePrimaryHead: () => Promise.resolve("head"),
  integrateBranch: () => Promise.resolve({ status: "integrated", mode: "merge", head: "head2" }),
  integrationTouchedSrc: () => Promise.resolve(false),
  rebuildDist: () => Promise.resolve({ ok: true, detail: "" }),
  pushPrimaryBranch: () => Promise.resolve({ ok: true, branch: "main" }),
  relocateTask: () => Promise.resolve("moved"),
  restoreDoneCopy: () => Promise.resolve({ ok: true, source: "HEAD^" }),
  collectWorktreeTelemetry: () => Promise.resolve({ appended: 0, detail: "" }),
  cleanupWorktree: () => Promise.resolve({ worktree: "removed", branch: "deleted", detail: "" }),
  releaseLease: () => Promise.resolve("released"),
};

const schedulerProvisioning: WaveProvisioningCoordinator = {
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
  provisionMissingSlotLeases: () => Promise.resolve({ provisioned: [], lastOutcomeByTask: new Map() }),
  releaseWaveProvisionLease: () => Promise.resolve(),
};

function schedulerDeps(options: { taskList: SchedulableTask[]; workers: number; snapshot?: WaveSnapshot | undefined }): WaveSchedulerDeps {
  return {
    projectRoot: "D:/repo",
    runId: "r1",
    now: () => "2026-09-05T12:00:00.000Z",
    log: () => Promise.resolve(),
    absolutePath: (file) => `D:/repo/${file}`,
    readTasks: () => Promise.resolve(options.taskList),
    locateTask: () => Promise.resolve("queue"),
    hasAcceptedWork: () => Promise.resolve(false),
    readCheckpoint: () => Promise.resolve(undefined),
    readSnapshot: () => Promise.resolve(options.snapshot),
    writeSnapshot: () => Promise.resolve(),
    recordEvent: () => Promise.resolve(),
    recordCheckpoint: () => Promise.resolve(),
    importGraph: () => Promise.resolve(twoTaskGraph(options.taskList)),
    writeGraphSnapshot: () => Promise.resolve(),
    readGraphSnapshot: () => Promise.resolve({ ok: false, reason: "missing", errors: [] }),
    readySetBudget: () => Promise.resolve(undefined),
    approvals: () => [],
    requestedWorkers: () => Promise.resolve(options.workers),
    ledgerDuplicate: () => Promise.resolve(false),
    integration: schedulerIntegrationIo,
    provisioning: () => schedulerProvisioning,
    readWorkerLeases: () => Promise.resolve([]),
  };
}

test("planPool NEĮTRAUKIA jau `started` task'o kandidato antram slotui (task 166)", async () => {
  const scheduler = createWaveScheduler(schedulerDeps({ taskList: twoTaskList(), workers: 2 }));

  const first = await scheduler.nextTask();
  assert.equal(first.kind, "task");
  if (first.kind !== "task") return;
  await scheduler.beginTask(first);

  // `current.ready` VIS DAR turi "0001" (scheduleNextWave apie `started` nežino) — be filtro
  // `planPool` jį vėl paverstų kandidatu ir PIRMINIU slot'u antram planavimui, nors jis jau dirba.
  const second = await scheduler.nextTask();
  assert.equal(second.kind, "task");
  if (second.kind !== "task") return;
  assert.equal(second.task.task_id, "0002", "selectNextWaveTask jau atmeta 0001 — pool'as privalo sutapti");
  assert.ok(
    !second.pool.slots.some((slot) => slot.task_id === "0001"),
    "jau paleistas task'as neturi gauti antro pool slot'o — tai dispatch'intų jį lygiagrečiai su savimi",
  );
});

// Antra dalis to paties audito radinio: `recoverFromCrash` niekada nekvietė integracijos, tad
// vienos likusios eilutės banga po crash'o su nesulieta šaka amžinai grįždavo `already-started`.
test("vienintelis eilėje esantis atkurtas slot'as išsprendžiamas recoverFromCrash metu — nextTask NĖRA `exhausted`", async () => {
  const singleTask = [twoTaskList()[0] as SchedulableTask];
  const snapshot: WaveSnapshot = {
    schema_version: 2,
    scheduler_version: 1,
    run_id: "r1",
    wave_id: "w0",
    wave_sequence: 1,
    graph_hash: "stale",
    decision_hash: "",
    max_workers: 1,
    created_at: "2026-09-05T11:00:00.000Z",
    updated_at: "2026-09-05T11:00:00.000Z",
    tasks: [],
    external_dependencies: [],
    cycles: [],
    live_slots: [],
    finished_slots: [
      {
        worker_id: "w2",
        worker_index: 2,
        task_id: "0001",
        attempt: 1,
        branch: "",
        worktree_path: ".worktrees/w2",
        finished_at: "2026-09-05T11:00:00.000Z",
      },
    ],
  };
  const scheduler = createWaveScheduler(schedulerDeps({ taskList: singleTask, workers: 1, snapshot }));

  await scheduler.recoverFromCrash();
  const next = await scheduler.nextTask();

  // `schedulerIntegrationIo.locateTask` grąžina "queue" — task'as jau eilėje, tad koordinatorius
  // jį praleidžia kaip `restored-requeued` (152), o ne parkuoja: dispatch'as leidžiamas iš naujo.
  assert.equal(next.kind, "task", "atkurtas slot'as išspręstas PRIEŠ pirmą nextTask, banga nebeužstringa");
  if (next.kind !== "task") return;
  assert.equal(next.task.task_id, "0001");
});
