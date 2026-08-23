// Code graph užklausos ir semantinis simbolių parinkimas kontekstui. Behaviour etalon:
// AG_loop code-index/query.ts (1:1; store skaitymo wrapper'is — per portą).

import { toComparablePosixPath } from "../../../shared/paths.js";
import type { CodeIntelligenceFileSystemPort } from "../ports.js";
import { readCodeIndex } from "../store/code-index-store.js";
import type { CodeIndexData, CodeIndexFile, CodeIndexSymbol } from "../indexing/types.js";

export type CodeGraphQueryOptions = {
  fuzzy?: boolean;
};

export type CodeGraphQueryResult = {
  target: string;
  matched_files: CodeIndexFile[];
  matched_symbols: CodeIndexSymbol[];
  imports: string[];
  importers: string[];
  exported_symbols: string[];
  related_files: string[];
  impacted_tests: string[];
};

export async function queryCodeGraph(
  fs: CodeIntelligenceFileSystemPort,
  projectRoot: string,
  target: string,
  options: CodeGraphQueryOptions = {},
): Promise<CodeGraphQueryResult> {
  return queryCodeGraphData(await readCodeIndex(fs, projectRoot), target, options);
}

export function queryCodeGraphData(
  data: CodeIndexData,
  target: string,
  options: CodeGraphQueryOptions = {},
): CodeGraphQueryResult {
  const normalizedTarget = toComparablePosixPath(target);
  const matchedFiles = data.files.filter((file) => matchesFile(file, normalizedTarget, Boolean(options.fuzzy)));
  const matchedSymbols = data.symbols.filter((symbol) => matchesSymbol(symbol, normalizedTarget, Boolean(options.fuzzy)));
  const targetFiles = new Set([...matchedFiles.map((file) => file.path), ...matchedSymbols.map((symbol) => symbol.file)]);
  const imports = relatedTargets(data, targetFiles, "imports", "out");
  const importers = relatedTargets(data, targetFiles, "imports", "in");
  // Be plėtinių filtro (2026-08-23, operatoriaus radinys). Iki tol čia buvo
  // `.filter(f => f.endsWith(".ts") || f.endsWith(".tsx"))` — likutis iš laiko, kai indeksas
  // pažinojo tik TypeScript'ą. Po daugiakalbio praplėtimo jis tyliai išmesdavo KIEKVIENĄ Python,
  // PHP, C# ir net JavaScript testą: `testedBy` briauna egzistuodavo, o `impacted_tests` grįždavo
  // tuščias. Filtro nereikia iš principo — briaunos tipas jau sako, kad taikinys yra testas.
  const impactedTests = relatedTargets(data, targetFiles, "testedBy", "out");
  const exportedSymbols = Array.from(
    new Set(data.symbols.filter((symbol) => targetFiles.has(symbol.file) && symbol.exported).map((symbol) => symbol.id)),
  ).sort();
  const relatedFiles = Array.from(new Set([...targetFiles, ...imports, ...importers, ...impactedTests])).sort();
  return {
    target,
    matched_files: matchedFiles,
    matched_symbols: matchedSymbols,
    imports,
    importers,
    exported_symbols: exportedSymbols,
    related_files: relatedFiles,
    impacted_tests: impactedTests,
  };
}

function relatedTargets(
  data: CodeIndexData,
  targetFiles: Set<string>,
  type: "imports" | "testedBy",
  direction: "in" | "out",
): string[] {
  const values = data.edges
    .filter((edge) => edge.type === type)
    .flatMap((edge) => {
      if (direction === "out" && targetFiles.has(edge.from)) return [edge.to];
      if (direction === "in" && targetFiles.has(edge.to)) return [edge.from];
      return [];
    })
    .filter((value) => data.files.some((file) => file.path === value));
  return Array.from(new Set(values)).sort();
}

function matchesFile(file: CodeIndexFile, target: string, fuzzy: boolean): boolean {
  return file.path === target || file.path.endsWith(`/${target}`) || (fuzzy && file.path.includes(target));
}

function matchesSymbol(symbol: CodeIndexSymbol, target: string, fuzzy: boolean): boolean {
  return symbol.id === target || symbol.name === target || (fuzzy && symbol.id.toLowerCase().includes(target.toLowerCase()));
}
