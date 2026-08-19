// Mermaid classDiagram code-map generavimas iš AST skenavimo. Behaviour etalon: AG_loop
// architecture/code-map-generator.ts; rašymas — per portą, output kelias — VERQESTRA
// architektūros artefaktų katalogas.

import path from "node:path";
import { toPosixPath } from "../../../shared/paths.js";
import type { CodeIntelligenceFileSystemPort } from "../ports.js";
import type { ImportEdge, SymbolRecord } from "./ast-symbol-scanner.js";

export const GENERATED_CODE_MAP_RELATIVE_PATH = "vq/architecture/generated/code-map.generated.mmd";

const GENERATED_HEADER = [
  "%% code-map.generated.mmd",
  "%% AST-backed full code-map, generated from SymbolRecord[]/ImportEdge[]",
  "%% (application/code-intelligence/code-map/ast-symbol-scanner.ts). Do not hand-edit;",
  "%% regenerate via the code-map generator (application/code-intelligence/code-map/generator.ts).",
].join("\n");

/** Deterministic Mermaid classDiagram class id for a source file path. */
export function classIdForFile(filePath: string): string {
  const withoutExtension = toPosixPath(filePath).replace(/\.(tsx?|jsx?)$/, "");
  const sanitized = withoutExtension.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return sanitized.length > 0 ? sanitized : "_";
}

export function memberLineForSymbol(record: SymbolRecord): string {
  switch (record.kind) {
    case "class":
      return `    +class ${record.name}`;
    case "interface":
      return `    +interface ${record.name}`;
    case "enum":
      return `    +enum ${record.name}`;
    case "typeAlias":
      return `    +type ${record.name}`;
    case "const":
      return `    +${record.name}`;
    case "function":
    case "method":
      return `    +${record.name}()`;
  }
}

type FileBlock = {
  filePath: string;
  layer: string;
  records: SymbolRecord[];
};

function groupSymbolsByFile(symbols: SymbolRecord[]): FileBlock[] {
  const byFile = new Map<string, FileBlock>();
  for (const record of symbols) {
    const existing = byFile.get(record.filePath);
    if (existing) {
      existing.records.push(record);
      continue;
    }
    byFile.set(record.filePath, { filePath: record.filePath, layer: record.layer, records: [record] });
  }
  return [...byFile.values()].sort(
    (left, right) => left.layer.localeCompare(right.layer) || left.filePath.localeCompare(right.filePath),
  );
}

function groupFilesByLayer(files: FileBlock[]): Map<string, FileBlock[]> {
  const byLayer = new Map<string, FileBlock[]>();
  for (const file of files) {
    const bucket = byLayer.get(file.layer);
    if (bucket) {
      bucket.push(file);
      continue;
    }
    byLayer.set(file.layer, [file]);
  }
  return byLayer;
}

function renderFileBlock(file: FileBlock): string[] {
  const classId = classIdForFile(file.filePath);
  const lines = [`    class ${classId}["${file.filePath}"] {`, `      <<${file.layer}>>`];
  for (const record of file.records) {
    lines.push(memberLineForSymbol(record));
  }
  lines.push("    }");
  return lines;
}

/**
 * Resolves a relative import specifier against the file it was written in to a
 * known source file path. Returns `null` for non-relative specifiers (bare
 * package names, path-mapped aliases) and for relative specifiers that don't
 * match any file in `knownFiles` — both cases fall outside what can be safely
 * resolved without a full module resolver / tsconfig paths.
 */
export function resolveImportTarget(
  fromFile: string,
  toModule: string,
  knownFiles: ReadonlySet<string>,
): string | null {
  if (!toModule.startsWith(".")) return null;
  const fromDir = path.posix.dirname(toPosixPath(fromFile));
  const resolvedBase = toPosixPath(path.posix.normalize(path.posix.join(fromDir, toModule))).replace(/\.(tsx?|jsx?)$/, "");
  const candidates = [
    `${resolvedBase}.ts`,
    `${resolvedBase}.tsx`,
    `${resolvedBase}/index.ts`,
    `${resolvedBase}/index.tsx`,
  ];
  for (const candidate of candidates) {
    if (knownFiles.has(candidate)) return candidate;
  }
  return null;
}

function renderImportEdges(imports: ImportEdge[], knownFiles: ReadonlySet<string>): string[] {
  const edgeKeys = new Set<string>();
  const edges: string[] = [];
  for (const edge of imports) {
    const target = resolveImportTarget(edge.fromFile, edge.toModule, knownFiles);
    if (!target || target === edge.fromFile) continue;
    const fromId = classIdForFile(edge.fromFile);
    const toId = classIdForFile(target);
    const key = `${fromId}-->${toId}`;
    if (edgeKeys.has(key)) continue;
    edgeKeys.add(key);
    edges.push(key);
  }
  edges.sort();
  return edges.map((key) => `  ${key.replace("-->", " --> ")}`);
}

/** Pure Mermaid `classDiagram` generation from AST-scanned symbols/imports; no filesystem access. */
export function generateCodeMapMermaid(symbols: SymbolRecord[], imports: ImportEdge[]): string {
  const files = groupSymbolsByFile(symbols);
  const knownFiles = new Set(files.map((file) => file.filePath));
  const byLayer = groupFilesByLayer(files);
  const layers = [...byLayer.keys()].sort();

  const sections: string[] = [];
  for (const layer of layers) {
    sections.push(`  %% --- layer: ${layer} ---`);
    for (const file of byLayer.get(layer) ?? []) {
      sections.push(...renderFileBlock(file).map((line) => `  ${line}`));
    }
  }

  const edgeLines = renderImportEdges(imports, knownFiles);

  return [
    GENERATED_HEADER,
    "",
    "classDiagram",
    "  direction LR",
    "",
    ...sections,
    ...(edgeLines.length > 0 ? ["", ...edgeLines] : []),
    "",
  ].join("\n");
}

/** Generates the Mermaid code-map and writes it to {@link GENERATED_CODE_MAP_RELATIVE_PATH}. */
export async function writeGeneratedCodeMap(
  fs: CodeIntelligenceFileSystemPort,
  projectRoot: string,
  symbols: SymbolRecord[],
  imports: ImportEdge[],
): Promise<string> {
  const mermaid = generateCodeMapMermaid(symbols, imports);
  const outputPath = path.join(projectRoot, ...GENERATED_CODE_MAP_RELATIVE_PATH.split("/"));
  await fs.makeDirectory(path.dirname(outputPath));
  await fs.writeTextFileAtomic(outputPath, mermaid);
  return outputPath;
}
