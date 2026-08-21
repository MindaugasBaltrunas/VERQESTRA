// VQ-504 (46/N) testai — bangos integracijos vykdymas.
//
// Prikalama tai, kas negrįžtama: kelio nesutapimas sustabdo PRIEŠ suliejimą, `dist` perstatymo
// nesėkmė neleidžia darbui praeiti kaip sėkmei, o kiekvienas nepavykęs žingsnis baigiasi ŽMOGAUS
// peržiūra, ne tyliu praleidimu.

import assert from "node:assert/strict";
import { test } from "node:test";
import { createWaveIntegrationCoordinator, type WaveIntegrationCoordinatorPorts } from "../application/scheduling/wave-integration-coordinator.js";
import { computeTaskWriteSet } from "../application/scheduling/conflict-detector.js";
import { createWorkerLease } from "../application/scheduling/worker-lease-store.js";
import type { FinishedWorkerSlot, IntegrationCheckpoint } from "../application/scheduling/worker-integration.js";
import type { BranchIntegrationOutcome, TaskRelocation } from "../application/scheduling/wave-integration-ports.js";
import type { WorkerLease } from "../domain/scheduling/worker-lease-rules.js";

const NOW = new Date("2026-08-21T12:00:00.000Z");

function lease(taskId: string, workerId: string): WorkerLease {
  return createWorkerLease(
    { owner_id: "loop-1", run_id: "r1", worker_id: workerId, task_id: taskId, attempt: 1 },
    { now: NOW, fencingToken: 1, worktreePath: `.worktrees/${workerId}` },
  );
}

function finished(taskId: string, workerIndex: number): FinishedWorkerSlot {
  const workerId = `w${workerIndex}`;
  return {
    worker_id: workerId,
    worker_index: workerIndex,
    task_id: taskId,
    file: `AG/tasks/active/${taskId}.md`,
    attempt: 1,
    succeeded: true,
    write_set: computeTaskWriteSet({ task_id: taskId, allowed_paths: [`src/${taskId}.ts`] }),
    worktree_path: `.worktrees/${workerId}`,
    lease: lease(taskId, workerId),
  };
}

const QUIESCENT: IntegrationCheckpoint = {
  tree_quiescent: true,
  live_task_ids: [],
  release_lease_ids: [],
  reason: "medis nurimęs",
};

type World = {
  ports: WaveIntegrationCoordinatorPorts;
  logs: string[];
  events: { event: string; reason?: string | undefined }[];
  calls: { merged: string[]; rebuilds: number; pushes: number; cleanups: string[]; released: string[] };
  parked: () => boolean;
};

function world(options: {
  slots?: FinishedWorkerSlot[];
  merge?: BranchIntegrationOutcome;
  worktreeRelativePath?: string;
  touchedSrc?: boolean;
  rebuildOk?: boolean;
  relocate?: (taskId: string, bucket: string) => Promise<TaskRelocation>;
  restoreOk?: boolean;
  locate?: () => Promise<"terminal-bucket" | "queue">;
  layoutThrows?: boolean;
} = {}): World {
  const logs: string[] = [];
  const events: World["events"] = [];
  const calls: World["calls"] = { merged: [], rebuilds: 0, pushes: 0, cleanups: [], released: [] };
  const slots = options.slots ?? [finished("0042", 2)];

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
    resolveWorktreeLayout: (identity) => {
      if (options.layoutThrows === true) throw new Error("maketas neišspręstas");
      return {
        relativePath: options.worktreeRelativePath ?? `.worktrees/${identity.worker_id}`,
        branch: `ag/${identity.task_id}`,
      };
    },
    locateTask: options.locate ?? (() => Promise.resolve("terminal-bucket")),
    resolvePrimaryHead: () => Promise.resolve("headbefore"),
    integrateBranch: ({ task_id }) => {
      calls.merged.push(task_id);
      return Promise.resolve(options.merge ?? { status: "integrated", mode: "merge", head: "headafter" });
    },
    integrationTouchedSrc: () => Promise.resolve(options.touchedSrc ?? true),
    rebuildDist: () => {
      calls.rebuilds += 1;
      return Promise.resolve(
        options.rebuildOk === false ? { ok: false, detail: "tsc krito" } : { ok: true, detail: "" },
      );
    },
    pushPrimaryBranch: () => {
      calls.pushes += 1;
      return Promise.resolve({ ok: true, branch: "main" });
    },
    relocateTask: options.relocate ?? (() => Promise.resolve("moved")),
    restoreDoneCopy: () =>
      Promise.resolve(
        options.restoreOk === false ? { ok: false, detail: "istorijoje nėra" } : { ok: true, source: "HEAD^:AG/..." },
      ),
    cleanupWorktree: ({ identity }) => {
      calls.cleanups.push(identity.task_id);
      return Promise.resolve({ worktree: "removed", branch: "deleted", detail: "" });
    },
    releaseLease: (leaseId) => {
      calls.released.push(leaseId);
      return Promise.resolve("released");
    },
    finishedSlots: new Map(slots.map((slot) => [slot.task_id, slot])),
    releasedLeaseIds: new Set<string>(),
    liveSlots: () => [],
  };

  return { ports, logs, events, calls, parked: () => events.some((entry) => entry.event === "worker_integration_parked") };
}

