// Vieno TypeScript failo AST indeksavimas: importai, eksportai, re-eksportai, simboliai su
// line range/signatūra, dynamic import'ai ir `references` briaunos. Behaviour etalon:
// AG_loop code-index/ts-indexer.ts (indexSourceText pusė; WBR VQ-301 skaidymas).

import path from "node:path";
import type * as TypeScriptApi from "typescript";
import type { CodeIndexEdge, CodeIndexFile, CodeIndexSymbol, CodeIndexSymbolKind } from "./types.js";
import { declarationSignature } from "./ts-signatures.js";
import { resolveSpecifier } from "./ts-resolve.js";
import { collectCommonJs } from "./ts-commonjs.js";

export type TypeScriptIndexResult = {
  file: CodeIndexFile;
  symbols: CodeIndexSymbol[];
  edges: CodeIndexEdge[];
};

/**
 * Simboliai pagal ID, sulieti į vieną (2026-08-23, operatoriaus radinys).
 *
 * `function over(a: string): void; function over(a: number): void; function over(a: unknown) {}`
 * yra TRYS deklaracijos ir VIENAS simbolis. Iki tol jos duodavo tris įrašus su identišku
 * `failas#over` ID ir tris `declares` briaunas į tą patį mazgą — indeksas skelbė, kad ID yra
 * tapatybė, ir pats jos nesilaikė.
 *
 * Suliejant imamas PLATESNIS eilučių intervalas: overload'o prasmė yra visa grupė, o ne
 * paskutinė jos eilutė. `exported` — bet kuri deklaracija; TypeScript'e `export` gali stovėti tik
 * prie vienos jų, ir tai eksportuoja visą grupę.
 */
function dedupeById(symbols: CodeIndexSymbol[]): CodeIndexSymbol[] {
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
    // Parašas imamas iš IMPLEMENTACIJOS — ji viena, o overload'ų yra keli, ir jų parašai skiriasi.
    if (symbol.signature !== undefined) existing.signature = symbol.signature;
  }
  return [...byId.values()];
}

