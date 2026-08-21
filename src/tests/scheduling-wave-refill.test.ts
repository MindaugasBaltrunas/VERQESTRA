// VQ-504 (44/N) testai — atsilaisvinusio slot'o papildymas.
//
// Papildymas yra vieta, kur lengviausia pažeisti izoliaciją: naujas task'as gauna jau dirbusio
// worker'io vietą. Testai prikala tris apsaugas — sulaikymas be planavimo, jau vykdomų task'ų
// išmetimas ir nepanaudoto lease'o atlaisvinimas.

import assert from "node:assert/strict";
import { test } from "node:test";
import { createWaveRefillCoordinator, workerIndexOf, type WaveRefillDeps } from "../application/scheduling/wave-refill.js";
import type { WavePlan, WaveReadyTask } from "../application/scheduling/schedule-next-wave.js";
import type { WorkerCandidate } from "../application/scheduling/worker-pool-admission.js";
import { computeTaskWriteSet } from "../application/scheduling/conflict-detector.js";
import type { SlotProvisionTarget } from "../application/scheduling/wave-pool-planning.js";

function writeSet(taskId: string): WorkerCandidate["write_set"] {
  return computeTaskWriteSet({ task_id: taskId, allowed_paths: [`src/${taskId}.ts`] });
}

function candidateOf(task: WaveReadyTask): WorkerCandidate {
  return { task_id: task.task_id, file: task.file, write_set: writeSet(task.task_id) };
}

const READY: WaveReadyTask[] = [
  { task_id: "0001", file: "AG/tasks/queue/0001.md", blocked_by: [], depth: 0 },
  { task_id: "0002", file: "AG/tasks/queue/0002.md", blocked_by: [], depth: 0 },
];

function plan(ready: WaveReadyTask[] = READY): WavePlan {
  return {
    scheduler_version: 1,
    wave_id: "w1",
    wave_sequence: 1,
    graph_hash: "h",
    max_workers: 2,
    ready,
    blocked: [],
    external_dependencies: [],
    cycles: [],
  };
}

type Recorded = { logs: string[]; events: string[]; provisioned: SlotProvisionTarget[]; released: string[]; replans: number };

function coordinator(overrides: Partial<WaveRefillDeps> = {}): { deps: WaveRefillDeps; recorded: Recorded } {
  const recorded: Recorded = { logs: [], events: [], provisioned: [], released: [], replans: 0 };
  const deps: WaveRefillDeps = {
    absolutePath: (file) => `/repo/${file}`,
    runId: "r1",
    primaryClaimSupported: false,
    now: () => "2026-08-21T12:00:00.000Z",
    log: (message) => {
      recorded.logs.push(message);
      return Promise.resolve();
    },
    recordEvent: (event) => {
      recorded.events.push(event.event);
      return Promise.resolve();
    },
    context: () => ({ waveId: "w1", graphHash: "h", requestedWorkers: 2 }),
    nextEpisode: () => 1,
    appendDecision: () => {},
    persist: () => Promise.resolve(),
    replan: () => {
      recorded.replans += 1;
      return Promise.resolve(plan());
    },
    liveSlots: () => [],
    isRunning: () => false,
    hasStarted: () => false,
    readIsolationInputs: () => Promise.resolve({ leases: [] }),
    toWorkerCandidates: (tasks) => tasks.map(candidateOf),
    provisionSlotLease: (target) => {
      recorded.provisioned.push(target);
      return Promise.resolve(true);
    },
    releaseUnusedProvision: (workerId, taskId) => {
      recorded.released.push(`${workerId}:${taskId}`);
      return Promise.resolve();
    },
    rememberCandidate: () => {},
    candidateWriteSet: (taskId) => writeSet(taskId),
    ...overrides,
  };
  return { deps, recorded };
}

