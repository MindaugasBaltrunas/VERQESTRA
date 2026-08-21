// VQ-504 (48/N) testai — grafo priežiūra, snapshot'o persistavimas ir worker prašymo atmintis.
//
// Kertinės savybės: grafo nesėkmė NESTABDO bangos, snapshot'o rašymo rezervacija grąžinama po
// klaidos, pool'o santrauka nerašoma svetimai bangai, o nepakitusi „WORKER REQUEST" eilutė
// nekartojama.

import assert from "node:assert/strict";
import { test } from "node:test";
import { createWaveGraphCoordinator, type WaveGraphDeps } from "../application/scheduling/wave-graph.js";
import { persistWaveSnapshot } from "../application/scheduling/wave-snapshot-persist.js";
import { createWaveWorkerRequestReader } from "../application/scheduling/wave-worker-request.js";
import type { TaskGraph } from "../domain/tasks/graph/model.js";
import type { WavePlan } from "../application/scheduling/schedule-next-wave.js";
import type { WaveSnapshot } from "../application/scheduling/wave-snapshot.js";
import type { WorkerPoolPlan } from "../application/scheduling/worker-pool-plan.js";
import type { LoopControlState } from "../application/scheduling/loop-control-store.js";

function graph(hash = "g1"): TaskGraph {
  return {
    graph_version: 1,
    graph_hash: hash,
    generated_at: "2026-08-21T12:00:00.000Z",
    nodes: [
      {
        task_id: "0001",
        file: "AG/tasks/queue/0001.md",
        status: "queued",
        checks: ["pnpm test"],
        scope: ["src/a.ts"],
        requires_approval: false,
        approved: false,
      },
    ],
    dependencies: [],
  } as unknown as TaskGraph;
}

function graphDeps(overrides: Partial<WaveGraphDeps> = {}): { deps: WaveGraphDeps; logs: string[]; events: string[] } {
  const logs: string[] = [];
  const events: string[] = [];
  const deps: WaveGraphDeps = {
    runId: "r1",
    importGraph: () => Promise.resolve(graph()),
    writeGraphSnapshot: () => Promise.resolve(),
    log: (message) => {
      logs.push(message);
      return Promise.resolve();
    },
    recordEvent: (event) => {
      events.push(event.event);
      return Promise.resolve();
    },
    approvals: () => [],
    readySetBudget: () => undefined,
    statuses: () => ({ completed: [], blocked: [], running: [] }),
    ...overrides,
  };
  return { deps, logs, events };
}

test("neimportuotas grafas bangos NESTABDO, bet tylos nepalieka", async () => {
  const world = graphDeps({ importGraph: () => Promise.reject(new Error("markdown sugadintas")) });
  const result = await createWaveGraphCoordinator(world.deps).refresh("w1");

  // Grafas nėra vykdymo autoritetas: be jo banga eina be draudimų.
  assert.equal(result, undefined);
  assert.ok(world.logs.some((line) => line.includes("TASK GRAPH IMPORT FAILED: markdown sugadintas")));
});

test("tas pats grafas rašomas VIENĄ kartą", async () => {
  let writes = 0;
  const world = graphDeps({
    writeGraphSnapshot: () => {
      writes += 1;
      return Promise.resolve();
    },
  });
  const coordinator = createWaveGraphCoordinator(world.deps);
  await coordinator.refresh("w1");
  await coordinator.refresh("w1");
  assert.equal(writes, 1);
});

test("nepavykęs rašymas rezervaciją GRĄŽINA", async () => {
  let writes = 0;
  const world = graphDeps({
    writeGraphSnapshot: () => {
      writes += 1;
      return writes === 1 ? Promise.reject(new Error("EPERM")) : Promise.resolve();
    },
  });
  const coordinator = createWaveGraphCoordinator(world.deps);
  await coordinator.refresh("w1");
  await coordinator.refresh("w1");

  // Be grąžinimo vienas nepavykęs rašymas amžinai įtikintų, kad snapshot'as jau yra.
  assert.equal(writes, 2);
  assert.ok(world.logs.some((line) => line.includes("SNAPSHOT WRITE FAILED")));
});

test("run'o būsena viršija grafo įrašytą", () => {
  const world = graphDeps({ statuses: () => ({ completed: ["0001"], blocked: [], running: [] }) });
  const ready = createWaveGraphCoordinator(world.deps).readySet(graph());
  // Padarytas darbas ready set'e nebesiūlomas.
  assert.equal(ready?.ready.some((entry) => entry.task_id === "0001"), false);
});

