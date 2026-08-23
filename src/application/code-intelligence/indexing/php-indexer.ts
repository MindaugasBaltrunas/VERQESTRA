// PHP code-index ištraukėjas: importai ir simboliai.
//
// Veikia su bet kuriuo framework'u (Laravel, Symfony, WordPress, Slim…), nes remiasi kalbos
// konstrukcijomis: `namespace`, `use`, `class`/`interface`/`trait`/`enum`/`function`/`const` ir
// `require`/`include`. Framework'o specifika PHP'e gyvena autoload'e, ne sintaksėje.
//
// `use App\Models\User;` verčiamas į repo kelią per composer.json PSR-4 žemėlapį, kai jis paduotas —
// būtent taip veikia Laravel ir Symfony. Be žemėlapio nuoroda lieka pilnai kvalifikuotu vardu:
// spėti kelią iš namespace formos reikštų išgalvoti briauną.

import { blankOutNoise, C_LIKE_QUOTES, lineAt, lineIndex } from "./lexical.js";
import type { CodeIndexFile, CodeIndexSymbol, CodeIndexSymbolKind } from "./types.js";
import type { LanguageIndexResult } from "./language-indexer-model.js";

/** PSR-4 prefiksas → katalogas, kaip `composer.json` `autoload.psr-4`. */
export type Psr4Map = ReadonlyMap<string, string>;

const USE_STATEMENT = /^[ \t]*use[ \t]+(function[ \t]+|const[ \t]+)?([A-Za-z_\\][A-Za-z0-9_\\]*)/gm;
const REQUIRE_STATEMENT = /\b(?:require|require_once|include|include_once)\b/g;
const DECLARATION = /^[ \t]*(?:(abstract|final)[ \t]+)?(class|interface|trait|enum|function)[ \t]+([A-Za-z_][A-Za-z0-9_]*)/gm;
const CONST_DECLARATION = /^[ \t]*const[ \t]+([A-Za-z_][A-Za-z0-9_]*)/gm;

const KIND_BY_KEYWORD: Record<string, CodeIndexSymbolKind> = {
  class: "class",
  interface: "interface",
  trait: "class",
  enum: "enum",
  function: "function",
};

export function indexPhpSource(
  file: CodeIndexFile,
  text: string,
  knownPaths: ReadonlySet<string>,
  psr4: Psr4Map = new Map(),
): LanguageIndexResult {
  const clean = blankOutNoise(text, "c", C_LIKE_QUOTES);
  const offsets = lineIndex(clean);
  const imports = new Set<string>();

  for (const match of clean.matchAll(USE_STATEMENT)) {
    const target = (match[2] ?? "").replace(/^\\/, "");
    if (!target) continue;
    imports.add(resolvePsr4(target, psr4, knownPaths) ?? target);
  }

  // `require`/`include` argumentas beveik visada yra išraiška (`__DIR__ . '/x.php'`), o eilučių
  // literalai jau ištrinti. Fiksuojame FAKTĄ, kad failas naudoja tiesioginį įtraukimą — tai
  // reikšminga architektūros ribų patikrai, — bet taikinio neišgalvojame.
  const requires = [...clean.matchAll(REQUIRE_STATEMENT)].length;
  if (requires > 0) imports.add("php:runtime-include");

  const symbols: CodeIndexSymbol[] = [];
  const exports = new Set<string>();

  const push = (name: string, kind: CodeIndexSymbolKind, start: number, end: number): void => {
    // PHP neturi `export`: kiekviena top-level deklaracija matoma globaliai (per namespace), tad
    // `exported` čia reiškia „pasiekiama iš išorės", o ne „pažymėta raktažodžiu".
    //
    // `exports` laikomi PLIKI vardai, o ne kvalifikuoti namespace'u (2026-08-23): iš jų statomos
    // `exports` briaunos į `failas#vardas`, ir kvalifikuotas vardas rodytų į nesamą simbolio ID.
    // Namespace lieka matomas per patį failą, o vardų konvencija — viena visoms kalboms.
    exports.add(name);
    symbols.push({
      id: `${file.path}#${name}`,
      file: file.path,
      name,
      kind,
      exported: true,
      line: lineAt(offsets, start),
      endLine: lineAt(offsets, end),
    });
  };

  const declarations = [...clean.matchAll(DECLARATION)];
  for (const [position, match] of declarations.entries()) {
    const keyword = match[2] ?? "";
    const name = match[3] ?? "";
    const kind = KIND_BY_KEYWORD[keyword];
    if (!kind || !name) continue;
    const start = match.index ?? 0;
    push(name, kind, start, bodyEnd(clean, start, declarations[position + 1]?.index ?? clean.length));
  }

  for (const match of clean.matchAll(CONST_DECLARATION)) {
    const name = match[1] ?? "";
    const start = match.index ?? 0;
    if (name) push(name, "const", start, start);
  }

  return {
    file: { ...file, imports: [...imports].sort(), exports: [...exports].sort(), symbols: symbols.map((s) => s.name).sort() },
    symbols,
    edges: [],
  };
}

/**
 * `App\Models\User` → `app/Models/User.php`, kai `composer.json` sako `"App\\": "app/"`.
 *
 * Renkamas ILGIAUSIAS tinkantis prefiksas: PSR-4 leidžia įdėtus žemėlapius (`App\` ir
 * `App\Domain\`), ir trumpesnis nukreiptų į neteisingą katalogą.
 */
function resolvePsr4(target: string, psr4: Psr4Map, knownPaths: ReadonlySet<string>): string | undefined {
  let best: { prefix: string; dir: string } | undefined;
  for (const [prefix, dir] of psr4) {
    const normalized = prefix.endsWith("\\") ? prefix : `${prefix}\\`;
    if (!target.startsWith(normalized)) continue;
    if (!best || normalized.length > best.prefix.length) best = { prefix: normalized, dir };
  }
  if (!best) return undefined;

  const relative = target.slice(best.prefix.length).split("\\").join("/");
  const base = `${best.dir.replace(/\/$/, "")}/${relative}`;
  return knownPaths.has(`${base}.php`) ? `${base}.php` : undefined;
}

/** Deklaracijos pabaiga: suderintas `}` arba kito deklaracijos pradžia, jei skliaustai nesueina. */
function bodyEnd(text: string, start: number, limit: number): number {
  const open = text.indexOf("{", start);
  if (open === -1 || open > limit) return start;
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