test("workerIndexOf: neatpažinta forma duoda pirminį slot'ą", () => {
  assert.equal(workerIndexOf("w2"), 2);
  assert.equal(workerIndexOf("w1"), 1);
  assert.equal(workerIndexOf("keista"), 1, "saugus default'as, ne 0 ir ne NaN");
  assert.equal(workerIndexOf("w0"), 1);
});

test("SULAIKYTAS slot'as neplanuoja ir net neperskaičiuoja bangos", async () => {
  const world = coordinator();
  const result = await createWaveRefillCoordinator(world.deps).refillSlot("w2", {
    kind: "slot-drained",
    detail: "operatorius sustabdė slot'ą",
  });

  assert.equal(result, undefined);
  // Kertinė savybė: sulaikytas slot'as nedalyvauja net kandidatų atrankoje.
  assert.equal(world.recorded.replans, 0);
  assert.ok(world.recorded.logs.some((line) => line.includes("WORKER POOL REFILL")));
});

test("atsisakymas papildyti irgi yra ĮVYKIS", async () => {
  // Be jo operatorius negalėtų atskirti „nebuvo kandidatų" nuo „papildymas neįvyko dėl klaidos".
  const world = coordinator({ replan: () => Promise.resolve(plan([])) });
  const result = await createWaveRefillCoordinator(world.deps).refillSlot("w2", { kind: "none" });

  assert.equal(result, undefined);
  assert.ok(world.recorded.events.includes("worker_slot_refill_declined"));
});

test("jau vykdomi task'ai į kandidatus NEPATENKA", async () => {
  const seen: string[][] = [];
  const world = coordinator({
    isRunning: (taskId) => taskId === "0001",
    toWorkerCandidates: (tasks) => {
      seen.push(tasks.map((task) => task.task_id));
      return [];
    },
  });
  await createWaveRefillCoordinator(world.deps).refillSlot("w2", { kind: "none" });

  // Kitaip tas pats task'as gautų antrą slot'ą.
  assert.deepEqual(seen[0], ["0002"]);
});

test("jau startavę task'ai irgi išmetami", async () => {
  const seen: string[][] = [];
  const world = coordinator({
    hasStarted: (taskId) => taskId === "0002",
    toWorkerCandidates: (tasks) => {
      seen.push(tasks.map((task) => task.task_id));
      return [];
    },
  });
  await createWaveRefillCoordinator(world.deps).refillSlot("w2", { kind: "none" });
  assert.deepEqual(seen[0], ["0001"]);
});

test("lease išduodamas TIK dėl `missing-lease`, ir nepanaudotas ATLAISVINAMAS", async () => {
  // Kandidatų nėra po perplanavimo, tad išduotas lease lieka nepanaudotas.
  let call = 0;
  const world = coordinator({
    toWorkerCandidates: (tasks) => {
      call += 1;
      // Pirmas kvietimas duoda kandidatą be lease'o; antras (po išdavimo) — nieko.
      return call === 1 ? tasks.map(candidateOf) : [];
    },
  });

  const result = await createWaveRefillCoordinator(world.deps).refillSlot("w2", { kind: "none" });

  assert.equal(result, undefined);
  // `w2` be lease'o atmetamas būtent kaip `missing-lease`, tad išdavimas privalo įvykti.
  assert.equal(world.recorded.provisioned.length, 1);
  assert.equal(world.recorded.provisioned[0]?.worker_index, 2);
  // Be atlaisvinimo lease kabotų visą TTL ir blokuotų to task'o dispatch'ą.
  assert.deepEqual(world.recorded.released, [`w2:${world.recorded.provisioned[0]?.task_id ?? "?"}`]);
});

test("papildymas perskaičiuoja bangą IŠ NAUJO", async () => {
  const world = coordinator({ toWorkerCandidates: () => [] });
  await createWaveRefillCoordinator(world.deps).refillSlot("w2", { kind: "none" });
  // Per tą laiką kiti slot'ai jau galėjo užimti kelius — senas planas būtų melagingas.
  assert.equal(world.recorded.replans, 1);
});
