// 152-a-02: koordinatorius prieš planWorkerIntegration kviečia ports.locateTask atkurtiems
// (`restored: true`) slot'ams ir perduoda planui task id sąrašą, kurių bucket'as `queue`.
//
// Be šio sąrašo operatoriaus į `queue` grąžintas task'as po loop'o restarto parkuojamas kaip
// `task-failed`, nors jo baigtis tiesiog nežinoma (proceso lūžis, ne task'o kaltė).

import assert from "node:assert/strict";
import { test } from "node:test";
import { createWaveIntegrationCoordinator, type WaveIntegrationCoordinatorPorts } from "../application/scheduling/wave-integration-coordinator.js";
import type { FinishedWorkerSlot, IntegrationCheckpoint } from "../application/scheduling/worker-integration.js";
import type { BranchIntegrationOutcome, TaskLocation } from "../application/scheduling/wave-integration-ports.js";

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
