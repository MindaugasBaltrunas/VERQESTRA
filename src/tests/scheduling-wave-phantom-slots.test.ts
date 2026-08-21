// VQ-504 (41/N) testai — fantominių slot'ų aptikimas ir gyvų slot'ų registras.
//
// Fantomas pavojingas tuo, kad PLANE atrodo tvarkingai: be šios patikros loop'as jį
// dispatch'intų, o bangos gale dar ir priskirtų rezultatą darbui, kurio niekas nedirbo.
// Testai prikala visas penkias fantomo veisles ir vieną atvejį, kuris fantomu NĖRA.

import assert from "node:assert/strict";
import { test } from "node:test";
import { detectPhantomWaveSlots } from "../application/scheduling/wave-phantom-slots.js";
import { candidateWriteSet, createLiveSlotRegistry } from "../application/scheduling/wave-live-slots.js";
import type { WorkerLease } from "../domain/scheduling/worker-lease-rules.js";
import type { WorkerPoolPlan } from "../application/scheduling/worker-pool-plan.js";
import type { LiveSlot } from "../application/scheduling/slot-refill.js";
import type { WorkerCandidate } from "../application/scheduling/worker-pool-admission.js";

const NOW = new Date("2026-08-21T12:00:00.000Z");

function lease(overrides: Partial<WorkerLease> = {}): WorkerLease {
  return {
    lease_id: "L1",
    run_id: "r1",
    worker_id: "w2",
    task_id: "0042",
    status: "held",
    acquired_at: "2026-08-21T11:00:00.000Z",
    expires_at: "2026-08-21T13:00:00.000Z",
    fencing_token: 1,
    ...overrides,
  } as WorkerLease;
}

function pool(
  slot: Record<string, unknown> = {},
  rejected: WorkerPoolPlan["rejected"] = [],
): WorkerPoolPlan {
  return {
    run_id: "r1",
    requested_workers: 2,
    max_workers: 2,
    mode: "parallel",
    slots: [{ worker_index: 2, worker_id: "w2", task_id: "0042", attempt: 1, lease_id: "L1", ...slot }],
    rejected,
    verdicts: [],
    conflicts: [],
    plan_hash: "h",
  } as unknown as WorkerPoolPlan;
}

test("slot'as be lease'o IR be darbo kopijos NĖRA fantomas", () => {
  // Tai pirminis (in-process) kelias — jam izoliacijos įrodymų nereikia.
  const phantom = detectPhantomWaveSlots(
    pool({ worker_index: 1, worker_id: "w1", lease_id: undefined, worktree_path: undefined }),
    [],
    NOW,
  );
  assert.deepEqual(phantom, []);
});

test("gyvas, teisingas lease NĖRA fantomas", () => {
  assert.deepEqual(detectPhantomWaveSlots(pool(), [lease()], NOW), []);
});

test("penkios fantomo veislės atpažįstamos atskirai", () => {
  const cases: { name: string; phantom: ReturnType<typeof detectPhantomWaveSlots> }[] = [
    {
      name: "plan-rejected",
      phantom: detectPhantomWaveSlots(
        pool({}, [{ task_id: "0042", reason: "missing-lease", detail: "nera" }] as WorkerPoolPlan["rejected"]),
        [lease()],
        NOW,
      ),
    },
    { name: "lease-absent", phantom: detectPhantomWaveSlots(pool(), [], NOW) },
    { name: "lease-inactive", phantom: detectPhantomWaveSlots(pool(), [lease({ status: "released" })], NOW) },
    {
      name: "lease-expired",
      phantom: detectPhantomWaveSlots(pool(), [lease({ expires_at: "2026-08-21T11:30:00.000Z" })], NOW),
    },
    { name: "lease-task-mismatch", phantom: detectPhantomWaveSlots(pool(), [lease({ task_id: "0099" })], NOW) },
  ];

  for (const entry of cases) {
    assert.equal(entry.phantom.length, 1, entry.name);
    assert.equal(entry.phantom[0]?.reason, entry.name);
    // Detalė privalo įvardyti KONKRETŲ lease'ą ar priežastį — be jos eilutė nediagnozuoja.
    assert.ok((entry.phantom[0]?.detail ?? "").length > 0, entry.name);
  }
});