/** Plėtinys → `ScriptKind`. JSX variantai atskiri: be jų `<div/>` parsinamas kaip tipo asercija. */
function scriptKindFor(ts: typeof TypeScriptApi, filePath: string): TypeScriptApi.ScriptKind {
  if (filePath.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (filePath.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (filePath.endsWith(".js") || filePath.endsWith(".mjs") || filePath.endsWith(".cjs")) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

export function indexSourceText(
  ts: typeof TypeScriptApi,
  projectRoot: string,
  file: CodeIndexFile,
  text: string,
  options: TypeScriptApi.CompilerOptions,
  cache: TypeScriptApi.ModuleResolutionCache,
  knownPaths: Set<string>,
): TypeScriptIndexResult {
  // ScriptKind pagal plėtinį, o ne konstanta (2026-08-23): tas pats indeksuotojas aptarnauja ir
  // JavaScript'ą — `ts.createSourceFile` `.js/.jsx/.mjs/.cjs` parsina natūraliai, o
  // `allowJs`/`NodeNext` rezoliucija jau įjungta `ts-indexer` opcijose. Rašyti antrą JS parserį
  // reikštų antrą tiesą tam pačiam klausimui.
  const scriptKind = scriptKindFor(ts, file.path);
  const absolute = path.join(projectRoot, file.path);
  const sourceFile = ts.createSourceFile(absolute, text, ts.ScriptTarget.Latest, false, scriptKind);

  const resolve = (specifier: string): { value: string; inRepo: boolean } =>
    resolveSpecifier(ts, projectRoot, file.path, specifier, options, cache, knownPaths);

  const imports = new Set<string>();
  const exportNames = new Set<string>();
  const symbols: CodeIndexSymbol[] = [];
  const extraEdges: CodeIndexEdge[] = [];
  const localExportClauseNames = new Set<string>();

  const lineOf = (pos: number): number => sourceFile.getLineAndCharacterOfPosition(pos).line + 1;
  const rangeOf = (node: TypeScriptApi.Node): { line: number; endLine: number } => ({
    line: lineOf(node.getStart(sourceFile)),
    endLine: lineOf(node.getEnd()),
  });

  const hasModifier = (node: TypeScriptApi.Node, kind: TypeScriptApi.SyntaxKind): boolean =>
    ts.canHaveModifiers(node) ? (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === kind) : false;

  const pushSymbol = (
    name: string,
    kind: CodeIndexSymbolKind,
    exported: boolean,
    node: TypeScriptApi.Node,
    // Only variable declarations need one: `export` and `const`/`let`/`var` live on the
    // enclosing statement, outside the node's own text range.
    signaturePrefix = "",
  ): void => {
    const signature = declarationSignature(ts, sourceFile, node, signaturePrefix);
    symbols.push({
      id: `${file.path}#${name}`,
      file: file.path,
      name,
      kind,
      exported,
      ...rangeOf(node),
      ...(signature === "" ? {} : { signature }),
    });
  };

  // Pass 1 — top-level statements: imports, exports, re-exports, declarations.
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      imports.add(resolve(statement.moduleSpecifier.text).value);
      continue;
    }
    if (ts.isImportEqualsDeclaration(statement) && ts.isExternalModuleReference(statement.moduleReference)) {
      const expression = statement.moduleReference.expression;
      if (ts.isStringLiteral(expression)) {
        imports.add(resolve(expression.text).value);
      }
      continue;
    }
    if (ts.isExportDeclaration(statement)) {
      collectExportDeclaration(ts, statement, file.path, resolve, imports, exportNames, extraEdges, localExportClauseNames);
      continue;
    }
    if (ts.isExportAssignment(statement)) {
      // `export default <expr>` and `export =` both record "default" (design §5).
      exportNames.add("default");
      continue;
    }
    collectDeclaration(ts, statement, hasModifier, pushSymbol, exportNames);
  }

  // Locally exported names (`export { a }`, `export { a as b }` without `from`) mark the
  // underlying declaration exported.
  const bySymbolName = new Map(symbols.map((symbol) => [symbol.name, symbol]));
  for (const localName of localExportClauseNames) {
    const symbol = bySymbolName.get(localName);
    if (symbol) {
      symbol.exported = true;
    }
  }

  // Pass 2 — full-tree walk: dynamic `import()` anywhere + `references` edges (design §5).
  const valueBindings = new Map<string, { target: string; original: string; inRepo: boolean }>();
  const namespaceBindings = new Map<string, { target: string; inRepo: boolean }>();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
      continue;
    }
    const resolved = resolve(statement.moduleSpecifier.text);
    const clause = statement.importClause;
    if (!clause) {
      continue;
    }
    if (clause.name) {
      valueBindings.set(clause.name.text, { target: resolved.value, original: "default", inRepo: resolved.inRepo });
    }
    if (clause.namedBindings) {
      if (ts.isNamespaceImport(clause.namedBindings)) {
        namespaceBindings.set(clause.namedBindings.name.text, { target: resolved.value, inRepo: resolved.inRepo });
      } else {
        for (const element of clause.namedBindings.elements) {
          valueBindings.set(element.name.text, {
            target: resolved.value,
            original: (element.propertyName ?? element.name).text,
            inRepo: resolved.inRepo,
          });
        }
      }
    }
  }

  const references = new Set<string>();
  const walk = (node: TypeScriptApi.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node) || ts.isImportEqualsDeclaration(node)) {
      return; // an import clause is not a reference to itself
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      node.arguments[0] !== undefined &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      // Dynamic `import("m")` with a literal argument (design §4); non-literal args are
      // a documented limitation and produce nothing.
      imports.add(resolve(node.arguments[0].text).value);
      return;
    }
    if (ts.isPropertyAccessExpression(node)) {
      if (ts.isIdentifier(node.expression)) {
        const namespace = namespaceBindings.get(node.expression.text);
        if (namespace) {
          if (namespace.inRepo) {
            references.add(`${namespace.target}#${node.name.text}`);
          }
          return;
        }
      }
      walk(node.expression); // never treat `.name` as an identifier reference
      return;
    }
    if (ts.isPropertyAssignment(node)) {
      if (ts.isComputedPropertyName(node.name)) {
        walk(node.name);
      }
      walk(node.initializer); // a non-computed property NAME is not a reference
      return;
    }
    if (ts.isShorthandPropertyAssignment(node)) {
      const binding = valueBindings.get(node.name.text);
      if (binding?.inRepo) {
        references.add(`${binding.target}#${binding.original}`); // `{ a }` reads `a`
      }
      return;
    }
    if (ts.isIdentifier(node)) {
      const binding = valueBindings.get(node.text);
      if (binding?.inRepo) {
        references.add(`${binding.target}#${binding.original}`);
      }
      return;
    }
    ts.forEachChild(node, walk);
  };
  ts.forEachChild(sourceFile, walk);

  for (const target of Array.from(references).sort()) {
    extraEdges.push({ from: file.path, to: target, type: "references" });
  }

  // CommonJS (2026-08-23, operatoriaus radinys). ESM `import`/`export` yra DEKLARACIJOS, tad
  // aukštesni praėjimai jas atpažįsta iš mazgo tipo; `require()` ir `module.exports =` yra
  // kvietimas ir priskyrimas, tad be šio žingsnio `.cjs` failai grąžindavo tuščius sąrašus.
  const commonJs = collectCommonJs(ts, sourceFile, resolve, lineOf);
  for (const target of commonJs.imports) imports.add(target);
  for (const name of commonJs.exports) exportNames.add(name);
  for (const found of commonJs.symbols) {
    // Simbolis kuriamas TIK jei tokio vardo dar nėra: `module.exports = { helper }` mini jau
    // deklaruotą funkciją, ir antra kopija duotų dvi `declares` briaunas tam pačiam ID.
    if (symbols.some((symbol) => symbol.name === found.name)) continue;
    symbols.push({
      id: `${file.path}#${found.name}`,
      file: file.path,
      name: found.name,
      kind: found.kind,
      exported: true,
      line: found.line,
      endLine: found.endLine,
    });
  }

  // Exported symbols contribute their names to the export list (parity with the
  // previous indexer's union behavior).
  for (const symbol of symbols) {
    if (symbol.exported) {
      exportNames.add(symbol.name);
    }
  }

  const sortedSymbols = dedupeById(symbols).sort((left, right) => left.id.localeCompare(right.id));
  const exportList = Array.from(exportNames).sort();
  const enrichedFile: CodeIndexFile = {
    ...file,
    imports: Array.from(imports).sort(),
    exports: exportList,
    symbols: Array.from(new Set(sortedSymbols.map((symbol) => symbol.name))).sort(),
  };
  const edges: CodeIndexEdge[] = [
    ...enrichedFile.imports.map((target) => ({ from: file.path, to: target, type: "imports" as const })),
    ...sortedSymbols.map((symbol) => ({ from: file.path, to: symbol.id, type: "declares" as const, detail: symbol.kind })),
    ...exportList.map((name) => ({ from: file.path, to: `${file.path}#${name}`, type: "exports" as const })),
    ...extraEdges,
  ];
  return { file: enrichedFile, symbols: sortedSymbols, edges };
}

