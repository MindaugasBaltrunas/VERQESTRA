// Skenavimo branduolys `tests/dead-export-gate.test.ts` vartui — iškeltas atskirai, kad testų
// failas liktų ≤ 500 eilučių (architecture-gates.test.ts file-length vartas). Šis failas pats
// yra `tests/` kelyje, tad dead-export-gate simbolių/failų patikroms nepriklauso kaip kandidatas
// (žr. `isTest` žymę abiejose patikrose).
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

/**
 * Ženklai, po kurių `/` pradeda REGEX literalą, o ne dalybą.
 *
 * Klasikinė JS leksavimo dviprasmybė. Heuristika ta pati, kurią naudoja minifikatoriai: po
 * operatoriaus, skliausto ar kablelio gali eiti tik reikšmė, tad `/` yra literalo pradžia; po
 * identifikatoriaus, skaičiaus ar `)` — dalyba.
 */
const REGEX_ALLOWED_AFTER = new Set("(,=:[!&|?{};+-*%~^<>".split(""));
const REGEX_ALLOWED_KEYWORDS = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "case",
  "do",
  "else",
  "yield",
  "await",
]);

/**
 * Komentarų šalinimas BŪSENOS mašina, o ne regexu.
 *
 * `body.replace(/\/\*[\s\S]*?\*\//g, "")` nežino, kad `/*` gali stovėti eilutės komentare arba
 * eilutėje, ir tada praryja kodą iki artimiausio uždarymo. Būsenos mašina to negali padaryti:
 * komentaro pradžia atpažįstama TIK iš kodo būsenos. Eilučių lūžiai išlaikomi, kad `^export`
 * inkarai ir eilučių numeriai liktų teisingi.
 *
 * REGEX literalai sekami atskirai (2026-08-24, antras tos pačios klasės radinys). Be jų
 * `.replace(/^`+|`+$/g, "")` pirmą backtick'ą paverčia template eilutės pradžia ir praryja kodą
 * iki kito backtick'o kitoje funkcijoje — `domain/tasks/size.ts` taip prarado kvietimą į
 * `matchProfileSourceRoot`. Kryptis PAVOJINGA: prarytas gabalas slepia KVIETĖJĄ, tad gyvas
 * eksportas paskelbiamas mirusiu. Simbolių klasė (`[^/*]`) irgi sekama — kitaip jos viduje
 * esantis `/` uždarytų literalą per anksti, o `/*` atidarytų fantominį bloką.
 */
export function stripComments(source: string): string {
  let out = "";
  let state: "code" | "line" | "block" | "sq" | "dq" | "tpl" | "regex" = "code";
  let inCharClass = false;
  let i = 0;

  /** Paskutinis reikšmingas jau išvestas ženklas — pagal jį sprendžiama regex vs dalyba. */
  const startsRegex = (): boolean => {
    const trimmed = out.replace(/\s+$/, "");
    if (trimmed === "") return true;
    const last = trimmed[trimmed.length - 1] ?? "";
    if (REGEX_ALLOWED_AFTER.has(last)) return true;
    const word = /([A-Za-z_$][\w$]*)$/.exec(trimmed);
    return word !== null && REGEX_ALLOWED_KEYWORDS.has(word[1] ?? "");
  };

  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];

    if (state === "code") {
      if (c === "/" && next === "/") {
        state = "line";
        i += 2;
        continue;
      }
      if (c === "/" && next === "*") {
        state = "block";
        i += 2;
        continue;
      }
      if (c === "/" && startsRegex()) {
        state = "regex";
        inCharClass = false;
        out += c;
        i += 1;
        continue;
      }
      if (c === "'") state = "sq";
      else if (c === '"') state = "dq";
      else if (c === "`") state = "tpl";
      out += c;
      i += 1;
      continue;
    }

    if (state === "regex") {
      if (c === "\\") {
        out += c + (next ?? "");
        i += 2;
        continue;
      }
      if (c === "[") inCharClass = true;
      else if (c === "]") inCharClass = false;
      else if (c === "/" && !inCharClass) state = "code";
      else if (c === "\n") state = "code"; // neužsidaręs literalas negali ryti kitų eilučių
      out += c;
      i += 1;
      continue;
    }

    if (state === "line") {
      if (c === "\n") {
        state = "code";
        out += c;
      }
      i += 1;
      continue;
    }

    if (state === "block") {
      if (c === "*" && next === "/") {
        state = "code";
        i += 2;
        continue;
      }
      if (c === "\n") out += c;
      i += 1;
      continue;
    }

    // Eilutės viduje: `\` praryja kitą simbolį, kad `"\""` nenutrūktų per anksti.
    if (c === "\\") {
      out += c + (next ?? "");
      i += 2;
      continue;
    }
    if ((state === "sq" && c === "'") || (state === "dq" && c === '"') || (state === "tpl" && c === "`")) state = "code";
    out += c;
    i += 1;
  }

  return out;
}

/**
 * Re-eksporto eilutės (`export { x } from "./y.js"`) NELAIKOMOS kvietimu: barelis vardija
 * simbolį nieko su juo nedarydamas. Be šios išimties kiekvienas `index.ts` prikeltų visą po
 * savimi gulintį mirusį paviršių.
 */
