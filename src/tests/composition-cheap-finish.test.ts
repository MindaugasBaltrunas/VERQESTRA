// VQ-504 (62/N) testai — cheap finish adapteris.
//
// Prikalama tai, kas laiko VIENKARTIŠKUMĄ: sugadinta žymė vis tiek reiškia `armed` (pats failo
// buvimas yra įrodymas), rašymo klaida nepaverčia išimties task'o gedimu, o env overlay
// sunaudojamas TIK vieną kartą — antras dispatch'as cheap finish lengvatos nepaveldi.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { cheapFinishPort, createCheapFinishEnvOverlay } from "../composition/quality/cheap-finish-adapters.js";

async function workspace(): Promise<{ projectRoot: string; runtimeRoot: string }> {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "vq-504-cheap-"));
  const runtimeRoot = path.join(projectRoot, "vq");
  await mkdir(path.join(runtimeRoot, "state"), { recursive: true });
  await mkdir(path.join(runtimeRoot, "logs"), { recursive: true });
  return { projectRoot, runtimeRoot };
}

const overlay = (): ReturnType<typeof createCheapFinishEnvOverlay> => createCheapFinishEnvOverlay();

test("env overlay SUNAUDOJAMAS vieną kartą", () => {
  const one = overlay();
  assert.equal(one.consume(), undefined, "be paruošimo overlay nėra");

  one.arm("0042");
  assert.deepEqual(one.consume(), { AG_EXECUTION_CONTEXT_MODE: "required" });
  // Antras dispatch'as lengvatos nepaveldi.
  assert.equal(one.consume(), undefined);
});

test("žymė: `absent` → `arm` → `armed` su įrašu", async () => {
  const world = await workspace();
  try {
    const port = cheapFinishPort(world, overlay());
    assert.equal((await port.read("0042")).status, "absent");

    await port.arm({
      schema_version: 1,
      task_id: "0042",
      armed_at: "2026-08-21T12:00:00.000Z",
      attempt_sequence: 2,
      reason_class: "typecheck",
      blocked_by: "retry-limit",
      billable_limit: 300_000,
      max_turns: 20,
    });

    const marker = await port.read("0042");
    assert.equal(marker.status, "armed");
    assert.equal(marker.status === "armed" ? marker.record?.reason_class : undefined, "typecheck");
  } finally {
    await rm(world.projectRoot, { recursive: true, force: true });
  }
});

test("SUGADINTA žymė vis tiek yra `armed`", async () => {
  const world = await workspace();
  try {
    const dir = path.join(world.runtimeRoot, "state", "cheap-finish");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "0042.json"), "{ne json", "utf8");

    const marker = await cheapFinishPort(world, overlay()).read("0042");
    // Pats failo egzistavimas ir yra „cheap finish jau panaudotas" įrodymas — fail-closed.
    assert.equal(marker.status, "armed");
    assert.equal(marker.status === "armed" ? marker.record : "x", undefined);
  } finally {
    await rm(world.projectRoot, { recursive: true, force: true });
  }
});

test("retry biudžetas skaičiuoja KITĄ bandymą", async () => {
  const world = await workspace();
  try {
    await writeFile(
      path.join(world.runtimeRoot, "state", "retry-counts.json"),
      JSON.stringify({ "task:0042": 1 }),
      "utf8",
    );
    const budget = await cheapFinishPort(world, overlay()).retryBudget("0042");

    assert.equal(budget.count, 1);
    // Skaitiklis didinamas PRIEŠ dispatch'ą, tad „kitas bandymas" yra `count + 1`.
    assert.equal(budget.nextWouldReachLimit, budget.count + 1 >= budget.max);
  } finally {
    await rm(world.projectRoot, { recursive: true, force: true });
  }
});

// Env sandbox'as BŪTINAS: gyvo dispatch'o aplinka vaikams eksportuoja AG_RUN_ID/AG_WORKER_ID/
// AG_ATTEMPT_ID, o `resolveActiveAttempt` run_id pirmiausia ima iš env (active-attempt.ts) —
// be išvalymo šis testas worktree patikrose rasdavo „gyvą" namespace ir raudonuodavo vien dėl
// aplinkos (2026-09-01: 096 worker'is dėl to bandė taisyti šį testą už savo scope ribų).
test("be runtime namespace'o `prepareDispatch` krenta PRIEŠ retry inkrementą", async () => {
  const savedEnv = new Map(
    ["AG_RUN_ID", "AG_WORKER_ID", "AG_ATTEMPT_ID"].map((key) => [key, process.env[key]] as const),
  );
  for (const key of savedEnv.keys()) delete process.env[key];
  const world = await workspace();
  try {
    const port = cheapFinishPort(world, overlay());
    const before = await port.retryBudget("0042");

    const prepared = await port.prepareDispatch({
      taskId: "0042",
      promptText: "# task\n",
      desiredTierStep: 1,
      tokenBudgetTier: "small",
      resetTaskLedger: false,
    });

    assert.equal(prepared.ok, false);
    assert.ok(prepared.errors.some((error) => error.includes("runtime attempt namespace unavailable")));
    // Būsena lieka NEPAJUDINTA: kitaip task'as netektų bandymo, kurio niekada negavo.
    assert.equal((await port.retryBudget("0042")).count, before.count);
  } finally {
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(world.projectRoot, { recursive: true, force: true });
  }
});
