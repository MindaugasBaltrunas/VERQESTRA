#!/usr/bin/env node
// `dist/.buildstamp` rašymas po `tsc` (etalonas: AG_loop scripts/write-build-stamp.mjs).
//
// Kodėl stamp'as, o ne pavieniai `.js` mtime: TypeScript emit'as NEKEIČIA nepakitusių išvesties
// failų laiko. Todėl „šaltinis naujesnis už savo `.js`" duotų klaidingų teigiamų kiekvienam
// failui, kurio turinys po redagavimo liko toks pat. Vienas stamp'as atsako apie VISĄ build'ą.
//
// Skriptas daro DU dalykus, ir abu būtini:
//   1. suvienodina visų `dist/**/*.js(.map)` mtime — kitaip dalis išvesties liktų su senesniu
//      laiku nei stamp'as, ir bet kuris kitas šviežumo skaitytojas matytų nenuoseklų vaizdą;
//   2. stamp'o laikas parenkamas kaip `max(dabar, naujausias šaltinis + 1 s)` — build'as
//      trunka, tad per jį įrašytas šaltinis natūraliai turi vėlesnį mtime nei build'o pradžia.
//
// Tikrinimo pusė gyvena `src/infrastructure/process/dist-freshness.ts`.

import { mkdir, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = path.join(packageRoot, "src");
const distDir = path.join(packageRoot, "dist");
const stampPath = path.join(distDir, ".buildstamp");

await pruneOrphanedOutputs(distDir, distDir);

const newestSource = await newestTypeScriptTimestamp(srcDir);
const stampTime = new Date(Math.max(Date.now(), newestSource + 1000));

await mkdir(distDir, { recursive: true });
await refreshOutputs(distDir, stampTime);
await writeFile(stampPath, `${stampTime.toISOString()}\n`, "utf8");
await utimes(stampPath, stampTime, stampTime);

/**
 * `tsc` (be `--build`) niekada netrina `dist/**` failų, kurių atitinkamas `.ts` dingo iš `src/**`
 * (pvz. preserved-work rollback grąžina worktree atgal, o dist lieka su senu emit'u). Toks failas
 * ramiai lieka test glob'e (`dist/tests/**\/*.test.js`) ir suveikia kaip nesantis šaltinis —
 * red testas be jokios atitinkamos src eilutės. Pašalinama TIK 1:1 mapped `.js`/`.js.map`, kurių
 * `src/**\/*.ts` atitikmens nebėra; `.buildstamp` ir kiti ne-emit failai nesvarstomi.
 */
async function pruneOrphanedOutputs(dir, root) {
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await pruneOrphanedOutputs(entryPath, root);
      continue;
    }
    if (!entry.isFile()) continue;
    const isMap = entry.name.endsWith(".js.map");
    const isJs = !isMap && entry.name.endsWith(".js");
    if (!isJs && !isMap) continue;

    const relFromDist = path.relative(root, entryPath);
    const relSource = isMap ? relFromDist.slice(0, -".js.map".length) : relFromDist.slice(0, -".js".length);
    const sourcePath = path.join(srcDir, `${relSource}.ts`);
    const sourceExists = await stat(sourcePath)
      .then(() => true)
      .catch(() => false);
    if (!sourceExists) await rm(entryPath, { force: true });
  }
}

/** Naujausio `.ts` šaltinio mtime (ms); nesamas katalogas — 0. */
async function newestTypeScriptTimestamp(dir) {
  let newest = 0;
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      newest = Math.max(newest, await newestTypeScriptTimestamp(entryPath));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      newest = Math.max(newest, (await stat(entryPath).catch(() => undefined))?.mtimeMs ?? 0);
    }
  }
  return newest;
}

/** Vienodas mtime visai išvesčiai. Nepavykęs `utimes` praleidžiamas: stamp'as vis tiek rašomas. */
async function refreshOutputs(dir, when) {
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await refreshOutputs(entryPath, when);
    } else if (entry.isFile() && (entry.name.endsWith(".js") || entry.name.endsWith(".js.map"))) {
      await utimes(entryPath, when, when).catch(() => undefined);
    }
  }
}
