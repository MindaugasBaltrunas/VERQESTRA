// Python code-index ištraukėjas: importai ir simboliai.
//
// Veikia su BET KURIUO framework'u (Django, Flask, FastAPI, pytest…), nes remiasi tik kalbos
// konstrukcijomis — `import`, `from … import`, `def`, `class`. Framework'ai keičia, KAS importuojama,
// ne kaip importas užrašomas.
//
// Reliatyvūs importai (`from .models import X`) verčiami į repo kelią pagal paties failo vietą, tad
// jie tampa TIKROMIS briaunomis. Absoliutūs (`import os`, `from django.db import models`) lieka
// moduliais: be `sys.path`/`PYTHONPATH` žinojimo spėti, kuris jų yra repo viduje, reikštų išgalvoti
// briauną — o šiame indekse briauna reiškia įrodytą ryšį.

import { blankOutNoise, indentAt, lineAt, lineIndex, PYTHON_QUOTES } from "./lexical.js";
import type { CodeIndexFile, CodeIndexSymbol } from "./types.js";
import type { LanguageIndexResult } from "./language-indexer-model.js";

const IMPORT_PLAIN = /^[ \t]*import[ \t]+([^\n#]+)/gm;
const IMPORT_FROM = /^[ \t]*from[ \t]+(\.*)([A-Za-z0-9_.]*)[ \t]+import[ \t]+([^\n#]+)/gm;
const DECLARATION = /^([ \t]*)(async[ \t]+def|def|class)[ \t]+([A-Za-z_][A-Za-z0-9_]*)/gm;
const ALL_LIST = /__all__\s*=\s*[[(]([^\])]*)[\])]/;

export function indexPythonSource(file: CodeIndexFile, text: string, knownPaths: ReadonlySet<string>): LanguageIndexResult {
  const clean = blankOutNoise(text, "hash", PYTHON_QUOTES);
  const offsets = lineIndex(clean);
  const imports = new Set<string>();
  const roots = pythonRoots(knownPaths);

  for (const match of clean.matchAll(IMPORT_PLAIN)) {
    for (const part of splitList(match[1] ?? "")) {
      const module = part.split(/\s+as\s+/)[0]?.trim() ?? "";
      if (module) imports.add(resolveAbsolute(module, knownPaths, roots) ?? module);
    }
  }

  for (const match of clean.matchAll(IMPORT_FROM)) {
    const dots = (match[1] ?? "").length;
    const module = (match[2] ?? "").trim();
    if (dots === 0) {
      if (module) imports.add(resolveAbsolute(module, knownPaths, roots) ?? module);
      continue;
    }
    const resolved = resolveRelative(file.path, dots, module, knownPaths);
    imports.add(resolved ?? `${".".repeat(dots)}${module}`);
  }

  // `__all__` yra vienintelis eksplicitus Python eksporto sąrašas. Jo esant jis LAIMI prieš
  // pavadinimo konvenciją: autorius pasakė, ką laiko vieša.
  //
  // Skaitomas iš teksto, kuriame ištrinti TIK komentarai: pats sąrašas susideda iš eilučių
  // literalų, tad `clean` versijoje jis būtų tuščias. Užkomentuotas `__all__` vis tiek neskaitomas.
  const commentsOnly = blankOutNoise(text, "hash", { quotes: [], escapes: false });
  const declaredAll = ALL_LIST.exec(commentsOnly);
  const allowList = declaredAll
    ? new Set(
        splitList(declaredAll[1] ?? "")
          .map((entry) => entry.replace(/^['"]|['"]$/g, "").trim())
          .filter(Boolean),
      )
    : undefined;

  const symbols: CodeIndexSymbol[] = [];
  const exports = new Set<string>();
  const matches = [...clean.matchAll(DECLARATION)];

  for (const [position, match] of matches.entries()) {
    const indent = (match[1] ?? "").length;
    const keyword = (match[2] ?? "").trim();
    const name = match[3] ?? "";
    const start = match.index ?? 0;

    // Įdėtinės deklaracijos (metodai, vidinės funkcijos) į simbolių sąrašą nepatenka: jų tapatybė
    // yra `klasė.metodas`, o ne `failas#vardas`, ir be tos kvalifikacijos jos susilietų su
    // to paties vardo metodais kitose klasėse.
    if (indent > 0) continue;

    const kind = keyword === "class" ? "class" : "function";
    const exported = allowList ? allowList.has(name) : !name.startsWith("_");
    if (exported) exports.add(name);

    symbols.push({
      id: `${file.path}#${name}`,
      file: file.path,
      name,
      kind,
      exported,
      line: lineAt(offsets, decoratedStart(clean, start)),
      endLine: lineAt(offsets, blockEnd(clean, start, matches, position)),
    });
  }

  return {
    file: { ...file, imports: [...imports].sort(), exports: [...exports].sort(), symbols: symbols.map((s) => s.name).sort() },
    symbols,
    edges: [],
  };
}

/**
 * Failai, kurių buvimas kataloge daro jį Python paketo šaknimi (`sys.path` įrašu).
 *
 * Visi keturi YRA indeksuojami (`config` kalba, 2026-08-24), tad jie matomi per `knownPaths` ir
 * KARTU patenka į `source_hash`. Tai ne patogumas, o invariantas: markeris keičia importų prasmę,
 * vadinasi, jo atsiradimas privalo pasendinti indeksą. Trumpai buvusi tarpinė realizacija juos
 * zondavo per FS portą — tada rezoliucija pasikeisdavo, o atspaudas ne, ir indeksas likdavo
 * klaidingai „fresh" iki priverstinio perstatymo.
 */
const PYTHON_ROOT_MARKERS = ["pyproject.toml", "setup.py", "setup.cfg", "tox.ini"];

/**
 * Katalogai, nuo kurių absoliutus importas gali prasidėti.
 *
 * Trys šaltiniai, ir kiekvienas atitinka realų `sys.path` įrašą:
 *   • repo šaknis (`""`) — taip Python elgiasi paleistas iš projekto katalogo;
 *   • `src` išdėstymas BET KURIAME gylyje (2026-08-24, operatoriaus radinys): anksčiau buvo
 *     `candidate.startsWith("src/")`, tad monorepo `packages/api/src` šaknimi netapdavo NIEKADA, ir
 *     `packages/api/src/app/main.py` importas `app.service` likdavo tekstinis — su juo dingdavo ir
 *     importai, ir architektūros pažeidimai, ir `impacted_tests`. `src` layout yra dominuojanti
 *     Python paketavimo forma, tad tai buvo ne kraštinis atvejis;
 *   • katalogai, kuriuose guli projekto manifestas (žr. `PYTHON_ROOT_MARKERS`).
 */
function pythonRoots(knownPaths: ReadonlySet<string>): string[] {
  const roots = new Set<string>([""]);
  for (const candidate of knownPaths) {
    const slash = candidate.lastIndexOf("/");
    const directory = slash === -1 ? "" : candidate.slice(0, slash);
    if (PYTHON_ROOT_MARKERS.includes(candidate.slice(slash + 1))) roots.add(directory);
    // Kiekvienas `src` segmentas kelyje yra kandidatas: `packages/api/src/app/service.py` duoda
    // `packages/api/src`, o `src/app/x.py` — `src`.
    const segments = candidate.split("/");
    for (const [index, segment] of segments.entries()) {
      if (segment === "src" && index < segments.length - 1) roots.add(segments.slice(0, index + 1).join("/"));
    }
  }
  return [...roots];
}

/**
 * Absoliutus importas → repo kelias, kai jis prasideda nuo PAKETO ŠAKNIES.
 *
 * 2026-08-23 (RAG auditas 3): iki tol tiko bet koks kelio SUFIKSAS, jei jis repo buvo vienintelis.
 * Todėl `import json` būdavo susiejamas su `src/infrastructure/json.py` — vien todėl, kad kito failo
 * tokiu vardu nėra. Tai ne įrodymas: `src/infrastructure` nėra `sys.path` įrašas, ir tikrasis
 * `import json` ima standartinę biblioteką. Reprodukcijoje toks ryšys sukūrė NETIKRĄ architektūros
 * pažeidimą — blogiau nei praleistas ryšys, nes jis reikalauja veiksmo.
 *
 * Rooting'as tą pataiso be jokių sąrašų: `json.py` laikomas importuojamu tik tada, kai jis realiai
 * guli šaknyje, kur Python jį ir rastų — o tada jis stdlib tikrai ir uždengia.
 *
 * Ieškoma ir pakuotės (`app/models/__init__.py`), nes `import app.pkg` nurodo būtent ją.
 */
function resolveAbsolute(module: string, knownPaths: ReadonlySet<string>, roots: readonly string[]): string | undefined {
  if (module === "") return undefined;
  const base = module.split(".").join("/");

  const matches = new Set<string>();
  for (const suffix of [`${base}.py`, `${base}/__init__.py`]) {
    for (const root of roots) {
      const candidate = root === "" ? suffix : `${root}/${suffix}`;
      if (knownPaths.has(candidate)) matches.add(candidate);
    }
  }
  // Dviprasmybė (tas pats modulis dviejose šaknyse) atmetama — ta pati taisyklė kaip kanoninėje
  // `resolveTaskNode` rezoliucijoje: tyli teisinga atsakymo pusė čia yra „nežinau".
  return matches.size === 1 ? [...matches][0] : undefined;
}

/** Reliatyvus importas → repo kelias. `.` = šio failo paketas, `..` = tėvinis, ir t. t. */
function resolveRelative(filePath: string, dots: number, module: string, knownPaths: ReadonlySet<string>): string | undefined {
  const segments = filePath.split("/");
  segments.pop();
  for (let step = 1; step < dots; step += 1) segments.pop();
  const base = [...segments, ...(module ? module.split(".") : [])].join("/");
  for (const candidate of [`${base}.py`, `${base}/__init__.py`]) {
    if (knownPaths.has(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Deklaracijos PRADŽIA su dekoratoriais (2026-08-23, RAG auditas 3).
 *
 * `@route("/x")` virš `def handler():` yra deklaracijos dalis: be jo pjūvis rodo funkciją, kuri
 * atrodo neužregistruota. Imamos gretimos eilutės aukštyn, kol jos prasideda `@` (tarpai ir
 * komentarai tarp dekoratorių leidžiami — juos Python irgi praleidžia).
 */
function decoratedStart(text: string, start: number): number {
  let result = start;
  let cursor = start;
  while (cursor > 0) {
    const lineStart = text.lastIndexOf("\n", cursor - 2) + 1;
    const line = text.slice(lineStart, cursor - 1);
    const trimmed = line.trim();
    if (trimmed.startsWith("@")) {
      result = lineStart;
      cursor = lineStart;
      continue;
    }
    // Kelių eilučių dekoratoriaus (`@route(\n  "/x",\n)`) tęsinys: įtraukta eilutė arba
    // uždarantis skliaustas. Jos pačios pradžia netampa rezultatu — juo tampa tik `@` eilutė.
    if (trimmed !== "" && (/^[ \t]/.test(line) || /^[)\]}],?$/.test(trimmed))) {
      cursor = lineStart;
      continue;
    }
    break;
  }
  return result;
}

/**
 * Deklaracijos pabaiga: paskutinė ĮTRAUKTA (bloko) eilutė.
 *
 * 2026-08-23 (RAG auditas 3): anksčiau grąžinama buvo eilutė prieš kitą top-level deklaraciją, tad į
 * funkcijos pjūvį patekdavo VISKAS, kas tarp jų — įskaitant modulio lygio sakinius (`SECRET =
 * load_secret()`), kurie funkcijai nepriklauso. Blokas Python'e yra įtrauka, tad ji ir yra riba:
 * imama paskutinė netuščia eilutė su įtrauka > 0 prieš kitą top-level deklaraciją.
 *
 * Vienos eilutės kūnas (`def f(): pass`) įtrauktų eilučių neturi — tada pabaiga yra pati antraštė.
 */
function blockEnd(text: string, start: number, matches: RegExpMatchArray[], position: number): number {
  let limit = text.length;
  for (let next = position + 1; next < matches.length; next += 1) {
    const offset = matches[next]?.index ?? -1;
    if (offset > start && indentAt(text, offset) === 0) {
      limit = offset;
      break;
    }
  }

  const headerEnd = text.indexOf("\n", start);
  if (headerEnd === -1 || headerEnd >= limit) return Math.max(start, limit - 1);

  let end = headerEnd;
  let cursor = headerEnd + 1;
  while (cursor < limit) {
    const lineEnd = text.indexOf("\n", cursor);
    const stop = lineEnd === -1 || lineEnd > limit ? limit : lineEnd;
    const line = text.slice(cursor, stop);
    if (line.trim() !== "" && indentAt(text, cursor) > 0) end = stop === limit ? limit - 1 : stop;
    if (lineEnd === -1) break;
    cursor = lineEnd + 1;
  }
  return Math.max(start, end);
}

function splitList(value: string): string[] {
  return value
    .replace(/[()\\]/g, " ")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}
