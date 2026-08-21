// VQ-504 (43/N) testai — bangos task'o baigties apskaita.
//
// Svarbiausia, ką jie pin'ina: NEPAVYKĘS ir ATŠAUKTAS slot'as nėra tas pats. Dublikatas, kuris
// niekada nedirbo, neturi nei degti kaip nesėkmė, nei gauti balso pool'o verdikte.

import assert from "node:assert/strict";
import { test } from "node:test";
import { createWaveOutcomeRecorder, type WaveOutcomeDeps } from "../application/scheduling/wave-outcome.js";
import type { LiveSlot } from "../application/scheduling/slot-refill.js";
import type { FinishedWorkerSlot } from "../application/scheduling/worker-integration.js";
import type { WorkerOutcome, WorkerPoolPlan } from "../application/scheduling/worker-pool-plan.js";
import type { SchedulableTask } from "../application/scheduling/schedule-next-wave.js";

type World = {
  deps: WaveOutcomeDeps;
  settled: { taskId: string; state: string; reason?: string }[];
  logs: string[];
  events: string[];
  unjudged: string[];
  outcomes: Map<string, WorkerOutcome>;
  integrations: number;
};

function world(options: {
  liveSlot?: Partial<LiveSlot>;
  duplicate?: boolean;
  pool?: WorkerPoolPlan | undefined;
  tasks?: SchedulableTask[];
} = {}): World {
  const settled: World["settled"] = [];
  const logs: string[] = [];
  const events: string[] = [];
  const unjudged: string[] = [];
  const outcomes = new Map<string, WorkerOutcome>();
  const state = { integrations: 0 };

  const liveSlots = new Map<string, LiveSlot>();
  liveSlots.set("w1", {
    worker_id: "w1",
    worker_index: 1,
    task_id: "0042",
    file: "AG/tasks/active/0042.md",
    attempt: 1,
    write_set: { task_id: "0042", paths: [], symbols: [], architecture_nodes: [] },
    started_at: "t",
    ...options.liveSlot,
  } as LiveSlot);

  const deps: WaveOutcomeDeps = {
    runId: "r1",
    tasks: () => options.tasks ?? [],
    waveContext: () => ({ waveId: "w1", graphHash: "h", refillEpisode: 0 }),
    poolPlan: () => options.pool,
    liveSlots,
    finishedSlots: new Map<string, FinishedWorkerSlot>(),
    duplicateAtDispatch: new Set(options.duplicate === true ? ["0042"] : []),
    withdrawnTasks: new Set<string>(),
    runningTaskIds: new Set<string>(["0042"]),
    completed: new Set<string>(),
    blockedBranch: new Set<string>(),
    markUnjudged: (workerId) => unjudged.push(workerId),
    outcomesFor: () => outcomes,
    judgedPlan: (pool) => pool,
    settle: (taskId, stateName, reason) => settled.push({ taskId, state: stateName, ...(reason === undefined ? {} : { reason }) }),
    liveSlotList: () => [...liveSlots.values()],
    persist: () => Promise.resolve(),
    safeLog: (message) => {
      logs.push(message);
      return Promise.resolve();
    },
    safeEvent: (event) => {
      events.push(event.event);
      return Promise.resolve();
    },
    log: (message) => {
      logs.push(message);
      return Promise.resolve();
    },
    recordEvent: (event) => {
      events.push(event.event);
      return Promise.resolve();
    },
    recordCheckpoint: () => Promise.resolve(),
    integrateFinishedSlots: () => {
      state.integrations += 1;
      return Promise.resolve();
    },
  };

  return {
    deps,
    settled,
    logs,
    events,
    unjudged,
    outcomes,
    get integrations() {
      return state.integrations;
    },
  };
}

function pool(): WorkerPoolPlan {
  return {
    run_id: "r1",
    requested_workers: 1,
    max_workers: 1,
    mode: "sequential",
    slots: [{ worker_index: 1, worker_id: "w1", task_id: "0042", attempt: 1 }],
    rejected: [],
    verdicts: [],
    conflicts: [],
    plan_hash: "ph",
  } as unknown as WorkerPoolPlan;
}

