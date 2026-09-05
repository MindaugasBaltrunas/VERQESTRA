// Grynos git būsenos/kelių taisyklės (etalonas: AG_loop core/changes.ts grynoji pusė).
// VERQESTRA skirtumai: runtime prefiksai — vq/* (etalono AG/supervisor|logs|state|project
// atitikmenys), AG/openspec ir AG/tasks bucket'ai lieka. IO pusė (git status, changes.log
// skaitymas) — infrastructure/git.

import { taskBuckets } from "../tasks/buckets.js";

export type ChangedFile = {
  status: string;
  file: string;
};

export type DirtyEntry = {
  status: string;
  path: string;
};

// Orkestratoriaus / spec-lifecycle keliai — niekada ne produkto scope, tad nėra diagnozės
// out-of-scope pažeidimas ir ne „uncommitted product state". Task 889: šiuos priskyrus
// bėgančiam task'ui, lygiagrečios sesijos lifecycle rašymas bendrame worktree sukėlė
// klaidingą human_review + rollback (regresija 875).
const runtimePrefixes = [
  "vq/supervisor/",
  "vq/logs/",
  "vq/state/",
  "vq/project/",
  "vq/runtime/",
  "AG/openspec/",
  ...taskBuckets.map((bucket) => `AG/tasks/${bucket}/`),
  "logs/",
  "dist/",
];

// C-style escape'ai, kuriuos git `quote_c_style` naudoja greta oktalinių baitų.
const gitQuotedControlEscapes: Record<string, number> = {
  a: 0x07,
  b: 0x08,
  f: 0x0c,
  n: 0x0a,
  r: 0x0d,
  t: 0x09,
  v: 0x0b,
  '"': 0x22,
  "\\": 0x5c,
};

/**
 * Git `core.quotePath` (numatytai ĮJUNGTA) kelią su ne-ASCII baitais išveda kaip
 * `"AG/tasks/queue/u\305\276duotis.md"`: kabutėse, o kiekvienas UTF-8 BAITAS — oktaliniu
 * escape'u. Vien kabučių nuėmimas tokį kelią palikdavo literaliu tekstu, kuris NIEKADA
 * neatitikdavo realaus failo (etalono task 0058 pamoka). Dekoduojama į BAITUS, ne į
 * simbolius: vienas UTF-8 simbolis git'ui yra 2-4 atskiri oktaliniai escape'ai.
 */
function decodeGitQuotedPath(quoted: string): string {
  const bytes: number[] = [];
  for (let index = 0; index < quoted.length; index += 1) {
    const char = quoted[index] ?? "";
    if (char !== "\\") {
      bytes.push(...Buffer.from(char, "utf8"));
      continue;
    }

    const octal = quoted.slice(index + 1, index + 4);
    if (/^[0-7]{3}$/.test(octal)) {
      bytes.push(Number.parseInt(octal, 8));
      index += 3;
      continue;
    }

    const next = quoted[index + 1];
    if (next === undefined) {
      // Nutrūkęs escape'as: paliekamas pats backslash'as, kad kelias neliktų tyliai apkirptas.
      bytes.push(0x5c);
      continue;
    }
    const control = gitQuotedControlEscapes[next];
    bytes.push(...(control === undefined ? Buffer.from(next, "utf8") : [control]));
    index += 1;
  }
  return Buffer.from(bytes).toString("utf8");
}

export function normalizeGitPath(filePath: string): string {
  // Kabutėmis apgaubtas kelias yra git quotePath forma — jo backslash'ai yra ESCAPE'ai,
  // tad dekoduojama PRIEŠ Windows separatorių normalizavimą; kitaip `\305` virstų `/305`.
  const unquoted =
    filePath.length >= 2 && filePath.startsWith('"') && filePath.endsWith('"')
      ? decodeGitQuotedPath(filePath.slice(1, -1))
      : filePath;
  return unquoted.replace(/\\/g, "/").replace(/^"|"$/g, "");
}

export function isRuntimePath(filePath: string): boolean {
  const normalized = normalizeGitPath(filePath);
  return runtimePrefixes.some((prefix) => normalized === prefix.slice(0, -1) || normalized.startsWith(prefix));
}

// Build/deps artefaktai — atskira taisyklė nuo orkestratoriaus runtime prefiksų: šie keliai
// egzistuoja bet kuriame node projekte, ne tik VERQESTRA valdomoje kopijoje. Task 198: anksčiau
// šie prefiksai gyveno atskirai `worktree-removal.ts` faile kaip antra, nesuderinta runtime
// sąvoka; `node_modules_backup/` nėra `node_modules/` (tikslus segmentas, ne prefiksas be `/`).
const buildArtifactPrefixes = ["node_modules/", ".pnpm-store/"];

export function isBuildArtifactPath(filePath: string): boolean {
  const normalized = normalizeGitPath(filePath);
  return normalized === "node_modules" || buildArtifactPrefixes.some((prefix) => normalized.startsWith(prefix));
}

