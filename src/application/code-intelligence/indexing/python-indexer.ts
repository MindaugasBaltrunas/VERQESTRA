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

  for (const match of clean.matchAll(IMPORT_PLAIN)) {
    for (const part of splitList(match[1] ?? "")) {
      const module = part.split(/\s+as\s+/)[0]?.trim() ?? "";
      if (module) imports.add(module);
    }
  }

  for (const match of clean.matchAll(IMPORT_FROM)) {
    const dots = (match[1] ?? "").length;
    const module = (match[2] ?? "").trim();
    if (dots === 0) {
      if (module) imports.add(module);
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
      line: lineAt(offsets, start),
      endLine: lineAt(offsets, blockEnd(clean, start, matches, position)),
    });
  }

  return {
    file: { ...file, imports: [...imports].sort(), exports: [...exports].sort(), symbols: symbols.map((s) => s.name).sort() },
    symbols,
    edges: [],
  };
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
 * Deklaracijos pabaiga: paskutinė eilutė prieš kitą TOKIO PAT ar mažesnio įtraukos lygio
 * deklaraciją. Python bloką riboja įtrauka, tad kito top-level `def`/`class` pradžia yra šio
 * pabaiga; paskutinei deklaracijai — failo galas.
 */
function blockEnd(text: string, start: number, matches: RegExpMatchArray[], position: number): number {
  for (let next = position + 1; next < matches.length; next += 1) {
    const candidate = matches[next];
    const offset = candidate?.index ?? -1;
    if (offset > start && indentAt(text, offset) === 0) return Math.max(start, offset - 1);
  }
  return text.length;
}

function splitList(value: string): string[] {
  return value
    .replace(/[()\\]/g, " ")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}
