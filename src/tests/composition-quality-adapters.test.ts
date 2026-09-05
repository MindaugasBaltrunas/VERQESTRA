// Task 172 testai — kokybės klasterio adapterių surišimas.
//
// Iki 2026-09-05 nei `qualityGatesPorts`, nei release-check FS portai testo neturėjo, ir tuo
// naudojosi dvi spragos: `projectRoot` turėjo `process.cwd()` default'ą (hook'ų kontekste tai
// svetimas medis), o `final-audit` hash'avo failų sąrašą per SAVO BFS kopiją. Abi tylios —
// jos nekeičia nė vieno verdikto teksto, tik tai, KURIS medis buvo pamatuotas.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { qualityGatesPorts } from "../composition/quality/adapters.js";
import { finalAuditPorts } from "../composition/quality/final-audit-adapters.js";
import { releaseCheckFs, releaseCheckPorts } from "../composition/quality/release-check-adapters.js";

let root = "";

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "vq-quality-adapters-"));
});

after(async () => {
  if (root !== "") await rm(root, { recursive: true, force: true });
});

test("release-check FS portas yra VIENAS objektas abiem vartotojams", () => {
  const runtimeRoot = path.join(root, "vq");
  assert.equal(releaseCheckPorts(runtimeRoot).fs, releaseCheckFs, "`release-check` ima bendrą portą");
  assert.equal(
    finalAuditPorts(root, runtimeRoot, path.join(root, "AG")).sourceFs,
    releaseCheckFs,
    "`final-audit` source-state įėjimas yra TAS PATS objektas — dvi kopijos hash'uotų skirtingai",
  );
});

test("releaseCheckFs.listFilesRecursive: visi failai iš medžio, rūšiuotas sąrašas", async () => {
  const tree = path.join(root, "tree");
  await mkdir(path.join(tree, "b", "deep"), { recursive: true });
  await mkdir(path.join(tree, "a"), { recursive: true });
  await writeFile(path.join(tree, "z.ts"), "z", "utf8");
  await writeFile(path.join(tree, "a", "one.ts"), "1", "utf8");
  await writeFile(path.join(tree, "b", "deep", "two.ts"), "2", "utf8");

  const found = await releaseCheckFs.listFilesRecursive(tree);

  assert.deepEqual(
    found.map((file) => path.basename(file)).sort(),
    ["one.ts", "two.ts", "z.ts"],
    "rekursija paima ir gilius failus",
  );
  // Rūšiavimas lyginamas su PAČIO sąrašo rūšiuota kopija: absoliučiuose keliuose skirtukas yra
  // platformos (`\` win32, `/` posix), tad ranka surašyta tvarka skirtųsi tarp OS.
  assert.deepEqual(found, [...found].sort(), "sąrašas rūšiuotas — hash'o įėjimas turi būti stabilus");
});

test("releaseCheckFs: nesamas katalogas duoda tuščią sąrašą, ne klaidą", async () => {
  assert.deepEqual(await releaseCheckFs.listFilesRecursive(path.join(root, "nera")), []);
});

test("qualityGatesPorts.loadLocalEnv: nesamas `local.env` yra TUŠČIAS rinkinys, ne lūžis", async () => {
  const ports = qualityGatesPorts(path.join(root, "vq"), root);
  assert.deepEqual(await ports.loadLocalEnv(), {});
});

test("qualityGatesPorts.loadLocalEnv: `KEY=value` eilutės iš `vq/config/local.env`", async () => {
  const runtimeRoot = path.join(root, "vq-local");
  await mkdir(path.join(runtimeRoot, "config"), { recursive: true });
  await writeFile(path.join(runtimeRoot, "config", "local.env"), "# komentaras\nCI=1\n", "utf8");

  assert.deepEqual(await qualityGatesPorts(runtimeRoot, root).loadLocalEnv(), { CI: "1" });
});