function collectExportDeclaration(
  ts: typeof TypeScriptApi,
  statement: TypeScriptApi.ExportDeclaration,
  filePath: string,
  resolve: (specifier: string) => { value: string; inRepo: boolean },
  imports: Set<string>,
  exportNames: Set<string>,
  extraEdges: CodeIndexEdge[],
  localExportClauseNames: Set<string>,
): void {
  const specifier =
    statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier) ? statement.moduleSpecifier.text : undefined;

  if (specifier === undefined) {
    // `export { a }` / `export { a as b }` — local export clause.
    if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) {
        exportNames.add(element.name.text);
        localExportClauseNames.add((element.propertyName ?? element.name).text);
      }
    }
    return;
  }

  const resolved = resolve(specifier);
  // Mandatory `imports` edge on every re-export — keeps the architecture gate intact
  // (design §5 / risk R2).
  imports.add(resolved.value);

  if (!statement.exportClause) {
    // `export * from "m"` — no local name exists syntactically.
    extraEdges.push({ from: filePath, to: resolved.value, type: "reExports", detail: "star" });
    return;
  }
  if (ts.isNamespaceExport(statement.exportClause)) {
    // `export * as ns from "m"`.
    exportNames.add(statement.exportClause.name.text);
    extraEdges.push({ from: filePath, to: resolved.value, type: "reExports", detail: "star" });
    return;
  }
  for (const element of statement.exportClause.elements) {
    const exportedName = element.name.text;
    const originalName = (element.propertyName ?? element.name).text;
    exportNames.add(exportedName);
    extraEdges.push({
      from: `${filePath}#${exportedName}`,
      to: `${resolved.value}#${originalName}`,
      type: "reExports",
    });
  }
}

