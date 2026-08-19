// Pilnas code-index build'as: scan → AST index → test briaunos → dedup → manifest → store.
// Behaviour etalon: AG_loop code-index/builder.ts; FS — per portą (WBR VQ-301).

import type { CodeIntelligenceFileSystemPort } from "../ports.js";
import { createManifest, writeCodeIndex } from "../store/code-index-store.js";
import { computeSourceHash, scanProjectFiles } from "./scanner.js";
import { indexTypeScriptFiles } from "./ts-indexer.js";
import type { CodeIndexData, CodeIndexEdge, CodeIndexFile, CodeIndexSymbol } from "./types.js";

export async function buildCodeIndex(
  fs: CodeIntelligenceFileSystemPort,
  projectRoot: string,
): Promise<CodeIndexData> {
  const scanned = await scanProjectFiles(fs, projectRoot);
  const files: CodeIndexFile[] = [];
  const symbols: CodeIndexSymbol[] = [];
  const edges: CodeIndexEdge[] = [];

  // One batch call (design §2): tsconfig discovery, config parsing and the module
  // resolution cache are built once per build, not once per file.
  const indexed = await indexTypeScriptFiles(fs, projectRoot, scanned);
  for (const file of scanned) {
    const result = indexed.get(file.path);
    if (!result) {
      files.push(file);
      continue;
    }
    files.push(result.file);
    symbols.push(...result.symbols);
    edges.push(...result.edges);
  }

  edges.push(...deriveTestEdges(files));
  const unique = uniqueEdges(edges);
  const sourceHash = await computeSourceHash(scanned);
  const data: CodeIndexData = {
    manifest: createManifest(projectRoot, files, symbols, unique, sourceHash),
    files: files.sort((left, right) => left.path.localeCompare(right.path)),
    symbols: symbols.sort((left, right) => left.id.localeCompare(right.id)),
    edges: unique,
  };
  await writeCodeIndex(fs, projectRoot, data);
  return data;
}

function deriveTestEdges(files: CodeIndexFile[]): CodeIndexEdge[] {
  const sourceFiles = files.filter((file) => !file.isTest && file.language === "typescript");
  const testFiles = files.filter((file) => file.isTest);
  const edges: CodeIndexEdge[] = [];
  for (const testFile of testFiles) {
    for (const imported of testFile.imports) {
      if (sourceFiles.some((sourceFile) => sourceFile.path === imported)) {
        edges.push({ from: imported, to: testFile.path, type: "testedBy" });
      }
    }

    const normalizedTest = testFile.path.toLowerCase();
    for (const sourceFile of sourceFiles) {
      const sourceBase = sourceFile.path.split("/").pop()?.replace(/\.[^.]+$/, "").toLowerCase() ?? "";
      if (sourceBase && normalizedTest.includes(sourceBase)) {
        edges.push({ from: sourceFile.path, to: testFile.path, type: "testedBy", detail: "name-match" });
      }
    }
  }
  return edges;
}

function uniqueEdges(edges: CodeIndexEdge[]): CodeIndexEdge[] {
  const byKey = new Map<string, CodeIndexEdge>();
  for (const edge of edges) {
    byKey.set([edge.type, edge.from, edge.to, edge.detail ?? ""].join("|"), edge);
  }
  // `detail` is part of the sort key (design §2): reExports edges can differ only in
  // detail, and relying on sort stability + Map insertion order would make edge order
  // depend on collection order instead of content.
  return Array.from(byKey.values()).sort((left, right) =>
    `${left.type}:${left.from}:${left.to}:${left.detail ?? ""}`.localeCompare(
      `${right.type}:${right.from}:${right.to}:${right.detail ?? ""}`,
    ),
  );
}
