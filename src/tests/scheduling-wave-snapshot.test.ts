// VQ-504 (38/N) testai — bangos snapshot'o projekcija.
//
// Pin'inama tai, kas skiria SNAPSHOT'ą nuo PLANO: vykdymo override'ai nugali plano būseną,
// iš eilės pasitraukęs task'as lieka istorijoje, o tvarka yra stabili (nestabili tvarka
// kiekvieną perrašymą paverstų „pokyčiu", ir UI srautas transliuotų neįvykusius įvykius).

import assert from "node:assert/strict";
import { test } from "node:test";
import type { WavePlan } from "../application/scheduling/schedule-next-wave.js";
import {
  WAVE_SNAPSHOT_SCHEMA_VERSION,
  buildWaveSnapshot,
  waveSnapshotSchema,
  type WaveTaskStateOverride,
} from "../application/scheduling/wave-snapshot.js";

function plan(overrides: Partial<WavePlan> = {}): WavePlan {
  return {
    scheduler_version: 1,
    wave_id: "w1",
    wave_sequence: 1,
    graph_hash: "abc123",
    max_workers: 1,
    ready: [{ task_id: "0002", file: "AG/tasks/queue/0002.md", blocked_by: [], depth: 0 }],
    blocked: [
      {
        task_id: "0001",
        file: "AG/tasks/queue/0001.md",
        blocked_by: ["0002"],
        reason: "unsatisfied-dependency",
        waiting_for: ["0002"],
      },
    ],
    external_dependencies: [],
    cycles: [],
    ...overrides,
  };
}

test("planas be override'ų: ready ir blocked patenka su savo būsenomis", () => {
  const snapshot = buildWaveSnapshot(plan(), { runId: "r1", createdAt: "2026-08-21T00:00:00.000Z" });

  assert.equal(snapshot.schema_version, WAVE_SNAPSHOT_SCHEMA_VERSION);
  assert.equal(snapshot.run_id, "r1");
  // `updated_at` be atskiros reikšmės lygus `created_at`: snapshot'as dar nebuvo atnaujintas.
  assert.equal(snapshot.updated_at, snapshot.created_at);

  const states = new Map(snapshot.tasks.map((task) => [task.task_id, task.state]));
  assert.equal(states.get("0002"), "ready");
  assert.equal(states.get("0001"), "blocked");
  assert.equal(snapshot.tasks.find((task) => task.task_id === "0001")?.reason, "unsatisfied-dependency");
});

test("tvarka STABILI ir nepriklauso nuo plano eiliškumo", () => {
  const forward = buildWaveSnapshot(plan(), { runId: "r1", createdAt: "t" });
  const reversed = buildWaveSnapshot(
    plan({
      ready: [{ task_id: "0002", file: "AG/tasks/queue/0002.md", blocked_by: [], depth: 0 }],
      blocked: [
        {
          task_id: "0001",
          file: "AG/tasks/queue/0001.md",
          blocked_by: ["0002"],
          reason: "unsatisfied-dependency",
          waiting_for: ["0002"],
        },
      ],
    }),
    { runId: "r1", createdAt: "t" },
  );
  assert.deepEqual(
    forward.tasks.map((task) => task.file),
    reversed.tasks.map((task) => task.file),
  );
  // Rūšiuojama pagal kelią: 0001 prieš 0002, nors plane `ready` buvo pirmas.
  assert.deepEqual(forward.tasks.map((task) => task.task_id), ["0001", "0002"]);
});

test("override NUGALI plano būseną ir prideda bandymų skaičių", () => {
  const overrides = new Map<string, WaveTaskStateOverride>([["0002", { state: "running", attempts: 2 }]]);
  const snapshot = buildWaveSnapshot(plan(), { runId: "r1", createdAt: "t", overrides });

  const task = snapshot.tasks.find((entry) => entry.task_id === "0002");
  assert.equal(task?.state, "running");
  assert.equal(task?.attempts, 2);
});

test("override be priežasties NEIŠTRINA plano priežasties", () => {
  const overrides = new Map<string, WaveTaskStateOverride>([["0001", { state: "running" }]]);
  const snapshot = buildWaveSnapshot(plan(), { runId: "r1", createdAt: "t", overrides });

  const task = snapshot.tasks.find((entry) => entry.task_id === "0001");
  assert.equal(task?.state, "running");
  // „running" neturi savo priežasties, bet task'as vis dar žinomas kaip anksčiau blokuotas.
  assert.equal(task?.reason, "unsatisfied-dependency");
});

test("iš eilės PASITRAUKĘS task'as lieka istorijoje, kai override turi `file`", () => {
  const overrides = new Map<string, WaveTaskStateOverride>([
    ["0009", { state: "done", file: "AG/tasks/done/0009.md", attempts: 1 }],
  ]);
  const snapshot = buildWaveSnapshot(plan(), { runId: "r1", createdAt: "t", overrides });

  const closed = snapshot.tasks.find((entry) => entry.task_id === "0009");
  assert.equal(closed?.state, "done");
  assert.equal(closed?.file, "AG/tasks/done/0009.md");
});

test("override BE `file` ir be plano įrašo praleidžiamas", () => {
  const overrides = new Map<string, WaveTaskStateOverride>([["0009", { state: "done" }]]);
  const snapshot = buildWaveSnapshot(plan(), { runId: "r1", createdAt: "t", overrides });

  // Įrašas be kelio nieko nepasakytų — geriau jo nerodyti, nei rodyti tuščią eilutę.
  assert.equal(snapshot.tasks.some((entry) => entry.task_id === "0009"), false);
});

test("schema atmeta max_workers virš kietos ribos", () => {
  // Paralelizmas virš ribos privalo būti NEGALIOJANTIS įrašas, o ne tyliai priimtas.
  assert.throws(() =>
    waveSnapshotSchema.parse({
      run_id: "r1",
      wave_id: "w1",
      graph_hash: "abc",
      max_workers: 3,
      created_at: "t",
      updated_at: "t",
    }),
  );
});

test("schema PRALEIDŽIA senesnį snapshot'ą be vėliau pridėtų laukų", () => {
  // Diske gulintys snapshot'ai be `worker_pool`/`refill` privalo likti validūs — kitaip
  // atnaujinimas atimtų bangos tęstinumą.
  const parsed = waveSnapshotSchema.parse({
    run_id: "r1",
    wave_id: "w1",
    graph_hash: "abc",
    created_at: "t",
    updated_at: "t",
  });
  assert.equal(parsed.max_workers, 1);
  assert.deepEqual(parsed.live_slots, []);
  assert.equal(parsed.worker_pool, undefined);
});
