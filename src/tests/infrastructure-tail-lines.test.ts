// VQ-504 (36/N) testai — failo uodegos skaitymas ir bangos snapshot'o skaitytojas.
//
// Svarbiausia, ką jie pin'ina: nukirsta PIRMOJI lango eilutė atmetama (ji yra mūsų pjūvio
// artefaktas, ne sugadintas įvykis), nesamas failas nėra klaida, o katalogas — YRA.

import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { readTailLines } from "../infrastructure/fs/tail-lines.js";
import { readWaveSnapshot, waveSnapshotExists, writeWaveSnapshot } from "../infrastructure/state/wave-snapshot-store.js";

async function sandbox(): Promise<{ dir: string; cleanup(): Promise<void> }> {
  const dir = await mkdtemp(path.join(tmpdir(), "vq-tail-"));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test("visas failas telpa į langą — grąžinamos visos eilutės", async () => {
  const world = await sandbox();
  try {
    const file = path.join(world.dir, "events.jsonl");
    await writeFile(file, '{"a":1}\n{"a":2}\n{"a":3}\n', "utf8");
    assert.deepEqual(await readTailLines(file), ['{"a":1}', '{"a":2}', '{"a":3}']);
  } finally {
    await world.cleanup();
  }
});

test("langas prasideda failo VIDURYJE — pirmoji, nukirsta eilutė atmetama", async () => {
  const world = await sandbox();
  try {
    const file = path.join(world.dir, "events.jsonl");
    await writeFile(file, '{"a":1}\n{"a":2}\n{"a":3}\n', "utf8");

    // 16 baitų nuo galo pataiko į `{"a":2}` vidurį: pirmoji lango eilutė yra nukirsta.
    const lines = await readTailLines(file, 16);
    assert.ok(!lines.some((line) => line.includes('"a":1')), "senos eilutės į langą nepatenka");
    assert.equal(lines.at(-1), '{"a":3}');
    for (const line of lines) {
      // Kertinė savybė: nė viena grąžinta eilutė nėra nukirsta — visos parsinamos.
      assert.doesNotThrow(() => JSON.parse(line), `nukirsta eilutė prasprūdo: ${line}`);
    }
  } finally {
    await world.cleanup();
  }
});

test("tuščias ir nesamas failas duoda tuščią sąrašą", async () => {
  const world = await sandbox();
  try {
    const empty = path.join(world.dir, "tuscias.jsonl");
    await writeFile(empty, "", "utf8");
    assert.deepEqual(await readTailLines(empty), []);
    assert.deepEqual(await readTailLines(path.join(world.dir, "nera.jsonl")), []);
  } finally {
    await world.cleanup();
  }
});

test("katalogas META, o ne apsimeta tuščiu failu", async () => {
  const world = await sandbox();
  try {
    const dir = path.join(world.dir, "katalogas");
    await mkdir(dir);
    // „Duomenų dar nėra" ir „šaltinis neperskaitomas" veda operatorių skirtingais keliais.
    await assert.rejects(() => readTailLines(dir));
  } finally {
    await world.cleanup();
  }
});

test("tuščios eilutės neneša įvykio ir atmetamos", async () => {
  const world = await sandbox();
  try {
    const file = path.join(world.dir, "events.jsonl");
    await writeFile(file, '{"a":1}\n\n\n{"a":2}\n', "utf8");
    assert.deepEqual(await readTailLines(file), ['{"a":1}', '{"a":2}']);
  } finally {
    await world.cleanup();
  }
});

test("wave snapshot: nesamas, sugadintas ir galiojantis skiriami", async () => {
  const world = await sandbox();
  try {
    const stateDir = path.join(world.dir, "state");
    await mkdir(stateDir);

    assert.equal(await waveSnapshotExists(stateDir), false);
    assert.equal(await readWaveSnapshot(stateDir), undefined);

    // Sugadintas failas: `exists` sako TAIP, skaitymas — `undefined`. Be to skirtumo
    // „atmetimų nėra" ir „snapshot'as neperskaitomas" susilietų.
    await writeFile(path.join(stateDir, "wave-snapshot.json"), "{nope", "utf8");
    assert.equal(await waveSnapshotExists(stateDir), true);
    assert.equal(await readWaveSnapshot(stateDir), undefined);

    await writeFile(path.join(stateDir, "wave-snapshot.json"), '{"refill":{"decisions":[]}}', "utf8");
    const snapshot = await readWaveSnapshot<{ refill?: { decisions?: unknown[] } }>(stateDir);
    assert.deepEqual(snapshot?.refill?.decisions, []);
  } finally {
    await world.cleanup();
  }
});

test("wave snapshot: rašymas ATOMINIS ir validuojamas PRIEŠ rašymą", async () => {
  const world = await sandbox();
  try {
    const stateDir = path.join(world.dir, "state");

    // Negaliojantis snapshot'as (paralelizmas virš kietos ribos) į diską NEPATENKA: tai
    // programavimo klaida planuotojuje, ir ją reikia pamatyti iš karto.
    await assert.rejects(() =>
      writeWaveSnapshot(stateDir, {
        run_id: "r1",
        wave_id: "w1",
        graph_hash: "abc",
        max_workers: 5,
        created_at: "t",
        updated_at: "t",
      } as never),
    );
    assert.equal(await waveSnapshotExists(stateDir), false, "atmestas įrašas nepalieka pėdsako");

    const written = await writeWaveSnapshot(stateDir, {
      run_id: "r1",
      wave_id: "w1",
      graph_hash: "abc",
      created_at: "t",
      updated_at: "t",
    } as never);
    assert.equal(written.max_workers, 1);
    assert.deepEqual((await readWaveSnapshot<{ run_id: string }>(stateDir))?.run_id, "r1");
  } finally {
    await world.cleanup();
  }
});
