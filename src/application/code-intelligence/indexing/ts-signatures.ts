// Deklaracijų signatūros (task 0022). Behaviour etalon: AG_loop code-index/ts-indexer.ts.
//
// A signature is the declaration HEAD, taken verbatim from the source between two AST
// positions and then whitespace-normalized: no TypeChecker, no type inference, no
// printer. That keeps the lightweight `createSourceFile`-only hot path intact and makes
// the output a pure function of the file's text — the same bytes always yield the same
// signature. Bodies are excluded on purpose: they are what `line`/`endLine` + the
// on-demand source slice are for.

import type * as TypeScriptApi from "typescript";

/**
 * Upper bound on a stored signature. A signature is context-pack metadata, so an
 * enormous union or generic constraint must not be able to grow the index without limit;
 * anything longer is truncated with a trailing `...` marker.
 */
const MAX_SIGNATURE_CHARS = 200;

export function declarationSignature(
  ts: typeof TypeScriptApi,
  sourceFile: TypeScriptApi.SourceFile,
  node: TypeScriptApi.Node,
  prefix: string,
): string {
  const start = node.getStart(sourceFile);
  const end = Math.max(start, signatureEnd(ts, sourceFile, node));
  return compactSignature(`${prefix}${sourceFile.text.slice(start, end)}`);
}

/**
 * Where the head of a declaration stops:
 * - function / method: at the body's `{` (or the whole node for an overload / ambient
 *   declaration, which has no body);
 * - class / interface / enum: at the members list, whose `pos` sits just past the `{`;
 * - variable: at the type annotation when there is one, else at an arrow/function
 *   initializer's body, else the whole declaration (`const version = "2.1.0"` is itself
 *   the useful signature);
 * - anything else (type alias): the whole declaration, capped by `MAX_SIGNATURE_CHARS`.
 */
function signatureEnd(ts: typeof TypeScriptApi, sourceFile: TypeScriptApi.SourceFile, node: TypeScriptApi.Node): number {
  if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node)) {
    return node.body ? node.body.getStart(sourceFile) : node.end;
  }
  if (ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isEnumDeclaration(node)) {
    return node.members.pos;
  }
  if (ts.isVariableDeclaration(node)) {
    if (node.type) {
      return node.type.end;
    }
    const initializer = node.initializer;
    if (initializer && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))) {
      return initializer.body.getStart(sourceFile);
    }
  }
  return node.end;
}

/**
 * One line, single-spaced, without the punctuation that only made sense while the head was
 * still attached to its body (`{`, `;`, a trailing `=>` or `=`, a dangling comma).
 * Comments inside a head are collapsed rather than stripped: removing them textually would
 * corrupt any `//` that lives inside a string default, and a signature must never
 * misrepresent the declaration it names.
 */
function compactSignature(text: string): string {
  const collapsed = text
    .replace(/\s+/g, " ")
    .replace(/\(\s+/g, "(")
    .replace(/\s+([),\]>;])/g, "$1")
    .replace(/,([)\]>])/g, "$1")
    .trim()
    .replace(/\s*(=>|[{;,=])$/, "")
    .trim();
  if (collapsed.length <= MAX_SIGNATURE_CHARS) {
    return collapsed;
  }
  return `${collapsed.slice(0, MAX_SIGNATURE_CHARS - 3).trimEnd()}...`;
}
