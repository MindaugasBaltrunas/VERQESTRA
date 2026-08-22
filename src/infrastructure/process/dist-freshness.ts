// Sugeneruoto `dist` šviežumo patikra (etalonas: AG_loop core/dist-freshness.ts).
//
// Kodėl tai apskritai egzistuoja: hook'ai ir loop vaikai vykdo NE `src`, o `dist`. Pasenęs
// `dist` reiškia, kad procesas paklūsta kodui, kurio niekas nebeturi — ir tai nematoma nei
// testuose, nei code review. Patikra yra pigi ir vykdoma prieš loop'ą.
//
// Palyginimas remiasi ne pavieniais `.js` mtime, o VIENU build stamp'u: TypeScript emit'as
// nekeičia nepakitusių išvesties failų mtime, tad „šaltinis naujesnis už savo .js" duotų
// klaidingų teigiamų. Stamp'as atsakymą duoda apie VISĄ build'ą.

import path from "node:path";
import { DIST_REBUILD_COMMAND } from "../../application/release-readiness/build-gate.js";
import { nodeFsAdapter } from "../fs/node-fs-adapter.js";

export type StaleDistFile = {
  sourcePath: string;
  distPath: string;
  reason: "missing" | "stale";
};

/**
 * Kiek šaltinis gali būti „naujesnis" už stamp'ą, kad tai dar nebūtų senumas.
 *
 * Riba yra būtina, ne kosmetinė: build'as trunka, ir failas, įrašytas jo metu, natūraliai
 * turi vėlesnį mtime nei stamp'as. Be tolerancijos kiekvienas build'as baigtųsi „stale".
 */
const MTIME_TOLERANCE_MS = 500;

/**
 * Build stamp failo vardas `dist` šaknyje. Eksportuojamas, nes worktree bootstrap'as po dist
 * kopijos privalo atnaujinti BŪTENT šio failo mtime — vardas turi likti vienas visai sistemai.
 */
export const BUILD_STAMP = ".buildstamp";

async function listTypeScriptFiles(absoluteDir: string): Promise<string[]> {
  const files: string[] = [];
  const queue = [absoluteDir];
  while (queue.length > 0) {
    const dir = queue.shift();
    if (dir === undefined) continue;
    for (const name of await nodeFsAdapter.listFiles(dir)) {
      if (name.endsWith(".ts")) files.push(path.join(dir, name));
    }
    for (const name of await nodeFsAdapter.listSubdirectories(dir)) queue.push(path.join(dir, name));
  }
  return files;
}

function expectedDistPath(packageRoot: string, sourcePath: string): string {
  const relativeSource = path.relative(path.join(packageRoot, "src"), sourcePath);
  return path.join(packageRoot, "dist", relativeSource).replace(/\.ts$/, ".js");
}

export function buildStampPath(packageRoot: string): string {
  return path.join(packageRoot, "dist", BUILD_STAMP);
}

/**
 * Pasenę arba trūkstami `dist` failai.
 *
 * Dvi priežastys skiriamos sąmoningai: `missing` reiškia „build'o nebuvo arba jis nepilnas",
 * `stale` — „build'as buvo, bet ne po šio pakeitimo". Pirmas taisomas build'u, antras — irgi,
 * bet operatoriui tai skirtingi simptomai, ir sulietas pranešimas slėptų nepilną emit'ą.
 */
export async function findStaleDistFiles(packageRoot: string): Promise<StaleDistFile[]> {
  const srcDir = path.join(packageRoot, "src");
  const sourceFiles = await listTypeScriptFiles(srcDir);
  const staleFiles: StaleDistFile[] = [];
  const stampPath = buildStampPath(packageRoot);
  const stampMtime = await nodeFsAdapter.fileMtimeMs(stampPath);

  for (const sourcePath of sourceFiles) {
    const distPath = expectedDistPath(packageRoot, sourcePath);
    if ((await nodeFsAdapter.statKind(distPath)) !== "file") {
      staleFiles.push({ sourcePath, distPath, reason: "missing" });
    }
  }

  if (stampMtime === undefined) {
    // Be stamp'o senumo įrodyti neįmanoma. Tuščias `src` reiškia, kad nėra ko ir statyti —
    // tada stamp'o nebuvimas nėra defektas.
    if (sourceFiles.length > 0) staleFiles.push({ sourcePath: srcDir, distPath: stampPath, reason: "missing" });
    return staleFiles;
  }

  for (const sourcePath of sourceFiles) {
    const sourceMtime = await nodeFsAdapter.fileMtimeMs(sourcePath);
    if (sourceMtime !== undefined && sourceMtime > stampMtime + MTIME_TOLERANCE_MS) {
      staleFiles.push({ sourcePath, distPath: stampPath, reason: "stale" });
    }
  }

  return staleFiles;
}

/**
 * Karantino pranešimas: kodėl commit'as praleistas ir kaip tai išspręsti.
 *
 * Rodomi TIK pirmi dešimt failų: pilnas sąrašas po masinio pakeitimo yra tūkstančiai eilučių,
 * ir jis paskandintų vienintelę eilutę, kuri operatoriui iš tikrųjų svarbi — komandą.
 */
export function staleDistQuarantineMessage(projectRoot: string, staleFiles: readonly StaleDistFile[]): string {
  const files = staleFiles
    .slice(0, 10)
    .map((file) => `  - ${path.relative(projectRoot, file.distPath)} (${file.reason})`)
    .join("\n");
  return [
    `[${new Date().toISOString()}] DIST STALE — Stop hook absorbed, commit skipped (work left uncommitted for you to resolve).`,
    `Resume normal commits with: ${DIST_REBUILD_COMMAND}`,
    "Stale generated files:",
    files,
    "",
  ].join("\n");
}

/**
 * Užfiksuoja pasenusio dist įvykį, kad Stop hook'as galėtų DEGRADUOTI, o ne blokuoti: būsena
 * lieka žurnale operatoriui, o sesijai leidžiama švariai sustoti. NIEKADA nemeta — karantinas
 * negali pats tapti nauju gedimo šaltiniu.
 */
export async function quarantineStaleDist(
  runtimeRoot: string,
  projectRoot: string,
  staleFiles: readonly StaleDistFile[],
): Promise<string> {
  const message = staleDistQuarantineMessage(projectRoot, staleFiles);
  try {
    await nodeFsAdapter.appendTextFile(path.join(runtimeRoot, "logs", "dist-stale-quarantine.md"), message);
  } catch {
    // Žurnalo rašymas best-effort: nepavykęs įrašas negali blokuoti sustojimo.
  }
  return message;
}