test("snapshot'o ataskaita skiria nebuvimą, atmetimą ir pasenimą", async () => {
  const first = graphDeps();
  await createWaveGraphCoordinator(first.deps).reportSnapshot({ ok: false, reason: "missing", errors: [] }, graph(), "w1");
  assert.ok(first.logs.some((line) => line.includes("none (first run)")));
  assert.deepEqual(first.events, [], "pirmas paleidimas nėra įvykis");

  const rejected = graphDeps();
  await createWaveGraphCoordinator(rejected.deps).reportSnapshot(
    { ok: false, reason: "schema", errors: ["bad"] },
    graph(),
    "w1",
  );
  assert.ok(rejected.events.includes("graph_snapshot_rejected"));

  const stale = graphDeps();
  await createWaveGraphCoordinator(stale.deps).reportSnapshot({ ok: true, graph: graph("senas") }, graph("naujas"), "w1");
  assert.ok(stale.events.includes("graph_snapshot_stale"));
});

function plan(waveId = "w1"): WavePlan {
  return {
    scheduler_version: 1,
    wave_id: waveId,
    wave_sequence: 1,
    graph_hash: "h",
    max_workers: 2,
    ready: [{ task_id: "0001", file: "AG/tasks/queue/0001.md", blocked_by: [], depth: 0 }],
    blocked: [],
    external_dependencies: [],
    cycles: [],
  };
}

function poolPlan(): WorkerPoolPlan {
  return {
    run_id: "r1",
    requested_workers: 2,
    max_workers: 2,
    mode: "parallel",
    slots: [{ worker_index: 1, worker_id: "w1", task_id: "0001", attempt: 1 }],
    rejected: [],
    verdicts: [],
    conflicts: [],
    plan_hash: "ph",
  } as unknown as WorkerPoolPlan;
}

test("be plano snapshot'as NERAŠOMAS", async () => {
  let writes = 0;
  await persistWaveSnapshot({
    runId: "r1",
    now: () => "2026-08-21T12:00:00.000Z",
    writeSnapshot: () => {
      writes += 1;
      return Promise.resolve();
    },
    state: { waveCreatedAt: "t", overrides: new Map(), liveSlots: [], refillEpisode: 0, refillLog: [] },
  });
  // Tuščias įrašas UI srautui atrodytų kaip banga be task'ų.
  assert.equal(writes, 0);
});

test("pool'o santrauka SVETIMAI bangai nerašoma", async () => {
  let written: WaveSnapshot | undefined;
  await persistWaveSnapshot({
    runId: "r1",
    now: () => "2026-08-21T12:00:00.000Z",
    writeSnapshot: (snapshot) => {
      written = snapshot;
      return Promise.resolve();
    },
    state: {
      plan: plan("w2"),
      poolPlan: poolPlan(),
      poolPlanWaveId: "w1",
      waveCreatedAt: "t",
      overrides: new Map(),
      liveSlots: [],
      refillEpisode: 0,
      refillLog: [],
    },
  });
  // Kitaip senos bangos skaičiai būtų pateikti kaip einamosios bangos faktas.
  assert.equal(written?.["worker_pool"], undefined);
});

test("tos pačios bangos pool'o santrauka rašoma", async () => {
  let written: WaveSnapshot | undefined;
  await persistWaveSnapshot({
    runId: "r1",
    now: () => "2026-08-21T12:00:00.000Z",
    writeSnapshot: (snapshot) => {
      written = snapshot;
      return Promise.resolve();
    },
    state: {
      plan: plan("w1"),
      poolPlan: poolPlan(),
      poolPlanWaveId: "w1",
      waveCreatedAt: "t",
      overrides: new Map(),
      liveSlots: [],
      refillEpisode: 0,
      refillLog: [],
    },
  });
  assert.equal(written?.["worker_pool"]?.["plan_hash"], "ph");
});

function control(mode: string): LoopControlState {
  return { slots: { w1: { mode }, w2: { mode } } } as LoopControlState;
}

test("nepakitusi WORKER REQUEST eilutė antrą kartą NERAŠOMA", async () => {
  const logs: string[] = [];
  const read = createWaveWorkerRequestReader({
    readRequest: () => Promise.resolve({ requested: 2 }),
    readControl: () => Promise.resolve(control("run")),
    log: (message) => {
      logs.push(message);
      return Promise.resolve();
    },
  });

  assert.equal(await read(), 2);
  assert.equal(await read(), 2);
  // Be atminties operatoriaus žurnalas prisipildytų nepakitusios būsenos.
  assert.equal(logs.length, 1);
});

test("pasikeitęs valdiklis eilutę rašo iš naujo", async () => {
  const logs: string[] = [];
  let mode = "run";
  const read = createWaveWorkerRequestReader({
    readRequest: () => Promise.resolve({ requested: 2 }),
    readControl: () => Promise.resolve(control(mode)),
    log: (message) => {
      logs.push(message);
      return Promise.resolve();
    },
  });

  await read();
  mode = "drain";
  assert.equal(await read(), 1, "sustabdyti slot'ai nenuleidžia žemiau vieno");
  assert.equal(logs.length, 2);
  assert.ok(logs[1]?.includes("control=w1:drain"));
});
