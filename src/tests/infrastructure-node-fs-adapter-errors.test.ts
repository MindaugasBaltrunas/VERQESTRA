// 2026-09-05 audito F15/F7 — kur `nodeFsAdapter` KLAUSIMĄ „ar yra?" skiria nuo „ar pavyko
// paklausti?".
//
// Iki šio rinkinio `list*`, `statPath` ir `statKind` turėjo `catch {}`: nesamas katalogas ir
// katalogas, kurio perskaityti neleista (EACCES/EPERM/EIO), grįždavo tuo pačiu `[]`/`absent`.
// Kvietėjai iš to darydavo sprendimus — `dist-freshness` „dist failo nėra" (reason `missing`),
// `preserved-ref-retention` „įrašų nėra", `orphan-worktree-reaper` „bucket'as tuščias" — t. y.
// tyli baigtis vietoje gedimo. Nebuvimas lieka atsakymu, visa kita nuo šiol metama.
//
// `createDirectoryExclusive` yra tos pačios ribos antra pusė, tik rašymo kryptimi: vardo
// užėmimas tapatybei (`createAttempt`) NEGALI teisių klaidos vadinti „jau egzistuoja".

import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { nodeFsAdapter } from "../infrastructure/fs/node-fs-adapter.js";

const root = await mkdtemp(path.join(tmpdir(), "vq-fs-errors-"));
after(async () => {
  // Teisės grąžinamos PRIEŠ trynimą: 000 katalogo `rm -r` pats kristų su EACCES.
  await chmod(path.join(root, "sealed"), 0o700).catch(() => undefined);
  await rm(root, { recursive: true, force: true });
});

/**
 * Teisių testas turi prasmę tik ten, kur teisės veikia: win32 POSIX bitų neturi, o root'ui
 * jos negalioja. Praleidimas yra sąmoningas ir įvardytas, o ne tylus.
 */
const permissionsApply = process.platform !== "win32" && process.getuid?.() !== 0;

test("createDirectoryExclusive: `exists` TIK ties EEXIST", async () => {
  const dir = path.join(root, "claimed");
  assert.equal(await nodeFsAdapter.createDirectoryExclusive(dir), "created");
  assert.equal(await nodeFsAdapter.createDirectoryExclusive(dir), "exists");
});

test("createDirectoryExclusive: kita klaida METAMA, o ne verčiama `exists`", async () => {
  // Nesamas tėvas — ENOENT. `createLockDirectory` semantika tam pačiam kelias nesikeičia
  // (jai win32 EPERM/EACCES yra contention), bet tapatybės užėmimui klaida privalo likti klaida:
  // `already-exists` pastūmėtų kvietėją imti NAUJĄ attempt id ir gauti tą patį gedimą.
  const orphan = path.join(root, "nera-tevo", "vaikas");
  await assert.rejects(nodeFsAdapter.createDirectoryExclusive(orphan), (error: NodeJS.ErrnoException) => {
    assert.equal(error.code, "ENOENT");
    return true;
  });

  // Kelias PER failą — ENOTDIR. Nė vienas iš jų nėra „vardas užimtas".
  const file = path.join(root, "ne-katalogas.txt");
  await writeFile(file, "x", "utf8");
  await assert.rejects(nodeFsAdapter.createDirectoryExclusive(path.join(file, "vaikas")));
});

test("list*/stat*: ENOENT ir ENOTDIR lieka atsakymu (`[]` / `absent`)", async () => {
  const missing = path.join(root, "nesamas-katalogas");
  assert.deepEqual(await nodeFsAdapter.listFiles(missing), []);
  assert.deepEqual(await nodeFsAdapter.listDirectory(missing), []);
  assert.deepEqual(await nodeFsAdapter.listSubdirectories(missing), []);
  assert.deepEqual(await nodeFsAdapter.listMarkdownFiles(missing), []);
  assert.equal((await nodeFsAdapter.statPath(missing)).kind, "absent");
  assert.equal(await nodeFsAdapter.statKind(missing), "absent");

  // `listFiles` ant FAILO: `readdir` duoda ENOTDIR, ir tai reiškia tą patį — katalogo tokiu
  // keliu nėra. Kvietėjai (bootstrap, ledger sync) tuo remiasi, tad tai lieka `[]`.
  const file = path.join(root, "failas.md");
  await writeFile(file, "# f", "utf8");
  assert.deepEqual(await nodeFsAdapter.listFiles(file), []);
  assert.deepEqual(await nodeFsAdapter.listMarkdownFiles(file), []);
  assert.equal((await nodeFsAdapter.statPath(path.join(file, "vaikas"))).kind, "absent");
  assert.equal(await nodeFsAdapter.statKind(path.join(file, "vaikas")), "absent");
});

test("list*: NEPRIEINAMAS katalogas META, o ne apsimeta tuščiu", async (t) => {
  if (!permissionsApply) {
    t.skip("POSIX teisės netaikomos (win32 arba root) — EACCES atkartoti nėra kuo");
    return;
  }

  const sealed = path.join(root, "sealed");
  await mkdir(sealed, { recursive: true });
  await writeFile(path.join(sealed, "yra.md"), "# yra", "utf8");
  await chmod(sealed, 0o000);

  // Šerdis: tuščias sąrašas čia reikštų „failų nėra", nors failas yra ir mes tiesiog jo
  // nematome. Būtent iš to gimdavo `dist-freshness` verdiktas apie neegzistuojantį dist'ą.
  for (const list of [
    nodeFsAdapter.listFiles(sealed),
    nodeFsAdapter.listDirectory(sealed),
    nodeFsAdapter.listSubdirectories(sealed),
    nodeFsAdapter.listMarkdownFiles(sealed),
  ]) {
    await assert.rejects(list, (error: NodeJS.ErrnoException) => {
      assert.equal(error.code, "EACCES");
      return true;
    });
  }

  // `statPath`/`statKind` ant PAČIO katalogo dar veikia (skaitomas tėvas), tad tikrinamas
  // vaikas: jo `stat` reikalauja to paties uždrausto leidimo.
  const child = path.join(sealed, "yra.md");
  await assert.rejects(nodeFsAdapter.statPath(child));
  await assert.rejects(nodeFsAdapter.statKind(child));
});
