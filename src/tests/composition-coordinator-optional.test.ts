// VQ-504 (61/N) testai — neprivalomi koordinatoriaus portai.
//
// Prikalama fail-closed pusė: nesantis vartų konfigas duoda `advisory` (jų ĮJUNGIMAS yra
// operatoriaus sprendimas), o SUGADINTAS meta — klaidingai užrašytas režimas privalo skambėti, ne
// tyliai išjungti vartus. Memo `corrupted` yra atskira būsena nuo `absent`.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { integrationGatePort, preflightFailureMemoPort } from "../composition/loop/coordinator-optional-adapters.js";
import { PolicyConfigError } from "../shared/errors.js";

async function workspace(): Promise<{ projectRoot: string; runtimeRoot: string }> {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "vq-504-optional-"));
  const runtimeRoot = path.join(projectRoot, "vq");
  await mkdir(path.join(runtimeRoot, "config"), { recursive: true });
  await mkdir(path.join(runtimeRoot, "state"), { recursive: true });
  return { projectRoot, runtimeRoot };
}

async function writeConfig(runtimeRoot: string, body: string): Promise<void> {
  await writeFile(path.join(runtimeRoot, "config", "integration-verifier.json"), body, "utf8");
}

test("be konfigo režimas yra `advisory`", async () => {
  const world = await workspace();
  try {
    assert.equal(await integrationGatePort(world).mode(), "advisory");
  } finally {
    await rm(world.projectRoot, { recursive: true, force: true });
  }
});

test("`enforce` perskaitomas, o SUGADINTAS konfigas META", async () => {
  const world = await workspace();
  try {
    await writeConfig(world.runtimeRoot, JSON.stringify({ mode: "enforce" }));
    assert.equal(await integrationGatePort(world).mode(), "enforce");

    // Klaidingai užrašytas režimas privalo skambėti: tylus nuleidimas į `advisory` išjungtų
    // vartus visai eilei.
    await writeConfig(world.runtimeRoot, JSON.stringify({ mode: "enfore" }));
    await assert.rejects(() => integrationGatePort(world).mode(), PolicyConfigError);

    await writeConfig(world.runtimeRoot, "{ne json");
    await assert.rejects(() => integrationGatePort(world).mode(), PolicyConfigError);
  } finally {
    await rm(world.projectRoot, { recursive: true, force: true });
  }
});

test("ne git revizijoje kontrakto failas yra `present: false`", async () => {
  const world = await workspace();
  try {
    const file = await integrationGatePort(world).readContractFile("HEAD", "src/nera.ts");
    // Nebuvimas skiriasi nuo tuščio failo: vartai iš to sprendžia apie kontrakto dingimą.
    assert.deepEqual(file, { present: false });
  } finally {
    await rm(world.projectRoot, { recursive: true, force: true });
  }
});

test("memo: `absent` → įrašas → `hit` → išvalymas", async () => {
  const world = await workspace();
  try {
    const memo = preflightFailureMemoPort(world);
    assert.equal((await memo.read("0042")).status, "absent");

    await memo.record({
      schema_version: 1,
      task_id: "0042",
      content_hash: "sha256:abc",
      failure_class: "preflight-exit",
      exit_code: 1,
      failed_at: "2026-08-21T12:00:00.000Z",
      repeat_count: 1,
    });

    const hit = await memo.read("0042");
    assert.equal(hit.status, "hit");

    await memo.clear("0042");
    assert.equal((await memo.read("0042")).status, "absent");
  } finally {
    await rm(world.projectRoot, { recursive: true, force: true });
  }
});

test("sugadintas memo yra `corrupted`, NE `absent`", async () => {
  const world = await workspace();
  try {
    const dir = path.join(world.runtimeRoot, "state", "preflight-failure-memo");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "0042.json"), "{ne json", "utf8");

    const result = await preflightFailureMemoPort(world).read("0042");
    // Sulieti su `absent` reikštų, kad sugadintas failas tyliai atrakina kelią, kurį memo
    // turėjo pristabdyti.
    assert.equal(result.status, "corrupted");
  } finally {
    await rm(world.projectRoot, { recursive: true, force: true });
  }
});
