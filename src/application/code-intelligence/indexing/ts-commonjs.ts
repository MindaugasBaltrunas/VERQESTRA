// CommonJS pusė TypeScript AST indeksuotojui: `require(…)`, `module.exports`, `exports.x`.
//
// 2026-08-23 (operatoriaus radinys): JavaScript buvo pažymėtas pilnai aktyviu, nes jis eina per tą
// patį `ts.createSourceFile` AST kaip TypeScript. Tai tiesa ESM sintaksei — ir netiesa CommonJS'ui.
// `import`/`export` yra DEKLARACIJOS, kurias indeksuotojas atpažįsta iš mazgo tipo; `require()` yra
// paprastas kvietimas, o `module.exports = …` — priskyrimas. Nei vienas nėra deklaracija, tad
// `.cjs` failas grąžindavo tuščius `imports` ir `exports`:
//
//   src/a.cjs      imports=[] exports=[] symbols=["run"]
//   src/legacy.js  imports=[] exports=[] symbols=["util"]   // `exports.go = function go()` dingo
//   src/esm.mjs    imports=["src/b.cjs"] exports=["go"]     // ESM veikė
//
// Atskiras modulis, o ne dar 60 eilučių `ts-source-indexer`e: tai kita modulių sistema, ir jos
// taisyklės neturi susimaišyti su ESM deklaracijų apdorojimu.

import type * as TypeScriptApi from "typescript";
import type { CodeIndexSymbolKind } from "./types.js";

export type CommonJsSymbol = { name: string; kind: CodeIndexSymbolKind; line: number; endLine: number };

export type CommonJsFindings = {
  imports: string[];
  /** Eksportuoti vardai. Tušti, jei failas CommonJS'o nenaudoja. */
  exports: string[];
  /**
   * Simboliai, gimę iš priskyrimo (`exports.go = function go() {}`).
   *
   * Jie BŪTINI, o ne malonumas: `exports` briaunos rodo į `failas#vardas`, tad eksportuotas vardas
   * be simbolio duotų briauną į nesamą ID — tiksliai ta pati klaida, kurią jau taisėme PHP ir C#
   * eksportuose.
   */
  symbols: CommonJsSymbol[];
};

/** `require("…")` su VIENU eilutės literalu. Kintamasis kelias nėra nuoroda, kurią galime įrodyti. */
function requireTarget(ts: typeof TypeScriptApi, node: TypeScriptApi.Node): string | undefined {
  if (!ts.isCallExpression(node)) return undefined;
  if (!ts.isIdentifier(node.expression) || node.expression.text !== "require") return undefined;
  const [argument] = node.arguments;
  return argument !== undefined && node.arguments.length === 1 && ts.isStringLiteral(argument) ? argument.text : undefined;
}

/** `module.exports` arba `exports` — abu CommonJS eksporto vartai. */
function exportTargetName(ts: typeof TypeScriptApi, target: TypeScriptApi.Expression): "module" | "named" | undefined {
  if (ts.isIdentifier(target) && target.text === "exports") return "module";
  if (!ts.isPropertyAccessExpression(target)) return undefined;
  if (ts.isIdentifier(target.expression) && target.expression.text === "module" && target.name.text === "exports") {
    return "module";
  }
  return undefined;
}

function symbolKindOf(ts: typeof TypeScriptApi, expression: TypeScriptApi.Expression): CodeIndexSymbolKind {
  if (ts.isFunctionExpression(expression) || ts.isArrowFunction(expression)) return "function";
  if (ts.isClassExpression(expression)) return "class";
  return "const";
}

/**
 * Surenka CommonJS importus ir eksportus iš viso medžio.
 *
 * Einama per VISĄ medį, ne tik per top-level: `require` sąlygos ar funkcijos viduje yra įprasta
 * CommonJS forma (`if (dev) require("./debug")`), ir ji yra tokia pat tikra priklausomybė.
 */
export function collectCommonJs(
  ts: typeof TypeScriptApi,
  sourceFile: TypeScriptApi.SourceFile,
  resolve: (specifier: string) => { value: string },
  lineOf: (position: number) => number,
): CommonJsFindings {
  const imports = new Set<string>();
  const exports = new Set<string>();
  const symbols: CommonJsSymbol[] = [];

  const addAssignment = (name: string, expression: TypeScriptApi.Expression, node: TypeScriptApi.Node): void => {
    exports.add(name);
    symbols.push({
      name,
      kind: symbolKindOf(ts, expression),
      line: lineOf(node.getStart(sourceFile)),
      endLine: lineOf(node.getEnd()),
    });
  };

  const walk = (node: TypeScriptApi.Node): void => {
    const required = requireTarget(ts, node);
    if (required !== undefined) imports.add(resolve(required).value);

    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const left = node.left;

      // `module.exports = …` / `exports = …`
      if (exportTargetName(ts, left) === "module") {
        if (ts.isObjectLiteralExpression(node.right)) {
          // `module.exports = { helper, run: impl }` — vardai iš objekto, nes būtent jie matomi
          // importuotojui. Simbolių čia NEKURIAME: jie jau deklaruoti aukščiau faile.
          for (const property of node.right.properties) {
            const name = property.name;
            if (name !== undefined && (ts.isIdentifier(name) || ts.isStringLiteral(name))) exports.add(name.text);
          }
        } else {
          // `module.exports = function …` — vienintelis eksportas neturi vardo, tad „default",
          // kaip ir `export default` ESM pusėje.
          exports.add("default");
        }
      }

      // `module.exports.NAME = …` / `exports.NAME = …`
      if (ts.isPropertyAccessExpression(left) && exportTargetName(ts, left.expression) === "module") {
        addAssignment(left.name.text, node.right, node);
      }
    }

    ts.forEachChild(node, walk);
  };
  ts.forEachChild(sourceFile, walk);

  return { imports: [...imports].sort(), exports: [...exports].sort(), symbols };
}
