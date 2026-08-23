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

  const symbols: CodeIndexSymbol[] = [];
  const exports = new Set<string>();
  const declarations = [...clean.matchAll(TYPE_DECLARATION)];
  // Įdėtinių tipų savininkų dėklas (2026-08-23, operatoriaus radinys). Iki tol `Outer.Inner` ir
  // top-level `Inner` gaudavo VIENĄ ID `failas#Inner`, tad indekse jie susiliedavo, o `declares`
  // briaunos rodydavo į tą patį mazgą. C# įdėtinis tipas yra tikras API paviršius (jis ir
  // nurodomas kaip `Outer.Inner`), tad jis KVALIFIKUOJAMAS, o ne praleidžiamas kaip Python metodai.
  const owners: { name: string; end: number }[] = [];

  for (const [position, match] of declarations.entries()) {
    const modifiers = match[0].slice(0, match[0].indexOf(match[2] ?? "")).toLowerCase();
    const keyword = match[2] ?? "";
    const name = match[3] ?? "";
    const kind = KIND_BY_KEYWORD[keyword];
    if (!kind || !name) continue;

    // `exported` = matomas UŽ assembly ribų. `internal` yra numatytoji C# reikšmė, tad tylėjimas
    // reiškia „ne", o ne „taip" — priešingai nei PHP, kur top-level deklaracija visada vieša.
    const exported = /\bpublic\b/.test(modifiers) || /\bprotected\b/.test(modifiers);
    const start = match.index ?? 0;

    // Savininkas nustatomas pagal KŪNŲ ribas: iškrenta visi, kurių kūnas jau baigėsi prieš šią
    // deklaraciją. Deklaracijos eina failo tvarka, tad vieno praėjimo pakanka.
    while (start > (owners[owners.length - 1]?.end ?? Number.POSITIVE_INFINITY)) owners.pop();
    const qualified = [...owners.map((owner) => owner.name), name].join(".");
    const end = bodyEnd(clean, start, declarations[position + 1]?.index ?? clean.length);
    owners.push({ name, end });

    // Kvalifikuotas vardas naudojamas IR ID, IR `exports` sąraše: `exports` briaunos rodo į
    // `failas#vardas`, tad plikas `Inner` prie ID `failas#Outer.Inner` duotų kabančią briauną.
    if (exported) exports.add(qualified);

    symbols.push({
      id: `${file.path}#${qualified}`,
      file: file.path,
      name: qualified,
      kind,
      exported,
      line: lineAt(offsets, start),
      endLine: lineAt(offsets, end),
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