function withoutReExports(strippedBody: string): string {
  return strippedBody
    .split("\n")
    .filter((line) => !/^\s*export\s+.*\bfrom\s+["']/.test(line))
    .join("\n");
}

const IDENTIFIER = /[A-Za-z_$][\w$]*/g;

/** Identifikatorius → kiek kartų failo tekste. Vienas praėjimas per failą vietoj regex per simbolį. */
function tokenCounts(body: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const match of body.matchAll(IDENTIFIER)) {
    const token = match[0];
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  return counts;
}

/**
 * Vartas tikrina REIKŠMES (`function`, `const`, `class`), o ne tipus — sąmoningai.
 *
 * 2026-08-24 pjūvis rado 9 nenaudojamus tipus, ir beveik visi buvo `z.infer<typeof xSchema>` arba
 * `(typeof xConst)[number]` šalia NAUDOJAMOS reikšmės. Tai modulio konvencija („zod prie
 * modulio"), o ne šiukšlė: schemos ir jos tipo pora rašoma kartu, ir tipas dažnai prireikia
 * pirmam kvietėjui, kuris ateis. Įtraukus tipus vartas baustų už teisingą idiomą ir stumtų
 * neeksportuoti tipo — t. y. gadintų kodą, kad praeitų patikra. Tipai runtime nekainuoja nieko.
 *
 * Tikras tipų perteklius (grynas pervadinimas, forma, kurią pakeitė kita) randamas auditu ir
 * trinamas rankomis — 2026-08-24 taip ištrinti `CodexProcessRunner`, `ResumeActor` ir
 * `ResolvedActiveAttempt`.
 */
const EXPORTED_FUNCTION = /^export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm;
const EXPORTED_BINDING = /^export\s+(?:const|class)\s+([A-Za-z_$][\w$]*)/gm;

/**
 * `from "..."` (static import/export) ir `import("...")` (dinaminis, taip pat type-only
 * `import("./x.js").Type`) — abu literalūs specifikatoriai, kuriuos galima statiškai išspręsti.
 * Ne-literalūs dinaminiai importai (`import(new URL(...))`) šio regex neatitinka sąmoningai:
 * jų taikinys nežinomas kompiliavimo metu, tad orphan-file patikrai jie nieko neįrodo.
 */
const SPECIFIER_PATTERN = /\bfrom\s+["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/g;

/** Failo tekste rasti specifikatoriai — tik santykiniai (`./`, `../`), be paketų vardų. */
export function importSpecifiers(body: string): string[] {
  const specifiers: string[] = [];
  for (const match of body.matchAll(SPECIFIER_PATTERN)) {
    const specifier = match[1] ?? match[2];
    if (specifier !== undefined && specifier.startsWith(".")) specifiers.push(specifier);
  }
  return specifiers;
}

/**
 * Santykinis specifikatorius → repo-santykinis `.ts` kelias nuo SRC_ROOT. ESM importai rašo
 * `.js` (nes taip veikia `node --test` po `tsc` build'o), o šaltinis yra `.ts` — sufiksas
 * pakeičiamas, ne pridedamas. Katalogo (be failo vardo) importų šiame repo nėra (patikrinta
 * 2026-09-01 Grep'u), tad `index.ts` fallback'as sąmoningai neįgyvendintas.
 */
export function resolveSpecifier(fromRelative: string, specifier: string): string {
  const fromDir = path.posix.dirname(fromRelative);
  const joined = path.posix.normalize(path.posix.join(fromDir, specifier)).replace(/\\/g, "/");
  if (joined.endsWith(".js")) return `${joined.slice(0, -3)}.ts`;
  return joined.endsWith(".ts") ? joined : `${joined}.ts`;
}

export type ScannedFile = {
  relative: string;
  isTest: boolean;
  counts: Map<string, number>;
  exported: string[];
  imports: Set<string>;
};

export async function collect(dir: string, prefix: string, out: ScannedFile[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      await collect(path.join(dir, entry.name), relative, out);
      continue;
    }
    if (!entry.name.endsWith(".ts")) continue;
    const stripped = stripComments(await readFile(path.join(dir, entry.name), "utf8"));
    const isTest = relative.startsWith("tests/");
    const body = isTest ? stripped : withoutReExports(stripped);
    const exported = isTest
      ? []
      : [...body.matchAll(EXPORTED_FUNCTION), ...body.matchAll(EXPORTED_BINDING)]
          .map((match) => match[1])
          .filter((name): name is string => name !== undefined);
    // Specifikatoriai renkami iš PILNO (ne withoutReExports) teksto: `export * from "./x.js"`
    // barrel'yje YRA importas failų lygio patikrai, net jei simbolių patikrai jis ne kvietimas.
    const imports = new Set(importSpecifiers(stripped).map((specifier) => resolveSpecifier(relative, specifier)));
    out.push({ relative, isTest, counts: tokenCounts(body), exported: [...new Set(exported)], imports });
  }
}

/**
 * Failų lygio našlaičių patikros branduolys — gryna funkcija, kad savipatikra maitintų
 * sintetiniais įėjimais be realaus FS.
 */
export function findOrphanFiles(
  files: readonly Pick<ScannedFile, "relative" | "isTest" | "imports">[],
  entrypoints: ReadonlySet<string>,
): string[] {
  const orphans: string[] = [];
  for (const file of files) {
    if (file.isTest) continue;
    if (entrypoints.has(file.relative)) continue;
    const referenced = files.some((other) => other !== file && other.imports.has(file.relative));
    if (!referenced) orphans.push(file.relative);
  }
  return orphans.sort();
}
