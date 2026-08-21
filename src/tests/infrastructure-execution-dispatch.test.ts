// VQ-504 (19/N) testai — `dispatch` prielaidų vartai ant REALIOS failų sistemos.
//
// Pin'inama tai, kas daro šį kelią saugų: adapteris NEPALEIDŽIAMAS, kol ant disko nėra praėjusio
// preflight'o, praėjusių biudžeto vartų ir ŠIAM task'ui priklausančio context-pack'o. Kiekvienas
// testas tikrina ne tik klaidą, bet ir tai, kad adapteris nebuvo pakviestas — paleidimas yra
// neatšaukiamas, tad „metė po vykdymo" būtų tas pats, kas nemetė.

import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { ExecutionAdapter } from "../domain/agents/execution-port.js";
import { runExecutionDispatch } from "../infrastructure/adapters/execution-dispatch.js";

type World = { root: string; runtimeRoot: string; taskFile: string; cleanup(): Promise<void> };

async function makeWorld(): Promise<World> {
  const root = await mkdtemp(path.join(tmpdir(), "vq-dispatch-"));
  const runtimeRoot = path.join(root, "vq");
  await mkdir(path.join(runtimeRoot, "supervisor"), { recursive: true });
  await mkdir(path.join(runtimeRoot, "state"), { recursive: true });
  await mkdir(path.join(root, "AG", "tasks", "queue"), { recursive: true });
  const taskFile = path.join(root, "AG", "tasks", "queue", "0042.md");
  await writeFile(taskFile, "# Task", "utf8");
  return { root, runtimeRoot, taskFile, cleanup: () => rm(root, { recursive: true, force: true }) };
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function writeGates(
  world: World,
  overrides: { preflight?: unknown; budget?: unknown; contextPack?: unknown } = {},
): Promise<void> {
  const supervisor = path.join(world.runtimeRoot, "supervisor");
  await writeFile(
    path.join(supervisor, "preflight-decision.json"),
    json(overrides.preflight ?? { verdict: "pass", task_id: "0042" }),
    "utf8",
  );
  await writeFile(
    path.join(world.runtimeRoot, "state", "token-budget-status.json"),
    json(overrides.budget ?? { budget_enforcement: { ok: true } }),
    "utf8",
  );
  await writeFile(
    path.join(supervisor, "context-pack.json"),
    json(overrides.contextPack ?? { task_id: "0042", goal: "Padaryk", allowed_paths: ["src/a.ts"], agent: { model_hint: "sonnet" } }),
    "utf8",
  );
}

/** Adapteris, kuris ĮSIMENA, ar buvo pakviestas — vartų testų esmė. */
function spyAdapter(): { adapter: ExecutionAdapter; calls: { model?: string }[] } {
  const calls: { model?: string }[] = [];
  const adapter = {
    kind: "dry-run" as const,
    execute: (request: { model?: string }) => {
      calls.push({ ...(request.model === undefined ? {} : { model: request.model }) });
      return Promise.resolve({ adapter: "dry-run", exitCode: 0, stdout: "ok", stderr: "", reason: "" });
    },
  } as unknown as ExecutionAdapter;
  return { adapter, calls };
}

test("visi vartai praeina: adapteris paleidžiamas, rezultatas įrašomas", async () => {
  const world = await makeWorld();
  try {
    await writeGates(world);
    const spy = spyAdapter();
    const result = await runExecutionDispatch({
      taskFile: world.taskFile,
      projectRoot: world.root,
      runtimeRoot: world.runtimeRoot,
      adapter: spy.adapter,
    });

    assert.equal(result.status, "completed");
    assert.equal(result.task_id, "0042");
    assert.equal(spy.calls.length, 1);
    // Modelio užuomina paimama iš context-pack, kai `--model` nenurodytas.
    assert.equal(spy.calls[0]?.model, "sonnet");

    const written = await readFile(path.join(world.runtimeRoot, "supervisor", "dispatch-result.json"), "utf8");
    assert.match(written, /"status": "completed"/);
  } finally {
    await world.cleanup();
  }
});

test("eksplicitinis modelis nugali context-pack užuominą", async () => {
  const world = await makeWorld();
  try {
    await writeGates(world);
    const spy = spyAdapter();
    await runExecutionDispatch({
      taskFile: world.taskFile,
      projectRoot: world.root,
      runtimeRoot: world.runtimeRoot,
      adapter: spy.adapter,
      model: "opus",
    });
    assert.equal(spy.calls[0]?.model, "opus");
  } finally {
    await world.cleanup();
  }
});

test("SVETIMO task'o preflight'as neatidaro vartų, o adapteris nepaleidžiamas", async () => {
  const world = await makeWorld();
  try {
    await writeGates(world, { preflight: { verdict: "pass", task_id: "0099" } });
    const spy = spyAdapter();
    await assert.rejects(
      () =>
        runExecutionDispatch({
          taskFile: world.taskFile,
          projectRoot: world.root,
          runtimeRoot: world.runtimeRoot,
          adapter: spy.adapter,
        }),
      /valid preflight success is required for task 0042/,
    );
    assert.equal(spy.calls.length, 0, "paleidimas yra neatšaukiamas — vartai eina PRIEŠ jį");
  } finally {
    await world.cleanup();
  }
});

test("neigiami biudžeto vartai sustabdo dispatch'ą", async () => {
  const world = await makeWorld();
  try {
    await writeGates(world, { budget: { budget_enforcement: { ok: false } } });
    const spy = spyAdapter();
    await assert.rejects(
      () =>
        runExecutionDispatch({
          taskFile: world.taskFile,
          projectRoot: world.root,
          runtimeRoot: world.runtimeRoot,
          adapter: spy.adapter,
        }),
      /budget enforcement success is required/,
    );
    assert.equal(spy.calls.length, 0);
  } finally {
    await world.cleanup();
  }
});

test("svetimas ar nepilnas context-pack sustabdo dispatch'ą", async () => {
  const world = await makeWorld();
  try {
    await writeGates(world, { contextPack: { task_id: "0099", goal: "x", allowed_paths: [] } });
    const spy = spyAdapter();
    await assert.rejects(
      () =>
        runExecutionDispatch({
          taskFile: world.taskFile,
          projectRoot: world.root,
          runtimeRoot: world.runtimeRoot,
          adapter: spy.adapter,
        }),
      /context pack is invalid or belongs to another task/,
    );
    assert.equal(spy.calls.length, 0);
  } finally {
    await world.cleanup();
  }
});

test("TRŪKSTAMAS ir SUGADINTAS artefaktas duoda SKIRTINGAS klaidas", async () => {
  const world = await makeWorld();
  try {
    const spy = spyAdapter();
    // Nieko nėra — „šis žingsnis dar nepadarytas".
    await assert.rejects(
      () =>
        runExecutionDispatch({
          taskFile: world.taskFile,
          projectRoot: world.root,
          runtimeRoot: world.runtimeRoot,
          adapter: spy.adapter,
        }),
      /preflight result is missing/,
    );

    // Failas yra, bet neparsinamas — „šis žingsnis melavo". Operatoriui tai kitas veiksmas.
    await writeFile(path.join(world.runtimeRoot, "supervisor", "preflight-decision.json"), "{nope", "utf8");
    await assert.rejects(
      () =>
        runExecutionDispatch({
          taskFile: world.taskFile,
          projectRoot: world.root,
          runtimeRoot: world.runtimeRoot,
          adapter: spy.adapter,
        }),
      /preflight result is invalid/,
    );
    assert.equal(spy.calls.length, 0);
  } finally {
    await world.cleanup();
  }
});
