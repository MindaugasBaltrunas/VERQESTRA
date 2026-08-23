// AST-backed savo repo simbolių/importų skenavimas code-map generavimui. Behaviour etalon:
// AG_loop code-index/ast-symbol-scanner.ts; WBR VQ-301 parametrizacija: AG_loop šaknys
// (AG/orchestrator/src + ui-app/src) buvo hardcoded — čia šaknys yra įvestis, tad tas pats
// skeneris veikia ir VERQESTRA (src/ su sluoksniu pirmame segmente), ir AG-formos repo.
// Su AG_loop-ekvivalentiškomis šaknimis elgesys identiškas etalono.

import path from "node:path";
import type * as TypeScriptApi from "typescript";
import { toPosixPath } from "../../../shared/paths.js";
import { loadTypeScript } from "../indexing/ts-loader.js";
import type { CodeIntelligenceFileSystemPort } from "../ports.js";

export type SymbolRecordKind = "class" | "function" | "method" | "const" | "enum" | "interface" | "typeAlias";

export type SymbolRecord = {
  kind: SymbolRecordKind;
  name: string;
  filePath: string;
  layer: string;
};

/** A module-to-module import relationship: `fromFile` imports the raw `toModule` specifier as written. */
export type ImportEdge = {
  fromFile: string;
  fromLayer: string;
  toModule: string;
};

export type AstScanResult = {
  symbols: SymbolRecord[];
  imports: ImportEdge[];
};

/**
 * Viena skenavimo šaknis: `relativeDir` — repo-relative katalogas; `fixedLayer` — visos
 * šaknies failai gauna šį sluoksnį (etalono ui-app atvejis); be jo sluoksnis = pirmas kelio
 * segmentas po šaknies (`root`, kai failas guli tiesiai šaknyje).
 */
export type AstScanRoot = {
  relativeDir: string;
  fixedLayer?: string;
};

/** VERQESTRA numatytoji šaknis: `src/` su sluoksniu pirmame segmente. */
export const DEFAULT_AST_SCAN_ROOTS: AstScanRoot[] = [{ relativeDir: "src" }];

/**
 * AST-backed scan of every `.ts`/`.tsx` under the given roots. Real TypeScript AST
 * parsing, not regex extraction.
 */
export async function scanAstSymbols(
  fs: CodeIntelligenceFileSystemPort,
  projectRoot: string,
  roots: AstScanRoot[] = DEFAULT_AST_SCAN_ROOTS,
): Promise<AstScanResult> {
  // NUKRYPIMAS nuo etalono (griežtinantis, 2026-08-23): etalonas (ir šis failas iki šiol)
  // `typescript` importavo STATIŠKAI — vienintelis toks tarp code-intelligence modulių, nors
  // ts-loader design §6 taisyklė sako, kad devDependency statinis importas nužudytų KIEKVIENĄ
  // barrel'į paliečiančią komandą npm-instaliuotame target'e be `typescript`. Dabar — tas pats
  // lazy `loadTypeScript()` kaip ts-indexer; elgesys su įdiegtu typescript identiškas.
  const ts = await loadTypeScript();
  const symbols: SymbolRecord[] = [];
  const imports: ImportEdge[] = [];
  for (const root of roots) {
    const rootDir = path.join(projectRoot, ...root.relativeDir.split("/"));
    for (const absoluteFile of await collectSourceFiles(fs, rootDir)) {
      const relativePath = toPosixPath(path.relative(projectRoot, absoluteFile));
      const layer = layerForSourcePath(relativePath, root);
      const sourceText = await fs.readTextFile(absoluteFile);
      symbols.push(...extractSymbolRecords(ts, relativePath, sourceText, layer));
      imports.push(...extractImportEdges(ts, relativePath, sourceText, layer));
    }
  }
  symbols.sort((left, right) => left.filePath.localeCompare(right.filePath) || left.name.localeCompare(right.name));
  imports.sort((left, right) => left.fromFile.localeCompare(right.fromFile) || left.toModule.localeCompare(right.toModule));
  return { symbols, imports };
}