// Session-writes ledger'yje repo failai yra repo-relative, o rašymai UŽ repo ribų lieka
// absoliutūs arba prasideda "../" (pvz. Claude atminties failai). Tokie rašymai nėra
// produkto scope ir negali būti diagnozės out-of-scope pažeidimu (etalono 2026-07-22
// pamoka: vien dėl memory įrašų klaidingai nuparkuoti 4 taskai su žaliais gates).
export function isOutsideProjectPath(filePath: string): boolean {
  const normalized = normalizeGitPath(filePath);
  return /^[A-Za-z]:\//.test(normalized) || normalized.startsWith("/") || normalized.startsWith("../");
}

export function parseDirtyEntries(statusOutput: string): DirtyEntry[] {
  return statusOutput
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .flatMap((line) => {
      const status = line.slice(0, 2);
      const rawPath = line.slice(3).trim();
      const paths = rawPath.includes(" -> ") ? rawPath.split(" -> ") : [rawPath];
      return paths.map((entryPath) => ({ status, path: normalizeGitPath(entryPath) }));
    });
}

export function nonRuntimeDirtyEntriesFromStatus(statusOutput: string): DirtyEntry[] {
  return parseDirtyEntries(statusOutput).filter((entry) => !isRuntimePath(entry.path));
}

/**
 * `git status --porcelain` → pakeisti FAILAI su statusu (etalonas: core/changes.ts
 * `gitStatusFiles`). Skiriasi nuo {@link parseDirtyEntries} trimis taisyklėmis, ir kiekviena jų
 * yra sprendimas, ne formatavimas:
 *
 *   • pervadinimas duoda TIK taikinį. `parseDirtyEntries` grąžina abi puses, nes rollback'ui
 *     svarbu ir tai, kas dingo; guard'ams svarbu tik tai, kas DABAR yra medyje, o šaltinio kelias
 *     ten atrodytų kaip antras, neegzistuojantis pakeitimas.
 *   • katalogo įrašas (`/` gale) praleidžiamas — untracked katalogas nėra failo pakeitimas.
 *   • runtime keliai atkrenta: tai loop'o buhalterija, ne produkto darbas.
 */
export function changedFilesFromStatus(statusOutput: string): ChangedFile[] {
  return statusOutput
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .flatMap((line) => {
      const rawPath = line.slice(3).trim();
      const file = normalizeGitPath(rawPath.includes(" -> ") ? (rawPath.split(" -> ").at(-1) ?? rawPath) : rawPath);
      if (!file || file.endsWith("/") || isRuntimePath(file)) return [];
      return [{ status: line.slice(0, 2), file }];
    });
}

/** Grynas filtras diff --name-only išvestims: palieka netuščius ne-runtime kelius. */
export function productPathsFromDiffNames(diffNameOutput: string): string[] {
  return diffNameOutput
    .split(/\r?\n/)
    .map((line) => normalizeGitPath(line).trim())
    .filter((line) => line.length > 0 && !isRuntimePath(line));
}

/**
 * Produkto scope failai, priskirti ŠIAI darbo sesijai, iš session-writes ledger'io.
 * Diagnozė naudoja šitą — ne globalų `git status` — out-of-scope patikrai, tad lygiagrečios
 * sesijos edit'as tame pačiame worktree niekada nepriskiriamas bėgančiam task'ui
 * (regresija 875). Runtime/lifecycle keliai išfiltruojami, sąrašas dedup'intas.
 */
export function sessionScopedChangedFiles(sessionWrites: readonly string[]): string[] {
  const normalized = sessionWrites
    .map((file) => normalizeGitPath(file))
    .filter((file) => file.length > 0 && !isRuntimePath(file) && !isOutsideProjectPath(file));
  return Array.from(new Set(normalized));
}

export type SessionScopedAttribution = {
  /** Tas pats filtruotas/dedup'intas sąrašas kaip sessionScopedChangedFiles(...). */
  changedFiles: string[];
  /**
   * True kai session-writes ledger'io failo nebuvo (`ledgerPresent=false`) — out-of-scope
   * attribution šiai sesijai buvo praleista kaip safe fallback (be false human_review).
   * Kvietėjas šį lauką paverčia warning log eilute arba kitu signalu — čia tik faktas.
   */
  outOfScopeAttributionSkipped: boolean;
};

/**
 * Plonas adityvus wrapper'is virš `sessionScopedChangedFiles`: prideda eksplicitinį
 * "ar ledger'io failas buvo" signalą kaip struktūrizuotą lauką, o ne vien log eilutę
 * (task 020-b-03 / regresija 015). Filtro logika NEDUBLIUOJAMA — deleguojama esamai
 * `sessionScopedChangedFiles` funkcijai.
 */
export function sessionScopedAttribution(input: {
  sessionWrites: readonly string[];
  ledgerPresent: boolean;
}): SessionScopedAttribution {
  return {
    changedFiles: sessionScopedChangedFiles(input.sessionWrites),
    outOfScopeAttributionSkipped: !input.ledgerPresent,
  };
}
