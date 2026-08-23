// Projekto failų skenavimas ir source hash. Behaviour etalon: AG_loop code-index/scanner.ts;
// FS — per CodeIntelligenceFileSystemPort (WBR VQ-301), hash — node:crypto (leistas application).

import { createHash } from "node:crypto";
import path from "node:path";
import { normalizeProjectPath, toPosixPath } from "../../../shared/paths.js";
import type { CodeIntelligenceFileSystemPort } from "../ports.js";
import { indexedCodeExtensions, languageForExtension } from "./language-capabilities.js";
import type { CodeIndexFile, CodeIndexFileKind } from "./types.js";

const indexedExtensions = indexedCodeExtensions();
// ".claude" excludes the executor's own worktree/session state (isolated checkouts can
// contain a full nested copy of the repo's source tree and would be double-scanned).
// ".ag"/".ag-worktrees"/".vq-worktrees" — izoliuotos darbo kopijos: gyvo lygiagretaus
// run'o metu ten guli PILNA repo kopija, kuri be šio įrašo padvigubintų import grafą.
// Katalogai, kurie NIEKADA nėra produkto kodas — nepriklausomai nuo to, kur guli. Visi jie arba
// yra įrankio nuosavybė (`.git`, `.claude`), arba turi vienintelę galimą prasmę (`node_modules`,
// `__pycache__`, `.next`, `.turbo`).
const ignoredSegments = new Set([
  ".git",
  ".claude",
  ".ag",
  ".ag-worktrees",
  ".vq-worktrees",
  "node_modules",
  ".next",
  ".turbo",
  "__pycache__",
]);

/**
 * Build'o išvesties katalogai, atpažįstami pagal ĮRODYMĄ, o ne pagal vardą (2026-08-23 RAG
 * auditas).
 *
 * `bin`, `obj`, `dist` ir `vendor` anksčiau buvo ignoruojami bet kuriame gylyje. Tai išmesdavo
 * teisėtą produkto kodą: `src/bin/cli.ts` yra įprasta CLI projektų struktūra, o indeksas tokio
 * failo tiesiog neturėdavo — ir vis tiek vadindavosi šviežiu, tad užklausa grąžindavo tuščią
 * rezultatą be jokios žymos, kad kažko trūksta.
 *
 * Šie vardai yra generuoto medžio vardai TIK ten, kur šalia stovi juos generuojantis projekto
 * manifestas. Kaimynų sąrašą walk'as jau turi (jis ką tik išlistino katalogą), tad įrodymas
 * nekainuoja nė vieno papildomo IO.
 */
const buildOutputEvidence: { segment: string; sibling: (name: string) => boolean }[] = [
  { segment: "dist", sibling: (name) => name === "package.json" },
  { segment: "coverage", sibling: (name) => name === "package.json" },
  { segment: "bin", sibling: isDotnetProjectFile },
  { segment: "obj", sibling: isDotnetProjectFile },
  { segment: "vendor", sibling: (name) => name === "composer.json" || name === "go.mod" },
];

function isDotnetProjectFile(name: string): boolean {
  return /\.(csproj|vbproj|fsproj|sln)$/i.test(name);
}
// Runtime medžiai, kurie nėra produkto kodas. AG_loop prefiksai palikti, kad indeksas,
// paleistas ant AG-formos target projekto, elgtųsi identiškai; vq/ — VERQESTRA runtime.
const ignoredRuntimePrefixes = [
  "AG/state",
  "AG/logs",
  "AG/supervisor",
  "AG/tasks",
  "AG/orchestrator/dist",
  "AG/orchestrator/docs",
  "AG/orchestrator/ui-app/node_modules",
  "vq/state",
  "vq/logs",
  // 2026-08-23: `vq/supervisor` ir `vq/generated` truko — AG pusėje `AG/supervisor` buvo, o jo VQ
  // atitikmuo migruojant neatsirado. Ten guli PAČIO įrankio išvestis (`context-pack.json`,
  // `execution-context.md`), tad ji visą laiką buvo skenuojama kaip produkto kodas.
  //
  // Iki JSON įtraukimo į `source_hash` tai nesimatė: pack'o failas patekdavo į indeksą, bet
  // atspaudo nejudino. Įtraukus JSON, pirmas pack'o rašymas iškart pasendindavo indeksą, kurį
  // pats ką tik naudojo — įrankis būtų nuolat perstatinėjęs indeksą dėl savo paties išvesties.
  // Tai pagavo `characterization-context-pack-assembly` kešo idempotencijos testas.
  "vq/supervisor",
  "vq/generated",
];