async function collectSourceFiles(fs: CodeIntelligenceFileSystemPort, dir: string): Promise<string[]> {
  const entries = await fs.listDirectory(dir);
  const files: string[] = [];
  for (const entry of entries) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory) {
      files.push(...(await collectSourceFiles(fs, absolute)));
      continue;
    }
    if (entry.isFile && isSourceFileName(entry.name)) {
      files.push(absolute);
    }
  }
  return files;
}

function isSourceFileName(name: string): boolean {
  if (name.endsWith(".d.ts")) return false;
  return name.endsWith(".ts") || name.endsWith(".tsx");
}

function scriptKindForPath(ts: typeof TypeScriptApi, filePath: string): TypeScriptApi.ScriptKind {
  return filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
}

/**
 * Layer = the path segment right after the scan root (or the root's `fixedLayer`);
 * `root`, kai failas guli tiesiai šaknyje; `unknown`, kai kelias šaknies neliečia.
 */
export function layerForSourcePath(filePath: string, root: AstScanRoot): string {
  if (root.fixedLayer !== undefined) return root.fixedLayer;
  const normalized = toPosixPath(filePath);
  const marker = `${toPosixPath(root.relativeDir).replace(/\/+$/, "")}/`;
  const markerIndex = normalized.indexOf(marker);
  if (markerIndex === -1) return "unknown";
  const rest = normalized.slice(markerIndex + marker.length);
  const slashIndex = rest.indexOf("/");
  return slashIndex === -1 ? "root" : rest.slice(0, slashIndex);
}

function hasExportModifier(ts: typeof TypeScriptApi, node: TypeScriptApi.Node): boolean {
  if (!ts.canHaveModifiers(node)) return false;
  return (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
}

function isConstDeclaration(ts: typeof TypeScriptApi, statement: TypeScriptApi.VariableStatement): boolean {
  return (statement.declarationList.flags & ts.NodeFlags.Const) !== 0;
}

export function extractSymbolRecords(
  ts: typeof TypeScriptApi,
  filePath: string,
  sourceText: string,
  layer: string,
): SymbolRecord[] {
  const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true, scriptKindForPath(ts, filePath));
  const records: SymbolRecord[] = [];

  for (const statement of sourceFile.statements) {
    if (ts.isClassDeclaration(statement) && statement.name && hasExportModifier(ts, statement)) {
      const className = statement.name.text;
      records.push({ kind: "class", name: className, filePath, layer });
      for (const member of statement.members) {
        if (ts.isMethodDeclaration(member) && ts.isIdentifier(member.name)) {
          records.push({ kind: "method", name: `${className}.${member.name.text}`, filePath, layer });
        }
      }
      continue;
    }

    if (ts.isFunctionDeclaration(statement) && statement.name && hasExportModifier(ts, statement)) {
      records.push({ kind: "function", name: statement.name.text, filePath, layer });
      continue;
    }

    if (ts.isVariableStatement(statement) && hasExportModifier(ts, statement) && isConstDeclaration(ts, statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) {
          records.push({ kind: "const", name: declaration.name.text, filePath, layer });
        }
      }
      continue;
    }

    if (ts.isEnumDeclaration(statement) && hasExportModifier(ts, statement)) {
      records.push({ kind: "enum", name: statement.name.text, filePath, layer });
      continue;
    }

    if (ts.isInterfaceDeclaration(statement) && hasExportModifier(ts, statement)) {
      records.push({ kind: "interface", name: statement.name.text, filePath, layer });
      continue;
    }

    if (ts.isTypeAliasDeclaration(statement) && hasExportModifier(ts, statement)) {
      records.push({ kind: "typeAlias", name: statement.name.text, filePath, layer });
    }
  }

  return records;
}

/** Extracts raw `import ... from "..."` and `export ... from "..."` module specifiers referenced by this file. */
export function extractImportEdges(
  ts: typeof TypeScriptApi,
  filePath: string,
  sourceText: string,
  layer: string,
): ImportEdge[] {
  const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true, scriptKindForPath(ts, filePath));
  const edges: ImportEdge[] = [];

  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      edges.push({ fromFile: filePath, fromLayer: layer, toModule: statement.moduleSpecifier.text });
      continue;
    }

    if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
      edges.push({ fromFile: filePath, fromLayer: layer, toModule: statement.moduleSpecifier.text });
    }
  }

  return edges;
}
