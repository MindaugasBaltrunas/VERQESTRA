// Code-map aprėpties matavimas: AST simboliai prieš renderintą classDiagram. Behaviour
// etalon: AG_loop architecture/code-map-coverage.ts; rašymas — per portą.

import path from "node:path";
import { toPrettyJson } from "../../../shared/json.js";
import type { CodeIntelligenceFileSystemPort } from "../ports.js";
import type { SymbolRecord } from "./ast-symbol-scanner.js";
import { classIdForFile, memberLineForSymbol } from "./generator.js";

export const GENERATED_COVERAGE_RELATIVE_PATH = "vq/architecture/generated/code-map.coverage.json";

export type CodeMapCoverage = {
  source_files_total: number;
  source_files_indexed: number;
  symbols_total: number;
  symbols_rendered_in_mmd: number;
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

/**
 * Compares AST-scanned symbols against a rendered classDiagram Mermaid string.
 * A symbol counts as rendered only if its exact member line is present inside
 * its own file's class block (matched by `classIdForFile`), so a matching
 * member line under the wrong file's block does not count.
 */
export function computeCodeMapCoverage(symbols: SymbolRecord[], mermaidContent: string): CodeMapCoverage {
  const classBlocks = extractClassMemberLines(mermaidContent);
  const sourceFiles = new Set(symbols.map((symbol) => symbol.filePath));
  const indexedFiles = new Set<string>();
  const missingSymbols: string[] = [];
  let renderedCount = 0;

  for (const symbol of symbols) {
    const classId = classIdForFile(symbol.filePath);
    const expectedLine = memberLineForSymbol(symbol).trim();
    if (classBlocks.get(classId)?.has(expectedLine)) {
      renderedCount++;
      indexedFiles.add(symbol.filePath);
    } else {
      missingSymbols.push(`${symbol.filePath}#${symbol.name}`);
    }
  }

  const symbolsTotal = symbols.length;
  const coveragePercent = symbolsTotal === 0 ? 100 : Math.round((renderedCount / symbolsTotal) * 10000) / 100;

  return {
    source_files_total: sourceFiles.size,
    source_files_indexed: indexedFiles.size,
    symbols_total: symbolsTotal,
    symbols_rendered_in_mmd: renderedCount,
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