export async function scanProjectFiles(
  fs: CodeIntelligenceFileSystemPort,
  projectRoot: string,
): Promise<CodeIndexFile[]> {
  const root = path.resolve(projectRoot);
  const files: CodeIndexFile[] = [];
  await walk(fs, root, root, files);
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

/**
 * `source_hash`: KIEKVIENO indeksuoto failo kelias + turinio hash'as.
 *
 * Be išimčių (2026-08-23, operatoriaus radinys). Iki tol JSON buvo sąmoningai išmestas, o grįždavo
 * tik per `kind === "config"` išimtį, kurią lemia VARDŲ heuristika (`config|package|tsconfig|…`).
 * Todėl `data.json` turinio pakeitimas `source_hash`'o nejudino, ir `checkCodeIndexFreshness`
 * grąžindavo `ok: true`, nors indeksas laikė nebegaliojantį to failo hash'ą.
 *
 * Invariantas dabar vienas ir patikrinamas: kas patenka į indeksą, tas patenka ir į jo atspaudą.
 * Atrankos funkcija (`isSourceHashFile`) PAŠALINTA 2026-08-23 (RAG auditas 3): ji visada grąžindavo
 * `true`, bet stovėjo kaip filtras, tad skaitytojui atrodė, kad išimčių vis dar yra.
 *
 * Triukšmo rizikos nėra, nes generuoti medžiai į skenavimą nepatenka (žr. sąrašus viršuje).
 */
export function computeSourceHash(files: CodeIndexFile[]): Promise<string> {
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file.path);
    hash.update(String.fromCharCode(0));
    hash.update(file.hash);
    hash.update(String.fromCharCode(0));
  }
  return Promise.resolve(hash.digest("hex"));
}

export async function hashFile(fs: CodeIntelligenceFileSystemPort, filePath: string): Promise<string> {
  const content = await fs.readFileBytes(filePath);
  return createHash("sha256").update(content).digest("hex");
}

async function walk(
  fs: CodeIntelligenceFileSystemPort,
  projectRoot: string,
  currentDir: string,
  files: CodeIndexFile[],
): Promise<void> {
  const entries = await fs.listDirectory(currentDir);
  const siblingFiles = entries.filter((entry) => entry.isFile).map((entry) => entry.name);
  for (const entry of entries) {
    const absolute = path.join(currentDir, entry.name);
    const relative = normalizeProjectPath(projectRoot, absolute);
    if (shouldIgnore(relative, entry.name, siblingFiles)) {
      continue;
    }

    if (entry.isDirectory) {
      await walk(fs, projectRoot, absolute, files);
      continue;
    }

    if (!entry.isFile || !indexedExtensions.has(extensionForFile(entry.name))) {
      continue;
    }

    files.push({
      path: toPosixPath(relative),
      hash: await hashFile(fs, absolute),
      size: await fs.fileSize(absolute),
      language: languageForExtension(extensionForFile(entry.name)),
      kind: kindForFile(relative),
      imports: [],
      exports: [],
      symbols: [],
      isTest: isTestPath(relative),
    });
  }
}

function shouldIgnore(relativePath: string, entryName: string, siblingFiles: readonly string[]): boolean {
  if (ignoredSegments.has(entryName)) {
    return true;
  }
  const buildOutput = buildOutputEvidence.find((candidate) => candidate.segment === entryName);
  if (buildOutput && siblingFiles.some((name) => buildOutput.sibling(name))) {
    return true;
  }
  const normalized = toPosixPath(relativePath);
  return ignoredRuntimePrefixes.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`));
}

function extensionForFile(fileName: string): string {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".csproj")) return ".csproj";
  if (lower.endsWith(".sln")) return ".sln";
  if (lower.endsWith(".props")) return ".props";
  if (lower.endsWith(".targets")) return ".targets";
  return path.extname(lower);
}

function kindForFile(relativePath: string): CodeIndexFileKind {
  const normalized = toPosixPath(relativePath);
  if (isTestPath(normalized)) return "test";
  if (/\b(config|package|tsconfig|eslint|vite|vitest|pyproject|composer|csproj|sln)\b/i.test(path.basename(normalized)))
    return "config";
  return "source";
}

/**
 * Ar failas yra testas.
 *
 * Šablonai seka kiekvienos kalbos ĮRANKIO numatytąją konvenciją, o ne mūsų skonį:
 *   pytest   `test_*.py` IR `*_test.py` (`python_files` numatytoji reikšmė);
 *   PHPUnit  `*Test.php`;
 *   xUnit/NUnit/MSTest  `*Test.cs` / `*Tests.cs`;
 *   JS/TS    `*.test.*` / `*.spec.*` visiems ECMAScript plėtiniams.
 *
 * 2026-08-23 (operatoriaus radinys): Python šablonas buvo `(test_|.*_test)\.py`, o pirmoji
 * alternatyva reikalavo failo, pavadinto TIKSLIAI `test_.py` — tad `test_main.py`, dažniausia
 * pytest forma, testu nebuvo laikoma. Veikė tik `*_test.py`. Tuo pačiu pridėti `.mjs`/`.cjs`,
 * kurių `[tj]sx?` nedengė, nors code-index juos indeksuoja.
 */
export function isTestPath(relativePath: string): boolean {
  const normalized = toPosixPath(relativePath);
  return (
    /(^|\/)(__tests__|tests?|spec)\//i.test(normalized) ||
    /\.(test|spec)\.([tj]sx?|mjs|cjs)$/i.test(normalized) ||
    /(^|\/)(test_[^/]+|[^/]+_test)\.py$/i.test(normalized) ||
    /(^|\/)[^/]*Test\.php$/i.test(normalized) ||
    /(^|\/)[^/]*Tests?\.cs$/i.test(normalized)
  );
}
