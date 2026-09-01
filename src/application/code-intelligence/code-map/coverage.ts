// Code-map aprėpties matavimas: AST simboliai prieš renderintą classDiagram. Behaviour
// etalon: AG_loop architecture/code-map-coverage.ts; rašymas — per portą.

import path from "node:path";
import { toPrettyJson } from "../../../shared/json.js";
import type { CodeIntelligenceFileSystemPort } from "../ports.js";
import type { ImportEdge, SymbolRecord } from "./index-projection.js";
import { classIdForFile, expectedImportEdges, memberLineForSymbol } from "./generator.js";

export const GENERATED_COVERAGE_RELATIVE_PATH = "vq/architecture/generated/code-map.coverage.json";

export type CodeMapCoverage = {
  source_files_total: number;
  source_files_indexed: number;
  symbols_total: number;
  symbols_rendered_in_mmd: number;
  edges_total: number;
  edges_rendered_in_mmd: number;
  missing_symbols: string[];
  coverage_percent: number;
};

/** Parses `class <id>["path"] { ... }` blocks out of generated classDiagram Mermaid text into class-id -> trimmed member line sets. */
function extractClassMemberLines(mermaid: string): Map<string, Set<string>> {
  const blocks = new Map<string, Set<string>>();
  const classHeader = /^\s*class\s+(\S+)\[/;
  let currentMembers: Set<string> | null = null;

  for (const line of mermaid.split(/\r?\n/)) {
    const header = classHeader.exec(line);
    if (header?.[1] !== undefined) {
      currentMembers = new Set();
      blocks.set(header[1], currentMembers);
      continue;
    }
    if (currentMembers && /^\s*\}\s*$/.test(line)) {
      currentMembers = null;
      continue;
    }
    if (currentMembers) {
      const trimmed = line.trim();
      if (trimmed.length > 0 && !trimmed.startsWith("<<")) {
        currentMembers.add(trimmed);
      }
    }
  }
  return blocks;
}

/** Parses `A --> B` relation lines out of classDiagram Mermaid text into `A-->B` keys. */
function extractEdgeKeys(mermaid: string): Set<string> {
  const keys = new Set<string>();
  const relation = /^\s*(\S+)\s+-->\s+(\S+)\s*$/;
  for (const line of mermaid.split(/\r?\n/)) {
    const match = relation.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) keys.add(`${match[1]}-->${match[2]}`);
  }
  return keys;
}

/**
 * Compares AST-scanned symbols against a rendered classDiagram Mermaid string.
 * A symbol counts as rendered only if its exact member line is present inside
 * its own file's class block (matched by `classIdForFile`), so a matching
 * member line under the wrong file's block does not count.
 *
 * `scannedFiles` — VISI nuskenuoti failai (2026-08-23, RAG auditas 3). Iki tol failų visuma buvo
 * išvedama iš simbolių, tad failas be eksportuotų deklaracijų į `source_files_total` nepatekdavo:
 * jis diagramoje neturėdavo mazgo, o aprėptis vis tiek skelbdavo 100 %. Aprėptis, kurios vardiklis
 * priklauso nuo to paties, ką ji matuoja, negali parodyti trūkumo.
 *
 * Todėl `coverage_percent` dabar skaičiuojamas nuo simbolių IR failų kartu: neatvaizduotas failas
 * kainuoja lygiai tiek pat, kiek neatvaizduotas simbolis.
 *
 * `imports` — TA PATI 2026-08-23 pamokos klasė, uždaryta 2026-09-01 (operatoriaus reprodukcija):
 * briaunų aprėptis apskritai neegzistavo, tad pašalinus VISAS `-->` eilutes iš diagramos aprėptis
 * likdavo 100 % ir `--check` grąžindavo sėkmę. Laukiamos briaunos dabar išvedamos generatoriaus
 * `expectedImportEdges` funkcija — ta pačia, kuri jas ir renderina, ne jos kopija.
 *
 * `scannedFiles` ir `imports` yra PRIVALOMI: numatytoji tuščia reikšmė būtų lygiai tas pats tylus
 * vardiklio susitraukimas, kurio šis matavimas ieško.
 */
export function computeCodeMapCoverage(
  symbols: SymbolRecord[],
  mermaidContent: string,
  scannedFiles: readonly string[],
  imports: readonly ImportEdge[],
): CodeMapCoverage {
  const classBlocks = extractClassMemberLines(mermaidContent);
  const sourceFiles = new Set([...scannedFiles, ...symbols.map((symbol) => symbol.filePath)]);
  const missingSymbols: string[] = [];
  let renderedCount = 0;

  for (const symbol of symbols) {
    const classId = classIdForFile(symbol.filePath);
    const expectedLine = memberLineForSymbol(symbol).trim();
    if (classBlocks.get(classId)?.has(expectedLine)) {
      renderedCount++;
    } else {
      missingSymbols.push(`${symbol.filePath}#${symbol.name}`);
    }
  }

  // Failas laikomas aprašytu, kai diagramoje YRA jo blokas — nesvarbu, ar jis turi narių. Anksčiau
  // tai buvo išvedama iš atvaizduotų simbolių, tad tuščias blokas neegzistavo net kaip klausimas.
  const indexedFiles = [...sourceFiles].filter((filePath) => classBlocks.has(classIdForFile(filePath)));
  for (const filePath of sourceFiles) {
    if (!classBlocks.has(classIdForFile(filePath))) missingSymbols.push(`${filePath}#<file>`);
  }

  // Briaunų aibė — generatoriaus, ne vietinė: `sourceFiles` čia yra lygiai tas pats `knownFiles`,
  // kurį renderiui sudeda `groupSymbolsByFile` (nuskenuoti failai + simbolių failai).
  const expectedEdges = expectedImportEdges(imports, sourceFiles);
  const renderedEdgeKeys = extractEdgeKeys(mermaidContent);
  let renderedEdgeCount = 0;
  for (const edge of expectedEdges) {
    if (renderedEdgeKeys.has(edge.key)) {
      renderedEdgeCount++;
      continue;
    }
    missingSymbols.push(`${edge.fromFile}-->${edge.toTarget}`);
  }

  const symbolsTotal = symbols.length;
  const measured = symbolsTotal + sourceFiles.size + expectedEdges.length;
  const rendered = renderedCount + indexedFiles.length + renderedEdgeCount;
  const coveragePercent = measured === 0 ? 100 : Math.round((rendered / measured) * 10000) / 100;

  return {
    source_files_total: sourceFiles.size,
    source_files_indexed: indexedFiles.length,
    symbols_total: symbolsTotal,
    symbols_rendered_in_mmd: renderedCount,
    edges_total: expectedEdges.length,
    edges_rendered_in_mmd: renderedEdgeCount,
    missing_symbols: missingSymbols,
    coverage_percent: coveragePercent,
  };
}

/** Writes the coverage report to {@link GENERATED_COVERAGE_RELATIVE_PATH}. */
export async function writeCodeMapCoverage(
  fs: CodeIntelligenceFileSystemPort,
  projectRoot: string,
  coverage: CodeMapCoverage,
): Promise<string> {
  const outputPath = path.join(projectRoot, ...GENERATED_COVERAGE_RELATIVE_PATH.split("/"));
  await fs.makeDirectory(path.dirname(outputPath));
  await fs.writeTextFileAtomic(outputPath, toPrettyJson(coverage));
  return outputPath;
}
