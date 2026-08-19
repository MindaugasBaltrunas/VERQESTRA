// Code-index vertybiniai tipai ir versija. Behaviour etalon: AG_loop code-index/types.ts.
//
// 2.0.0 (task 1105b): AST-backed indexer — symbols gained line/endLine, edges gained
// reExports/references. The major bump is load-bearing: the store compares this against
// the on-disk manifest BEFORE the source-hash check, so a v1 regex-built index with an
// identical source_hash is forced through one rebuild instead of silently serving an
// index without line ranges.
//
// 2.1.0 (task 0022): TypeScript symbols gained a compact `signature`. The comparison in
// the store is exact inequality, not semver-range, so this additive minor bump forces the
// same single rebuild — a 2.0.0 index with a matching source_hash can never be served as
// if it carried signatures.
export const codeIndexVersion = "2.1.0";

export type CodeIndexLanguage =
  | "typescript"
  | "javascript"
  | "python"
  | "php"
  | "csharp"
  | "dotnet"
  | "json"
  | "markdown"
  | "text";

export type CodeIndexFileKind = "source" | "test" | "config" | "doc";

export type CodeIndexEdgeType =
  | "imports"
  | "exports"
  | "declares"
  | "testedBy"
  | "allowedByTask"
  | "relatedToSpec"
  | "reExports"
  | "references";

export type CodeIndexFile = {
  path: string;
  hash: string;
  size: number;
  language: CodeIndexLanguage;
  kind: CodeIndexFileKind;
  imports: string[];
  exports: string[];
  symbols: string[];
  isTest: boolean;
};

export type CodeIndexSymbolKind = "function" | "class" | "type" | "interface" | "const" | "enum";

export type CodeIndexSymbol = {
  id: string;
  file: string;
  name: string;
  kind: CodeIndexSymbolKind;
  exported: boolean;
  /** 1-based first line of the declaration, inclusive. Present for AST-indexed TypeScript symbols. */
  line?: number;
  /** 1-based last line of the declaration, inclusive. Always >= line when present. */
  endLine?: number;
  /**
   * Compact, whitespace-normalized declaration head — the signature a reader needs to use
   * the symbol without opening the file (`export function foo(a: string): void`). Derived
   * syntactically from the same AST that produced the line range (no TypeChecker), and
   * length-capped, so it is a REPRESENTATION of the declaration, not its source. The exact
   * source stays on disk and is read on demand from `line`/`endLine`; the index never
   * stores file contents. Present for AST-indexed TypeScript symbols.
   */
  signature?: string;
};

export type CodeIndexEdge = {
  from: string;
  to: string;
  type: CodeIndexEdgeType;
  detail?: string;
};

export type CodeIndexManifest = {
  version: string;
  generated_at: string;
  project_root: string;
  file_count: number;
  symbol_count: number;
  edge_count: number;
  source_hash: string;
};

export type CodeIndexData = {
  manifest: CodeIndexManifest;
  files: CodeIndexFile[];
  symbols: CodeIndexSymbol[];
  edges: CodeIndexEdge[];
};

export type CodeIndexFreshness =
  | { ok: true; manifest: CodeIndexManifest }
  | { ok: false; reason: string; manifest?: CodeIndexManifest };