test("ne-izoliacinis atmetimas fantomo NEDARO", () => {
  // Konfliktuojantis write-set yra normalus planavimo sprendimas, ne sugedęs slot'as.
  const phantom = detectPhantomWaveSlots(
    pool({}, [{ task_id: "0042", reason: "write-set-conflict", detail: "sankirta" }] as WorkerPoolPlan["rejected"]),
    [lease()],
    NOW,
  );
  assert.deepEqual(phantom, []);
});

test("gyvų slot'ų registras rikiuoja pagal worker_index", async () => {
  const liveSlots = new Map<string, LiveSlot>();
  const registry = createLiveSlotRegistry({
    now: () => "2026-08-21T12:00:00.000Z",
    graph: () => undefined,
    readWorkerLeases: () => Promise.resolve([]),
    safeLog: () => Promise.resolve(),
    admittedCandidates: new Map<string, WorkerCandidate>(),
    liveSlots,
  });

  await registry.register({
    task: { task_id: "0002", file: "AG/tasks/queue/0002.md" },
    pool: { slots: [{ worker_id: "w2", worker_index: 2, task_id: "0002", attempt: 1 }] },
  });
  await registry.register({
    task: { task_id: "0001", file: "AG/tasks/queue/0001.md" },
    pool: { slots: [{ worker_id: "w1", worker_index: 1, task_id: "0001", attempt: 1 }] },
  });

  // Tvarka stabili: snapshot'as lyginamas tarp ratų, tad ji yra kontraktas.
  assert.deepEqual(registry.list().map((slot) => slot.worker_id), ["w1", "w2"]);
});

test("be plano slot'o registruojamas PIRMINIS slot'as (w1, indeksas 1)", async () => {
  const liveSlots = new Map<string, LiveSlot>();
  const registry = createLiveSlotRegistry({
    now: () => "t",
    graph: () => undefined,
    readWorkerLeases: () => Promise.resolve([]),
    safeLog: () => Promise.resolve(),
    admittedCandidates: new Map<string, WorkerCandidate>(),
    liveSlots,
  });

  await registry.register({ task: { task_id: "0001", file: "f.md" }, pool: { slots: [] } });

  const slot = registry.list()[0];
  assert.equal(slot?.worker_id, "w1");
  assert.equal(slot?.worker_index, 1, "numeracija 1-based, ne 0");
});

test("lease atkūrimo KLAIDA nenuverčia registro", async () => {
  const liveSlots = new Map<string, LiveSlot>();
  const logs: string[] = [];
  const registry = createLiveSlotRegistry({
    now: () => "t",
    graph: () => undefined,
    readWorkerLeases: () => Promise.reject(new Error("store dingo")),
    safeLog: (message) => {
      logs.push(message);
      return Promise.resolve();
    },
    admittedCandidates: new Map<string, WorkerCandidate>(),
    liveSlots,
  });

  await registry.register({
    task: { task_id: "0042", file: "f.md" },
    pool: { slots: [{ worker_id: "w2", worker_index: 2, task_id: "0042", attempt: 1, lease_id: "L1" }] },
  });

  // Slot'as be lease įrašo yra teisingesnis nei nulūžęs registras — izoliaciją tikrina fantomai.
  assert.equal(registry.list().length, 1);
  assert.ok(logs.some((line) => line.includes("LIVE SLOT LEASE REHYDRATE FAILED")));
});

test("candidateWriteSet be grafo duoda tuščią scope, o ne meta", () => {
  const writeSet = candidateWriteSet("0042", undefined);
  assert.equal(writeSet.task_id, "0042");
});