test("sėkmingas kelias: merge → dist → push → lease → failas → valymas", async () => {
  const w = world();
  await createWaveIntegrationCoordinator(w.ports).integrateFinishedSlots(QUIESCENT);

  assert.deepEqual(w.calls.merged, ["0042"]);
  assert.equal(w.calls.rebuilds, 1);
  assert.equal(w.calls.pushes, 1);
  assert.deepEqual(w.calls.cleanups, ["0042"]);
  assert.equal(w.calls.released.length, 1);
  assert.ok(w.events.some((entry) => entry.event === "worker_integration_completed"));
  // Slot'as IŠIMAMAS: likęs sąraše jis būtų integruotas antrą kartą kitame checkpoint'e.
  assert.equal(w.ports.finishedSlots.size, 0);
});

test("kelio nesutapimas sustabdo PRIEŠ suliejimą", async () => {
  const w = world({ worktreeRelativePath: ".worktrees/svetimas" });
  await createWaveIntegrationCoordinator(w.ports).integrateFinishedSlots(QUIESCENT);

  // Lease ir slot'as kalba apie skirtingas kopijas — suliejimas paimtų svetimą darbą.
  assert.deepEqual(w.calls.merged, []);
  assert.ok(w.parked());
  assert.ok(w.logs.some((line) => line.includes("worktree-path-mismatch")));
});

test("neišspręstas maketas: parkinama, nieko neliečiant", async () => {
  const w = world({ layoutThrows: true });
  await createWaveIntegrationCoordinator(w.ports).integrateFinishedSlots(QUIESCENT);

  assert.deepEqual(w.calls.merged, []);
  assert.ok(w.logs.some((line) => line.includes("layout-unresolved")));
});

test("suliejimo konfliktas NEVALO kopijos — darbas lieka žmogui", async () => {
  const w = world({ merge: { status: "conflict", paths: ["src/a.ts"] } });
  await createWaveIntegrationCoordinator(w.ports).integrateFinishedSlots(QUIESCENT);

  assert.equal(w.calls.rebuilds, 0);
  assert.deepEqual(w.calls.cleanups, [], "kopija su neintegruotu darbu neliečiama");
  assert.deepEqual(w.calls.released, [], "lease neatlaisvinamas: nuosavybė dar reikalinga");
  assert.ok(w.parked());
});

test("dingusi šaka PRAEINA tik jei task'as jau terminaliniame bucket'e", async () => {
  const trace = world({ merge: { status: "absent" } });
  await createWaveIntegrationCoordinator(trace.ports).integrateFinishedSlots(QUIESCENT);
  assert.equal(trace.parked(), false, "ankstesnės integracijos pėdsakas");
  assert.equal(trace.calls.rebuilds, 0, "nėra ko perstatyti: naujo commit'o nebuvo");

  const lost = world({ merge: { status: "absent" }, locate: () => Promise.resolve("queue") });
  await createWaveIntegrationCoordinator(lost.ports).integrateFinishedSlots(QUIESCENT);
  assert.ok(lost.parked(), "šakos nebėra, o task'as tebėra eilėje — darbas prarastas");
});

