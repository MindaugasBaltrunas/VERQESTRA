// C# code-index ištraukėjas: importai ir simboliai.
//
// Veikia su bet kuriuo framework'u (ASP.NET Core, MAUI, Unity, xUnit…), nes remiasi kalbos
// konstrukcijomis: `using`, `namespace` ir tipų deklaracijos. Framework'as keičia, KOKIE tipai
// deklaruojami, ne kaip deklaracija atrodo.
//
// Palaikomos visos `using` formos, įskaitant C# 10 `global using` ir alias'us, bei ir failo lygio
// (`namespace X;`), ir bloko (`namespace X { }`) namespace sintaksės.

import { blankOutNoise, C_LIKE_QUOTES, lineAt, lineIndex } from "./lexical.js";
import type { CodeIndexFile, CodeIndexSymbol, CodeIndexSymbolKind } from "./types.js";
import type { LanguageIndexResult } from "./language-indexer-model.js";

const USING = /^[ \t]*(?:global[ \t]+)?using[ \t]+(?:static[ \t]+)?(?:([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*)?([A-Za-z_][A-Za-z0-9_.<>, ]*?)[ \t]*;/gm;
const NAMESPACE = /^[ \t]*namespace[ \t]+([A-Za-z_][A-Za-z0-9_.]*)/m;
const TYPE_DECLARATION =
  /^[ \t]*(?:\[[^\]]*\][ \t]*)*((?:public|internal|private|protected|static|sealed|abstract|partial|readonly|ref|file)[ \t]+)*(class|interface|struct|record|enum|delegate)[ \t]+([A-Za-z_][A-Za-z0-9_]*)/gm;

const KIND_BY_KEYWORD: Record<string, CodeIndexSymbolKind> = {
  class: "class",
  interface: "interface",
  struct: "class",
  record: "class",
  enum: "enum",
  delegate: "type",
};

export function indexCSharpSource(file: CodeIndexFile, text: string): LanguageIndexResult {
  const clean = blankOutNoise(text, "c", C_LIKE_QUOTES);
  const offsets = lineIndex(clean);

  const imports = new Set<string>();
  for (const match of clean.matchAll(USING)) {
    // Alias (`using Foo = System.Bar;`) — importas yra TAIKINYS, ne alias'o vardas.
    const target = (match[2] ?? "").trim();
    if (target) imports.add(target);
  }

  const namespaceName = NAMESPACE.exec(clean)?.[1] ?? "";
  const symbols: CodeIndexSymbol[] = [];
  const exports = new Set<string>();
  const declarations = [...clean.matchAll(TYPE_DECLARATION)];

  for (const [position, match] of declarations.entries()) {
    const modifiers = match[0].slice(0, match[0].indexOf(match[2] ?? "")).toLowerCase();
    const keyword = match[2] ?? "";
    const name = match[3] ?? "";
    const kind = KIND_BY_KEYWORD[keyword];
    if (!kind || !name) continue;

    // `exported` = matomas UŽ assembly ribų. `internal` yra numatytoji C# reikšmė, tad tylėjimas
    // reiškia „ne", o ne „taip" — priešingai nei PHP, kur top-level deklaracija visada vieša.
    const exported = /\bpublic\b/.test(modifiers) || /\bprotected\b/.test(modifiers);
    if (exported) exports.add(namespaceName ? `${namespaceName}.${name}` : name);

    const start = match.index ?? 0;
    symbols.push({
      id: `${file.path}#${name}`,
      file: file.path,
      name,
      kind,
      exported,
      line: lineAt(offsets, start),
      endLine: lineAt(offsets, bodyEnd(clean, start, declarations[position + 1]?.index ?? clean.length)),
    });
  }

  return {
    file: { ...file, imports: [...imports].sort(), exports: [...exports].sort(), symbols: symbols.map((s) => s.name).sort() },
    symbols,
    edges: [],
  };
}

/** Tipo pabaiga: suderintas `}`, arba `;` — `record Point(int X);` kūno neturi. */
function bodyEnd(text: string, start: number, limit: number): number {
  const open = text.indexOf("{", start);
  const semicolon = text.indexOf(";", start);
  if (open === -1 || open > limit || (semicolon !== -1 && semicolon < open)) {
    return semicolon === -1 ? start : semicolon;
  }
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    if (text[index] === "{") depth += 1;
    else if (text[index] === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return limit;
}
