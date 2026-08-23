// Kalbų registras code-index'ui. Behaviour etalon: AG_loop code-index/language-capabilities.ts.
import type { CodeIndexLanguage } from "./types.js";

export type CodeIndexLanguageSupportStatus = "active" | "scanned" | "planned";

export type CodeIndexLanguageCapability = {
  language: CodeIndexLanguage;
  status: CodeIndexLanguageSupportStatus;
  extensions: string[];
  parser: string;
  extracts_files: boolean;
  extracts_imports: boolean;
  extracts_symbols: boolean;
  extracts_tests: boolean;
  priority: number;
};

export const codeIndexLanguageCapabilities: CodeIndexLanguageCapability[] = [
  {
    language: "typescript",
    status: "active",
    extensions: [".ts", ".tsx", ".mts", ".cts"],
    parser: "regex-ts-indexer",
    extracts_files: true,
    extracts_imports: true,
    extracts_symbols: true,
    extracts_tests: true,
    priority: 1,
  },
  {
    // JavaScript eina per TĄ PATĮ `ts.createSourceFile` AST kaip TypeScript (`allowJs`); antro JS
    // parserio nėra. Palaikomos ABI modulių sistemos: ESM `import`/`export` atpažįstamos iš mazgo
    // tipo, o CommonJS `require()` / `module.exports` — per `ts-commonjs`, nes tai kvietimas ir
    // priskyrimas, o ne deklaracijos (2026-08-23: iki tol `.cjs` grąžindavo tuščius sąrašus, nors
    // lentelė jau skelbė pilną palaikymą).
    language: "javascript",
    status: "active",
    extensions: [".js", ".jsx", ".mjs", ".cjs"],
    parser: "ts-ast-indexer",
    extracts_files: true,
    extracts_imports: true,
    extracts_symbols: true,
    extracts_tests: true,
    priority: 1,
  },
  {
    language: "python",
    status: "active",
    extensions: [".py"],
    parser: "lexical-python",
    extracts_files: true,
    extracts_imports: true,
    extracts_symbols: true,
    extracts_tests: true,
    priority: 2,
  },
  {
    language: "php",
    status: "active",
    extensions: [".php"],
    parser: "lexical-php-psr4",
    extracts_files: true,
    extracts_imports: true,
    extracts_symbols: true,
    extracts_tests: true,
    priority: 3,
  },
  {
    language: "csharp",
    status: "active",
    extensions: [".cs"],
    parser: "lexical-csharp",
    extracts_files: true,
    extracts_imports: true,
    extracts_symbols: true,
    extracts_tests: true,
    priority: 4,
  },
  {
    language: "dotnet",
    status: "active",
    extensions: [".csproj", ".sln", ".props", ".targets"],
    parser: "msbuild-project-graph",
    extracts_files: true,
    extracts_imports: true,
    extracts_symbols: true,
    extracts_tests: false,
    priority: 4,
  },
  {
    language: "json",
    status: "active",
    extensions: [".json"],
    parser: "json-config-scan",
    extracts_files: true,
    extracts_imports: false,
    extracts_symbols: false,
    extracts_tests: false,
    priority: 5,
  },
];

export function languageForExtension(extension: string): CodeIndexLanguage {
  const normalized = extension.toLowerCase();
  return (
    codeIndexLanguageCapabilities.find((capability) => capability.extensions.includes(normalized))?.language ?? "text"
  );
}

export function indexedCodeExtensions(): Set<string> {
  return new Set(codeIndexLanguageCapabilities.flatMap((capability) => capability.extensions));
}

/*
 * `sourceHashLanguages()` PAŠALINTA 2026-08-23 (operatoriaus radinys).
 *
 * Ji atrinkdavo kalbas, patenkančias į `source_hash`, ir sąmoningai išmesdavo JSON. Pasekmė:
 * `data.json` turinio pakeitimas indekso nepasendindavo, nors tas failas indekse YRA ir neša savo
 * `hash` — indeksas laikydavo nebegaliojantį atspaudą ir vis tiek vadindavosi šviežiu.
 *
 * Taisyklė dabar viena ir be išimčių: kas patenka į indeksą, tas patenka ir į jo atspaudą
 * (`scanner.isSourceHashFile`). Atrankos pagal kalbą nebereikia, tad funkcija nebeegzistuoja — o ne
 * lieka su vieninteliu kvietėju „dėl visa ko".
 */
