// Grynos (be FS) funkcijos, kuriomis naudojasi `dead-export-gate.test.ts`: teksto skenavimas
// (komentarų šalinimas, eksportuojamų vardų ištraukimas) ir failų lygio našlaičių paieška.
// Iškelta į bendrą helper'į, kad varto TESTŲ failas tilptų į 500 eilučių ribą (task 234).
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
export function withoutReExports(strippedBody: string): string {
  return strippedBody
    .split("\n")
    .filter((line) => !/^\s*export\s+.*\bfrom\s+["']/.test(line))
    .join("\n");
}

const IDENTIFIER = /[A-Za-z_$][\w$]*/g;

/** Identifikatorius → kiek kartų failo tekste. Vienas praėjimas per failą vietoj regex per simbolį. */
export function tokenCounts(body: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const match of body.matchAll(IDENTIFIER)) {
    const token = match[0];
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  return counts;
}

/**
 * Vartas tikrina REIKŠMES (`function`, `const`, `class`, ...), o ne tipus — sąmoningai.
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
const EXPORTED_BINDING = /^export\s+(?:const|class|let|var|enum)\s+([A-Za-z_$][\w$]*)/gm;

/**
 * `export default <vardas>` trimis formomis: pavadinta funkcija, pavadinta klasė, arba grynas
 * identifikatorius (`export default someName;`). Anoniminis `export default function () {}` /
 * `export default { ... }` neturi vardo, kurį būtų galima prikelti — sąmoningai neatpažįstamas.
 * Grynam identifikatoriui reikalaujamas `;` po jo, kad `export default fn()` (kvietimas, ne
 * pervadinimas) nebūtų palaikytas simbolio deklaracija.
 */
const EXPORTED_DEFAULT =
  /^export\s+default\s+(?:(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)|class\s+([A-Za-z_$][\w$]*)|([A-Za-z_$][\w$]*)\s*;)/gm;

/**
 * `export { a, b as c };` be `from` — barelio taikinys lieka failų lygio vartui (`(?!\s*from\b)`
 * atmeta re-eksportus), o `type X` sąrašo viduje lieka už token'inio varto ribų kaip ir kiti
 * tipo-only eksportai (žr. `EXPORTED_FUNCTION`/`EXPORTED_BINDING` komentarą aukščiau).
 */
const EXPORTED_LIST = /^export\s*\{([^}]*)\}(?!\s*from\b)/gm;

function exportedDefaultNames(body: string): string[] {
  const names: string[] = [];
  for (const match of body.matchAll(EXPORTED_DEFAULT)) {
    const name = match[1] ?? match[2] ?? match[3];
    if (name !== undefined) names.push(name);
  }
  return names;
}

/** Vieno sąrašo specifikatorių skaidymas: `as` alias yra vardas, kurį importuotojas rašo. */
function exportedListNames(body: string): string[] {
  const names: string[] = [];
  for (const match of body.matchAll(EXPORTED_LIST)) {
    const list = match[1];
    if (list === undefined) continue;
    for (const rawPart of list.split(",")) {
      const part = rawPart.trim();
      if (part === "" || part.startsWith("type ")) continue;
      const aliased = /^[A-Za-z_$][\w$]*\s+as\s+([A-Za-z_$][\w$]*)$/.exec(part);
      if (aliased) {
        const alias = aliased[1];
        if (alias !== undefined) names.push(alias);
        continue;
      }
      if (/^[A-Za-z_$][\w$]*$/.test(part)) names.push(part);
    }
  }
  return names;
}

/** Visos atpažįstamos eksporto formos vienu kvietimu — kviečiama iš komentarų nuvalyto teksto. */
export function exportedNames(body: string): string[] {
  return [
    ...[...body.matchAll(EXPORTED_FUNCTION), ...body.matchAll(EXPORTED_BINDING)]
      .map((match) => match[1])
      .filter((name): name is string => name !== undefined),
    ...exportedDefaultNames(body),
    ...exportedListNames(body),
  ];
}

const STATIC_IMPORT = /import\s+(?:[^'"();]+?\s+from\s+)?["']([^"']+)["']/g;
const EXPORT_FROM = /export\s+[^'"();]*?\bfrom\s+["']([^"']+)["']/g;
const DYNAMIC_IMPORT = /import\s*\(\s*["']([^"']+)["']\s*\)/g;

/** Iš teksto ištraukia visus `import`/`export ... from`/dinaminio `import()` specifikatorius. */
export function collectImportSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  for (const pattern of [STATIC_IMPORT, EXPORT_FROM, DYNAMIC_IMPORT]) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier !== undefined) specifiers.push(specifier);
    }
  }
  return specifiers;
}

/**
 * Santykinį (`./`, `../`) specifikatorių verčia repo-santykiniu `.ts` keliu. Ne-santykiniai
 * specifikatoriai (paketai, `node:` builtin'ai) grąžina `undefined` — jie niekada nenurodo į
 * src failą.
 */
export function resolveSpecifier(fromRelative: string, specifier: string): string | undefined {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) return undefined;
  const fromDir = path.posix.dirname(fromRelative);
  const joined = path.posix.normalize(path.posix.join(fromDir, specifier));
  if (joined.endsWith(".js")) return `${joined.slice(0, -3)}.ts`;
  return joined.endsWith(".ts") ? joined : `${joined}.ts`;
}

export type OrphanScanFile = {
  readonly relative: string;
  readonly source: string;
};

/**
 * Grąžina produkcinius (ne `tests/`) failus, kurių kelio nemini nė vieno KITO failo
 * specifikatoriai ir kurių nėra `entrypoints`.
 */
export function findOrphanFiles(files: ReadonlyArray<OrphanScanFile>, entrypoints: ReadonlySet<string>): string[] {
  const mentionedBy = new Map<string, Set<string>>();
  for (const file of files) {
    for (const specifier of collectImportSpecifiers(file.source)) {
      const resolved = resolveSpecifier(file.relative, specifier);
      if (resolved === undefined) continue;
      const mentioners = mentionedBy.get(resolved) ?? new Set<string>();
      mentioners.add(file.relative);
      mentionedBy.set(resolved, mentioners);
    }
  }

  const orphans: string[] = [];
  for (const file of files) {
    if (file.relative.startsWith("tests/")) continue;
    if (entrypoints.has(file.relative)) continue;
    const mentioners = mentionedBy.get(file.relative);
    const mentionedByOther = mentioners !== undefined && [...mentioners].some((mentioner) => mentioner !== file.relative);
    if (mentionedByOther) continue;
    orphans.push(file.relative);
  }
  return orphans;
}