test("`dist` neperstatomas, kai suliejimas `src` nepalietė", async () => {
  const w = world({ touchedSrc: false });
  await createWaveIntegrationCoordinator(w.ports).integrateFinishedSlots(QUIESCENT);
  assert.equal(w.calls.rebuilds, 0);
  assert.deepEqual(w.calls.cleanups, ["0042"]);
});

test("`dist` perstatymo nesėkmė STABDO integraciją", async () => {
  const w = world({ rebuildOk: false });
  await createWaveIntegrationCoordinator(w.ports).integrateFinishedSlots(QUIESCENT);

  // Sulietas kodas su senu dist yra būsena, kurios niekas nepatikrino.
  assert.equal(w.calls.pushes, 0);
  assert.deepEqual(w.calls.cleanups, []);
  assert.ok(w.logs.some((line) => line.includes("dist-rebuild-failed")));
});

test("dingęs task failas ATSTATOMAS iš istorijos", async () => {
  const w = world({ relocate: () => Promise.resolve("absent") });
  await createWaveIntegrationCoordinator(w.ports).integrateFinishedSlots(QUIESCENT);

  assert.ok(w.logs.some((line) => line.includes("TASK FILE RESTORED")));
  assert.deepEqual(w.calls.cleanups, ["0042"]);
});

test("neatstatytas task failas keliauja žmogui, o kopija lieka", async () => {
  const w = world({ relocate: () => Promise.resolve("absent"), restoreOk: false });
  await createWaveIntegrationCoordinator(w.ports).integrateFinishedSlots(QUIESCENT);

  assert.ok(w.logs.some((line) => line.includes("done-copy-restore-failed")));
  assert.deepEqual(w.calls.cleanups, []);
});

test("likutis po valymo integracijos NEATŠAUKIA, bet ĮVARDIJAMAS", async () => {
  const w = world();
  w.ports.cleanupWorktree = () =>
    Promise.resolve({ worktree: "quarantined", branch: "skipped", detail: "nešvarus medis" });
  await createWaveIntegrationCoordinator(w.ports).integrateFinishedSlots(QUIESCENT);

  assert.ok(w.logs.some((line) => line.includes("COMPLETED WITH RESIDUE")));
  assert.ok(w.events.some((entry) => entry.event === "worker_integration_completed"));
});

test("nenurimęs medis be gyvų slot'ų sąrašo NIEKO neintegruoja", async () => {
  const w = world();
  await createWaveIntegrationCoordinator(w.ports).integrateFinishedSlots({
    tree_quiescent: false,
    live_task_ids: ["0043"],
    release_lease_ids: [],
    reason: "dirba w1",
  });

  assert.deepEqual(w.calls.merged, []);
  assert.equal(w.ports.finishedSlots.size, 1, "slot'as lieka laukti tylos");
});

test("bangos lease'ai atlaisvinami tik tie, kurių žingsnis neatlaisvino", async () => {
  const slot = finished("0042", 2);
  const w = world({ slots: [slot] });
  await createWaveIntegrationCoordinator(w.ports).integrateFinishedSlots({
    ...QUIESCENT,
    release_lease_ids: [slot.lease?.lease_id ?? "?", "kitas-lease"],
  });

  // Tas pats lease antrą kartą nekviečiamas: žurnale tai atrodytų kaip antras įvykis.
  assert.deepEqual(w.calls.released.filter((id) => id === slot.lease?.lease_id).length, 1);
  assert.ok(w.calls.released.includes("kitas-lease"));
});

test("praleisto task'o failas: perkėlimo nesėkmė eskaluojama, ne nutylima", async () => {
  const w = world({
    relocate: () => Promise.reject(new Error("EPERM")),
  });
  const result = await createWaveIntegrationCoordinator(w.ports).closeSkipCompletedTaskFile("0042", "jau padaryta");

  assert.deepEqual(result, { relocation: "absent", state: "escalated" });
  assert.ok(w.logs.some((line) => line.includes("WAVE RESUME TASK MOVE FAILED")));
});

test("praleisto task'o failas: dingęs failas atstatomas ir laikomas `done`", async () => {
  const w = world({ relocate: () => Promise.resolve("absent") });
  const result = await createWaveIntegrationCoordinator(w.ports).closeSkipCompletedTaskFile("0042", "jau padaryta");

  assert.deepEqual(result, { relocation: "restored", state: "done" });
});