function collectDeclaration(
  ts: typeof TypeScriptApi,
  statement: TypeScriptApi.Statement,
  hasModifier: (node: TypeScriptApi.Node, kind: TypeScriptApi.SyntaxKind) => boolean,
  pushSymbol: (
    name: string,
    kind: CodeIndexSymbolKind,
    exported: boolean,
    node: TypeScriptApi.Node,
    signaturePrefix?: string,
  ) => void,
  exportNames: Set<string>,
): void {
  const exported = hasModifier(statement, ts.SyntaxKind.ExportKeyword);
  const isDefault = hasModifier(statement, ts.SyntaxKind.DefaultKeyword);
  if (exported && isDefault) {
    exportNames.add("default");
  }

  if (ts.isFunctionDeclaration(statement)) {
    pushSymbol(statement.name?.text ?? "default", "function", exported, statement);
    return;
  }
  if (ts.isClassDeclaration(statement)) {
    const className = statement.name?.text ?? "default";
    pushSymbol(className, "class", exported, statement);
    if (exported) {
      // `Class.method` naming matches the code-map AST scanner so the two scanners agree.
      for (const member of statement.members) {
        if (ts.isMethodDeclaration(member) && ts.isIdentifier(member.name)) {
          pushSymbol(`${className}.${member.name.text}`, "function", true, member);
        }
      }
    }
    return;
  }
  if (ts.isInterfaceDeclaration(statement)) {
    pushSymbol(statement.name.text, "interface", exported, statement);
    return;
  }
  if (ts.isTypeAliasDeclaration(statement)) {
    pushSymbol(statement.name.text, "type", exported, statement);
    return;
  }
  if (ts.isEnumDeclaration(statement)) {
    pushSymbol(statement.name.text, "enum", exported, statement);
    return;
  }
  if (ts.isVariableStatement(statement)) {
    // `let` / `var` map to "const" exactly as before; destructuring patterns produce no
    // symbol (documented limitation, design §5).
    const prefix = `${exported ? "export " : ""}${variableKeyword(ts, statement.declarationList)} `;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name)) {
        pushSymbol(declaration.name.text, "const", exported, declaration, prefix);
      }
    }
  }
}

function variableKeyword(ts: typeof TypeScriptApi, list: TypeScriptApi.VariableDeclarationList): string {
  if ((list.flags & ts.NodeFlags.Const) !== 0) return "const";
  if ((list.flags & ts.NodeFlags.Let) !== 0) return "let";
  return "var";
}
