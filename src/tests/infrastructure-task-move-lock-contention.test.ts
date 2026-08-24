// 2026-08-24 — `task-move.lock` skaitymo lenktynės. Regresija, kuri pasirodydavo TIK pilnoje testų
// serijoje ir praeidavo paleista atskirai, tad ilgai atrodė kaip aplinkos triukšmas.
//
// Gedimas: `readTaskMoveLock` paduodamas į `stealStaleLock` kaip `readIdentity`, o to porto
// kontraktas sako „NIEKADA nemeta: neįskaitomas lock'as = undefined" (shared/lock-steal.ts).
// Realizacija rėmėsi `readTextFileIfExists`, kuris SĄMONINGAI praleidžia tik ENOENT/EISDIR/ENOTDIR
// (node-fs-adapter.ts), o win32 delete-pending langą — konkurentas kaip tik trina lock'o katalogą —
// Windows pateikia kaip EPERM. Tad perėmimas krisdavo per patį pirmą savo žingsnį.
//
// Pataisos yra DVI, ir antroji svarbesnė: skaitymo baigtis nustojo būti dvejetainė. „Lock'o nėra"
// ir „lock'o perskaityti nepavyko" atlaisvinimo klausimui yra PRIEŠINGI atsakymai, o senoji
// realizacija juos suliedavo į `undefined` ir tada trindavo besąlygiškai.

import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  createTaskStateStore,
  isLockContentionError,
  taskMoveLockReleaseDecision,
  taskMoveLockTiming,
  type TaskMoveLockRead,
} from "../infrastructure/state/task-state-store.js";

function errnoError(code: string): Error {
  return Object.assign(new Error(`synthetic ${code}`), { code });
}

const OWNED: TaskMoveLockRead = {
  state: "owned",
  lock: { lock_id: "ours", pid: 1, created_at: "2026-08-24T00:00:00.000Z", operation: "move" },
};

test("win32 EPERM/EACCES/EBUSY yra contention, o ne gedimas — būtent jie krisdavo pilnoje serijoje", () => {
  for (const code of ["EPERM", "EACCES", "EBUSY"]) {
    assert.equal(isLockContentionError(errnoError(code), "win32"), true, `${code} win32`);
    // Kitose platformose teisių klaida yra TIKRAS gedimas ir kartoti jos nedera: ten delete-pending
    // lango nėra, tad EPERM reiškia tai, ką sako.
    assert.equal(isLockContentionError(errnoError(code), "linux"), false, `${code} linux`);
  }
});

test("EEXIST yra contention visose platformose (pralaimėta mkdir lenktynė)", () => {
  assert.equal(isLockContentionError(errnoError("EEXIST"), "linux"), true);
  assert.equal(isLockContentionError(errnoError("EEXIST"), "win32"), true);
  // Nesusijęs kodas contention NĖRA niekur — kitaip tikras gedimas suktųsi retry cikle.
  assert.equal(isLockContentionError(errnoError("ENOSPC"), "win32"), false);
});

test("atlaisvinimas: NEŽINIA niekada nevirsta trynimu", () => {
  // Šerdis. Neperskaitytas savininkas gali būti tas, kuris mūsų lock'ą ką tik perėmė kaip stale;
  // jo ištrynimas įleistų TREČIĄ rašytoją į kritinę sekciją. Iki pataisos šis atvejis grįždavo
  // `undefined` ir patekdavo į tą pačią šaką kaip „lock'o nėra", t. y. buvo trinamas.
  assert.equal(taskMoveLockReleaseDecision({ state: "unreadable" }, "ours"), "keep");
});

test("atlaisvinimas: trinama TIK savo arba jau nesamas lock'as", () => {
  assert.equal(taskMoveLockReleaseDecision(OWNED, "ours"), "release");
  assert.equal(taskMoveLockReleaseDecision({ state: "absent" }, "ours"), "release");
  // Svetimas savininkas — ta pati taisyklė, kurią modulis turėjo ir iki pataisos.
  assert.equal(taskMoveLockReleaseDecision(OWNED, "kito-proceso-id"), "keep");
});

test("neįskaitomo lock'o atlaisvinimas atidedamas, o ne prarandamas: jį atgauna stale riba", () => {
  // Kodėl „keep" nėra užstrigimas: `staleMs` yra mažesnis už `timeoutMs`, tad laukėjas spėja
  // perimti neatlaisvintą lock'ą dar nepasibaigus savo deadline'ui.
  assert.ok(taskMoveLockTiming.staleMs < taskMoveLockTiming.timeoutMs);
});

test("SUGADINTAS stale lock'o owner.json perimamas, o ne meta — readIdentity kontraktas", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "vq-lock-contention-"));
  try {
    const agRoot = path.join(root, "AG");
    const queueDir = path.join(agRoot, "tasks", "queue");
    await mkdir(queueDir, { recursive: true });

    // Kritusio proceso palikimas: lock'as vietoje, o jo tapatybė neįskaitoma.
    const lockDir = path.join(agRoot, "state", "task-move.lock");
    await mkdir(lockDir, { recursive: true });
    await writeFile(path.join(lockDir, "owner.json"), "{{{ ne JSON", "utf8");
    // Stale riba matuojama KATALOGO mtime, tad jį sendiname PO failo įrašymo.
    const longAgo = new Date(Date.now() - taskMoveLockTiming.staleMs * 2);
    await utimes(lockDir, longAgo, longAgo);

    const source = path.join(queueDir, "0077.md");
    await writeFile(source, "# 0077", "utf8");

    const store = createTaskStateStore({ agRoot, runtimeRoot: path.join(root, "vq") });
    const moved = await store.moveTaskState(
      source,
      path.join(agRoot, "tasks", "active"),
      "0077.md",
      { updateCurrent: false },
    );

    assert.equal(await readFile(moved, "utf8"), "# 0077");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
