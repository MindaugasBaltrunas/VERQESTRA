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

/**
 * PSR-4 prefiksas → katalogų PAIEŠKOS SEKA, kaip `composer.json` `autoload.psr-4`.
 *
 * Reikšmė yra sąrašas, o ne vienas katalogas (2026-08-23, operatoriaus radinys): standartas leidžia
 * masyvą, ir jis reiškia eilės tvarka tikrinamas vietas. Anksčiau buvo imamas tik pirmas, tad
 * `"App\\": ["src/", "app/"]` neišspręsdavo `app/Models/User.php`.
 */
export type Psr4Map = ReadonlyMap<string, readonly string[]>;

/**
 * `use` sakinys iki kabliataškio — VISAS, o ne pirmas vardas (2026-08-23, RAG auditas 3).
 *
 * Standartas leidžia tris formas, o senasis šablonas atpažindavo tik pirmąją:
 *   `use Vendor\One;`                    — vienas vardas;
 *   `use Vendor\One, Vendor\Two;`        — keli vardai (antrasis dingdavo);
 *   `use Vendor\Package\{One, Two};`     — grupinis (virsdavo `Vendor\Package\`, t. y. nesamu vardu).
 *
 * Kabliataškis yra tikra riba: `blankOutNoise` jau ištrynė komentarus ir literalus.
 */
const USE_STATEMENT = /^[ \t]*use[ \t]+([^;{]*(?:\{[^}]*\})?[^;]*);/gm;
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
    for (const target of expandUseTargets(match[1] ?? "")) {
      imports.add(resolvePsr4(target, psr4, knownPaths) ?? target);
    }
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
 * `use` sakinio kūnas → pilnai kvalifikuoti vardai.
 *
 * Nuimami `function`/`const` kvalifikatoriai ir `as Alias` (importas yra TAIKINYS, ne alias'as),
 * išskleidžiama grupinė forma `Prefix\{One, Two}` ir kableliais atskirtas sąrašas.
 */
function expandUseTargets(body: string): string[] {
  // `function`/`const` gali stovėti ir prieš grupę (`use function Vendor\{a, b};`), tad nuimamas
  // pirmiau, nei tikrinama grupinė forma.
  const normalized = body.trim().replace(/^(?:function|const)[ \t]+/, "");
  const group = /^([A-Za-z_\\][A-Za-z0-9_\\]*\\)\{([^}]*)\}$/.exec(normalized);
  const parts = group
    ? (group[2] ?? "").split(",").map((entry) => `${group[1] ?? ""}${entry.trim()}`)
    : normalized.split(",");
  return parts
    .map((entry) =>
      entry
        .trim()
        .replace(/^(?:function|const)[ \t]+/, "")
        .replace(/[ \t]+as[ \t]+[A-Za-z_][A-Za-z0-9_]*$/i, "")
        .replace(/^\\/, "")
        .trim(),
    )
    .filter((entry) => /^[A-Za-z_][A-Za-z0-9_\\]*$/.test(entry));
}

/**
 * `App\Models\User` → `app/Models/User.php`, kai `composer.json` sako `"App\\": "app/"`.
 *
 * Renkamas ILGIAUSIAS tinkantis prefiksas: PSR-4 leidžia įdėtus žemėlapius (`App\` ir
 * `App\Domain\`), ir trumpesnis nukreiptų į neteisingą katalogą.
 */
function resolvePsr4(target: string, psr4: Psr4Map, knownPaths: ReadonlySet<string>): string | undefined {
  let best: { prefix: string; dirs: readonly string[] } | undefined;
  for (const [prefix, dirs] of psr4) {
    const normalized = prefix.endsWith("\\") ? prefix : `${prefix}\\`;
    if (!target.startsWith(normalized)) continue;
    if (!best || normalized.length > best.prefix.length) best = { prefix: normalized, dirs };
  }
  if (!best) return undefined;

  const relative = target.slice(best.prefix.length).split("\\").join("/");
  // Katalogai tikrinami EILĖS TVARKA — būtent tai reiškia PSR-4 masyvas. Pirmas, kuriame failas
  // realiai yra, ir laimi; nesant nė viename, nuoroda lieka kvalifikuotu vardu.
  for (const dir of best.dirs) {
    const candidate = `${dir.replace(/\/$/, "")}/${relative}.php`;
    if (knownPaths.has(candidate)) return candidate;
  }
  return undefined;
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
