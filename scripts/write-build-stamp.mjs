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

import { mkdir, readdir, stat, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = path.join(packageRoot, "src");
const distDir = path.join(packageRoot, "dist");
const stampPath = path.join(distDir, ".buildstamp");

const newestSource = await newestTypeScriptTimestamp(srcDir);
const stampTime = new Date(Math.max(Date.now(), newestSource + 1000));

await mkdir(distDir, { recursive: true });
await refreshOutputs(distDir, stampTime);
await writeFile(stampPath, `${stampTime.toISOString()}\n`, "utf8");
await utimes(stampPath, stampTime, stampTime);

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