test("sėkmė: task'as užsidaro `done` ir gauna balsą pool'o verdikte", async () => {
  const w = world({ pool: pool() });
  await createWaveOutcomeRecorder(w.deps)("0042", true);

  assert.deepEqual(w.settled, [{ taskId: "0042", state: "done", reason: "task_completed" }]);
  assert.equal(w.outcomes.get("w1")?.status, "succeeded");
  assert.ok(w.deps.completed.has("0042"));
  assert.equal(w.deps.liveSlots.size, 0, "gyvas slot'as atlaisvinamas");
});

test("nesėkmė: blokuojama VISA šaka, o slot'as skaičiuojamas kaip žlugęs", async () => {
  const tasks: SchedulableTask[] = [
    { task_id: "0042", file: "a.md", blocked_by: [] },
    { task_id: "0043", file: "b.md", blocked_by: ["0042"] },
  ];
  const w = world({ pool: pool(), tasks });
  await createWaveOutcomeRecorder(w.deps)("0042", false);

  assert.equal(w.outcomes.get("w1")?.status, "failed");
  const states = new Map(w.settled.map((entry) => [entry.taskId, entry.state]));
  assert.equal(states.get("0042"), "failed");
  // Priklausinys negali būti vykdomas ant darbo, kurio nėra.
  assert.equal(states.get("0043"), "blocked");
});

test("ATŠAUKTAS dublikatas nėra žlugęs slot'as ir NEGAUNA balso", async () => {
  const w = world({ pool: pool(), duplicate: true });
  await createWaveOutcomeRecorder(w.deps)("0042", false);

  assert.ok(w.deps.withdrawnTasks.has("0042"));
  // Kertinė savybė: verdikte balso nėra — statistika nerodo nesėkmės ten, kur nebuvo bandymo.
  assert.equal(w.outcomes.size, 0);
  assert.ok(w.unjudged.includes("w1"));
  assert.ok(w.logs.some((line) => line.includes("WAVE SLOT WITHDRAWN")));
  assert.ok(w.events.includes("worker_slot_withdrawn"));
  assert.deepEqual(
    w.settled.map((entry) => entry.reason),
    ["task_duplicate"],
  );
});

test("dublikatas SU darbo kopija yra tikra nesėkmė, ne atšaukimas", async () => {
  // Kopija reiškia, kad worker'is jau turėjo izoliuotą vietą — jo baigtis tikra, nesvarbu
  // kaip task'as atsirado.
  const w = world({ pool: pool(), duplicate: true, liveSlot: { worktree_path: "/wt/w2" } });
  await createWaveOutcomeRecorder(w.deps)("0042", false);

  assert.equal(w.deps.withdrawnTasks.size, 0);
  assert.equal(w.outcomes.get("w1")?.status, "failed");
});

test("atšauktas slot'as į `finishedSlots` NEPATENKA", async () => {
  const w = world({ pool: pool(), duplicate: true });
  await createWaveOutcomeRecorder(w.deps)("0042", false);
  assert.equal(w.deps.finishedSlots.size, 0);
});

test("vieno slot'o banga be kopijos integracijos NESUKA", async () => {
  const w = world({ pool: pool() });
  await createWaveOutcomeRecorder(w.deps)("0042", true);
  // Integruoti nėra ko, o mechanikos sukimas kiekvienam task'ui būtų tuščias darbas.
  assert.equal(w.integrations, 0);
});

test("darbo kopija bangoje integraciją ĮJUNGIA", async () => {
  const w = world({ pool: pool(), liveSlot: { worktree_path: "/wt/w2" } });
  await createWaveOutcomeRecorder(w.deps)("0042", true);
  assert.equal(w.integrations, 1);
  assert.ok(w.events.includes("task_integration_ready"));
});
