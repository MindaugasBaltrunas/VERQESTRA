// Kalbų ištraukėjų dispečeris (2026-08-23): kiekvienam ne-ECMAScript failui parenka ištraukėją.
//
// TypeScript ir JavaScript čia NEPATENKA — jie eina per `ts-indexer` batch kelią, kuriam reikia
// tsconfig atradimo ir modulių rezoliucijos kešo, statomo VIENĄ kartą visam build'ui. Sulieti abu
// kelius reikštų arba per-file tsconfig paiešką, arba netikrą batch'ą leksinėms kalboms.
//
// PSR-4 žemėlapis paimamas iš projekto `composer.json` vieną kartą ir paduodamas kiekvienam PHP
// failui: skaitymas per failą būtų N skaitymų to paties nekintančio konfigo.

import { indexCSharpSource } from "./csharp-indexer.js";
import { indexDotnetProject } from "./dotnet-indexer.js";
import { indexPhpSource, type Psr4Map } from "./php-indexer.js";
import { indexPythonSource } from "./python-indexer.js";
import type { LanguageIndexResult } from "./language-indexer-model.js";
import type { CodeIndexEdge, CodeIndexFile, CodeIndexSymbol } from "./types.js";

export type LexicalIndexContext = {
  knownPaths: ReadonlySet<string>;
  psr4: Psr4Map;
};

/** Kalbos, kurias aptarnauja leksiniai ištraukėjai (t. y. VISOS, išskyrus ECMAScript šeimą). */
export function hasLexicalIndexer(file: CodeIndexFile): boolean {
  return file.language === "python" || file.language === "php" || file.language === "csharp" || file.language === "dotnet";
}

export function indexLexicalSource(file: CodeIndexFile, text: string, context: LexicalIndexContext): LanguageIndexResult | undefined {
  const extracted = extract(file, text, context);
  if (extracted === undefined) return undefined;
  const deduped = { ...extracted, symbols: uniqueSymbols(extracted.symbols) };
  return { ...deduped, edges: [...deduped.edges, ...graphEdges(deduped)] };
}

/**
 * Simbolio ID yra TAPATYBĖ, tad jis privalo būti unikalus faile (2026-08-23, operatoriaus radinys).
 *
 * Tinklas, o ne sprendimas: kai kalba tikrai turi įdėtas deklaracijas, teisingas atsakymas yra
 * KVALIFIKUOTI vardą savininku (taip padaryta C# `Outer.Inner`), o ne sulieti du skirtingus dalykus.
 * Bet dublikatas, prasprūdęs iki čia, yra blogesnis už suliejimą: dvi `declares` briaunos į tą patį
 * mazgą reiškia, kad indeksas pats nesilaiko savo tapatybės taisyklės. Todėl čia paliktas
 * paskutinis vartas, o testas tikrina jį visoms kalboms iš karto.
 */
function uniqueSymbols(symbols: readonly CodeIndexSymbol[]): CodeIndexSymbol[] {
  const byId = new Map<string, CodeIndexSymbol>();
  for (const symbol of symbols) {
    const existing = byId.get(symbol.id);
    if (existing === undefined) {
      byId.set(symbol.id, symbol);
      continue;
    }
    existing.exported = existing.exported || symbol.exported;
    if (symbol.line !== undefined) existing.line = Math.min(existing.line ?? symbol.line, symbol.line);
    if (symbol.endLine !== undefined) existing.endLine = Math.max(existing.endLine ?? symbol.endLine, symbol.endLine);
  }
  return [...byId.values()];
}

function extract(file: CodeIndexFile, text: string, context: LexicalIndexContext): LanguageIndexResult | undefined {
  switch (file.language) {
    case "python":
      return indexPythonSource(file, text, context.knownPaths);
    case "php":
      return indexPhpSource(file, text, context.knownPaths, context.psr4);
    case "csharp":
      return indexCSharpSource(file, text);
    case "dotnet":
      return indexDotnetProject(file, text, context.knownPaths);
    default:
      return undefined;
  }
}

/**
 * Grafo briaunos iš ištraukto failo (2026-08-23, operatoriaus radinys).
 *
 * Iki tol leksiniai ištraukėjai grąžindavo `edges: []`: `file.imports` ir simboliai būdavo
 * užpildyti, bet `code-graph` ir architektūros ribų vartas skaito BŪTENT `imports` briaunas
 * (`architecture-boundary`: `if (edge.type !== "imports") continue`). Todėl naujos kalbos indekse
 * matėsi, o grafe jų nebuvo — funkcionalumas veikė tik iš pusės.
 *
 * Briaunos statomos ČIA, o ne kiekviename ištraukėjuje, sąmoningai: žingsnis, kurį reikia prisiminti
 * keturiose vietose, anksčiau ar vėliau pamirštamas ketvirtoje — būtent taip ši spraga ir atsirado.
 * Forma 1:1 su `ts-source-indexer` (`imports` / `declares` su `detail: kind` / `exports`), nes
 * skaitytojai kalbos neskiria ir neturi skirti.
 */
function graphEdges(result: LanguageIndexResult): CodeIndexEdge[] {
  const { file, symbols } = result;
  return [
    ...file.imports.map((target) => ({ from: file.path, to: target, type: "imports" as const })),
    ...symbols.map((symbol) => ({ from: file.path, to: symbol.id, type: "declares" as const, detail: symbol.kind })),
    ...file.exports.map((name) => ({ from: file.path, to: `${file.path}#${name}`, type: "exports" as const })),
  ];
}

/**
 * `composer.json` → PSR-4 prefiksų žemėlapis.
 *
 * Skaitomas ir `autoload`, ir `autoload-dev`: testai Laravel/Symfony projektuose gyvena būtent
 * antrajame, o testų briaunos yra tokios pat tikros kaip produkcinės. Sugadintas JSON NĖRA klaida —
 * be žemėlapio PHP importai tiesiog lieka pilnai kvalifikuotais vardais.
 */
export function parseComposerPsr4(composerJson: string | undefined): Psr4Map {
  const map = new Map<string, readonly string[]>();
  if (composerJson === undefined) return map;

  let parsed: unknown;
  try {
    parsed = JSON.parse(composerJson);
  } catch {
    return map;
  }
  if (typeof parsed !== "object" || parsed === null) return map;

  const root = parsed as Record<string, unknown>;
  for (const section of ["autoload", "autoload-dev"]) {
    const block = root[section];
    if (typeof block !== "object" || block === null) continue;
    const psr4 = (block as Record<string, unknown>)["psr-4"];
    if (typeof psr4 !== "object" || psr4 === null) continue;
    for (const [prefix, target] of Object.entries(psr4 as Record<string, unknown>)) {
      // PSR-4 masyvas yra PAIEŠKOS SEKA, o ne pasirinkimas (2026-08-23, operatoriaus radinys):
      // `"App\\": ["src/", "app/"]` reiškia „ieškok `src/`, paskui `app/`". Anksčiau buvo imamas
      // tik pirmas, tad tikras failas antrajame kataloge likdavo neišspręstas.
      const directories = (Array.isArray(target) ? (target as unknown[]) : [target]).filter(
        (entry): entry is string => typeof entry === "string" && entry !== "",
      );
      if (directories.length > 0) map.set(prefix, directories);
    }
  }
  return map;
}
