// VQ-504 (58/N) testai — pilnas aktyvaus attempt'o resolveris.
//
// Prikalama tapatybės išvedimo TVARKA (env → bangos snapshot'as → resume checkpoint'ai), tai, kad
// negaliojantis kandidatas praleidžiamas, o ne blokuoja bandymą, ir du kietieji atsisakymai:
// `create:false` nieko nekuria, o svetimas manifestas neperrašomas NIEKADA.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { resolveActiveAttempt } from "../infrastructure/state/active-attempt.js";

const NOW = "2026-08-21T12:00:00.000Z";

async function workspace(): Promise<{ projectRoot: string; runtimeRoot: string }> {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "vq-504-attempt-"));
  const runtimeRoot = path.join(projectRoot, "vq");
  await mkdir(path.join(runtimeRoot, "state"), { recursive: true });
  return { projectRoot, runtimeRoot };
}

async function writeState(runtimeRoot: string, name: string, value: unknown): Promise<void> {
  await writeFile(path.join(runtimeRoot, "state", name), JSON.stringify(value), "utf8");
}

test("išjungtas kill switch grąžina `disabled`, nieko neskaitęs", async () => {
  const world = await workspace();
  try {
    const result = await resolveActiveAttempt({
      taskId: "0042",
      ...world,
      env: { AG_RUNTIME_ARTIFACTS: "0" },
      now: () => NOW,
    });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, "disabled");
  } finally {
    await rm(world.projectRoot, { recursive: true, force: true });
  }
});

test("be jokio run įrodymo — `no-runtime`, o ne klaida", async () => {
  const world = await workspace();
  try {
    const result = await resolveActiveAttempt({ taskId: "0042", ...world, env: {}, now: () => NOW });
    // Tai NORMALI repo be runtime būsena: loop'as jos dar nesukūrė.
    assert.equal(result.ok === false && result.reason, "no-runtime");
  } finally {
    await rm(world.projectRoot, { recursive: true, force: true });
  }
});

test("neteisėtas task id atmetamas kaip `invalid-identity`", async () => {
  const world = await workspace();
  try {
    const result = await resolveActiveAttempt({
      taskId: "../pabegimas",
      ...world,
      env: { AG_RUN_ID: "r1" },
      now: () => NOW,
    });
    assert.equal(result.ok === false && result.reason, "invalid-identity");
  } finally {
    await rm(world.projectRoot, { recursive: true, force: true });
  }
});

test("`create:false` namespace'o NESUKURIA", async () => {
  const world = await workspace();
  try {
    const result = await resolveActiveAttempt({ taskId: "0042", ...world, env: { AG_RUN_ID: "r1" }, now: () => NOW });
    // Telemetrija neturi teisės pradėti bandymo.
    assert.equal(result.ok === false && result.reason, "not-created");
  } finally {
    await rm(world.projectRoot, { recursive: true, force: true });
  }
});

test("`create:true` sukuria namespace'ą su tapatybe iš env", async () => {
  const world = await workspace();
  try {
    const result = await resolveActiveAttempt({
      taskId: "0042",
      ...world,
      create: true,
      env: { AG_RUN_ID: "r1", AG_WORKER_ID: "w2", AG_ATTEMPT_ID: "a3" },
      now: () => NOW,
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.attempt.manifest.run_id, "r1");
    assert.equal(result.attempt.manifest.worker_id, "w2");
    assert.equal(result.attempt.manifest.attempt_id, "a3");
  } finally {
    await rm(world.projectRoot, { recursive: true, force: true });
  }
});

test("bangos snapshot'as duoda `run_id`, kai env tylus", async () => {
  const world = await workspace();
  try {
    await writeState(world.runtimeRoot, "wave-snapshot.json", { run_id: "r-snapshot", wave_id: "w7", graph_hash: "h" });
    const result = await resolveActiveAttempt({ taskId: "0042", ...world, create: true, env: {}, now: () => NOW });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.attempt.manifest.run_id, "r-snapshot");
    assert.equal(result.attempt.manifest.wave_id, "w7", "bangos id irgi ateina iš snapshot'o");
  } finally {
    await rm(world.projectRoot, { recursive: true, force: true });
  }
});

test("resume checkpoint'as yra TREČIAS šaltinis, ir TASK'O įrašas nugali naujesnį", async () => {
  const world = await workspace();
  try {
    await writeState(world.runtimeRoot, "claude-resume.json", {
      run_id: "r-svetimas",
      task_id: "0099",
      updated_at: "2026-08-21T13:00:00.000Z",
    });
    await writeState(world.runtimeRoot, "supervisor-resume.json", {
      run_id: "r-mano",
      task_id: "0042",
      updated_at: "2026-08-21T11:00:00.000Z",
    });

    const result = await resolveActiveAttempt({ taskId: "0042", ...world, create: true, env: {}, now: () => NOW });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    // Ta pati TAPATYBĖ svarbesnė už naujesnį laiką.
    assert.equal(result.attempt.manifest.run_id, "r-mano");
  } finally {
    await rm(world.projectRoot, { recursive: true, force: true });
  }
});

test("negaliojantis kandidatas PRALEIDŽIAMAS, ne blokuoja", async () => {
  const world = await workspace();
  try {
    await writeState(world.runtimeRoot, "wave-snapshot.json", { run_id: "../blogas" });
    await writeState(world.runtimeRoot, "claude-resume.json", { run_id: "r-geras", task_id: "0042", updated_at: NOW });

    const result = await resolveActiveAttempt({ taskId: "0042", ...world, create: true, env: {}, now: () => NOW });
    assert.equal(result.ok, true);
    // Svetimos formos senas įrašas negali užblokuoti einamojo bandymo.
    assert.equal(result.ok === true && result.attempt.manifest.run_id, "r-geras");
  } finally {
    await rm(world.projectRoot, { recursive: true, force: true });
  }
});

test("retry skaitiklis pakelia attempt numerį", async () => {
  const world = await workspace();
  try {
    await writeState(world.runtimeRoot, "retry-counts.json", { "task:0042": 2 });
    const result = await resolveActiveAttempt({
      taskId: "0042",
      ...world,
      create: true,
      env: { AG_RUN_ID: "r1" },
      now: () => NOW,
    });

    assert.equal(result.ok, true);
    // Du repair'ai → trečias bandymas: ta pati aritmetika kaip dispatch'e.
    assert.equal(result.ok === true && result.attempt.manifest.attempt_id, "a3");
  } finally {
    await rm(world.projectRoot, { recursive: true, force: true });
  }
});

test("pakartotinis kvietimas randa TĄ PATĮ namespace'ą", async () => {
  const world = await workspace();
  try {
    const env = { AG_RUN_ID: "r1", AG_WORKER_ID: "w1", AG_ATTEMPT_ID: "a1" };
    const first = await resolveActiveAttempt({ taskId: "0042", ...world, create: true, env, now: () => NOW });
    // Antras kvietimas jau BE `create`: trys atskiri procesai turi rasti tą patį katalogą.
    const second = await resolveActiveAttempt({ taskId: "0042", ...world, env, now: () => NOW });

    assert.equal(first.ok && second.ok, true);
    if (!first.ok || !second.ok) return;
    assert.equal(second.attempt.manifest.attempt_id, first.attempt.manifest.attempt_id);
    assert.equal(second.attempt.manifest.task_id, first.attempt.manifest.task_id);
  } finally {
    await rm(world.projectRoot, { recursive: true, force: true });
  }
});

test("SVETIMAS manifestas neperrašomas — `identity-mismatch`", async () => {
  const world = await workspace();
  try {
    const env = { AG_RUN_ID: "r1", AG_WORKER_ID: "w1", AG_ATTEMPT_ID: "a1" };
    const mine = await resolveActiveAttempt({ taskId: "0042", ...world, create: true, env, now: () => NOW });
    assert.equal(mine.ok, true);
    if (!mine.ok) return;

    // Tas pats kelias, kitas run: katalogas jau priklauso kitam bandymui.
    const manifestPath = path.join(mine.attempt.handle.dir, "manifest.json");
    const raw = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    await writeFile(manifestPath, JSON.stringify({ ...raw, task_id: "9999" }), "utf8");

    const result = await resolveActiveAttempt({ taskId: "0042", ...world, create: true, env, now: () => NOW });
    // Egzistuojantis manifestas yra autoritetas: nerašome nieko.
    assert.equal(result.ok === false && result.reason, "identity-mismatch");
  } finally {
    await rm(world.projectRoot, { recursive: true, force: true });
  }
});
