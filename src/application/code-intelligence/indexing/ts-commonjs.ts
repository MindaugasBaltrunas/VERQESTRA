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
import { extendScope, fileScopeBindings, importBindingNames, scopeBindings } from "./ts-scope.js";
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

/**
 * `module.exports` — VIENINTELIS taikinys, kurio perrašymas pakeičia modulio eksportą.
 *
 * 2026-08-23 (RAG auditas 3): anksčiau čia tiko ir plikas `exports`, tad `exports = { phantom: 1 }`
 * buvo laikomas tikru CommonJS eksportu. Nėra: `exports` yra tik LOKALI nuoroda į `module.exports`,
 * ir jos perrašymas nutraukia ryšį — importuotojas nemato nieko.
 */
function isModuleExportsObject(ts: typeof TypeScriptApi, target: TypeScriptApi.Expression): boolean {
  return (
    ts.isPropertyAccessExpression(target) &&
    ts.isIdentifier(target.expression) &&
    target.expression.text === "module" &&
    target.name.text === "exports"
  );
}

/**
 * Vartai, per kuriuos veikia `.NAME = …`: ir `module.exports.NAME`, ir `exports.NAME`.
 *
 * Priešingai nei perrašymas, LAUKO priskyrimas per `exports` yra tikras eksportas — `exports` vis
 * dar rodo į tą patį objektą.
 */
function isExportsGateway(ts: typeof TypeScriptApi, target: TypeScriptApi.Expression): boolean {
  return (ts.isIdentifier(target) && target.text === "exports") || isModuleExportsObject(ts, target);
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
 *
 * SCOPE paisomas (2026-08-23, RAG auditas 3): `require`, `module` ir `exports` yra paprasti vardai,
 * o ne raktažodžiai. Užgožti parametru (`function load(require) { require("x") }`) ar vietine
 * deklaracija jie nustoja reikšti modulių sistemą, ir tokį kvietimą palaikius importu indekse
 * atsiranda NETIKRA architektūros briauna.
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

  const walk = (node: TypeScriptApi.Node, outerShadowed: ReadonlySet<string>): void => {
    const shadowed = extendScope(outerShadowed, scopeBindings(ts, node));

    const required = shadowed.has("require") ? undefined : requireTarget(ts, node);
    if (required !== undefined) imports.add(resolve(required).value);

    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const left = node.left;

      // `module.exports = …`
      if (!shadowed.has("module") && isModuleExportsObject(ts, left)) {
        if (ts.isObjectLiteralExpression(node.right)) {
          // `module.exports = { helper, run: impl, go() {} }` — vardai iš objekto, nes būtent jie
          // matomi importuotojui.
          //
          // Simbolis kuriamas VISUR, išskyrus shorthand'ą (2026-08-23, RAG auditas 3): `{ helper }`
          // neišvengiamai įvardija jau deklaruotą vardą, o `run: impl` ir `go() {}` sukuria NAUJĄ
          // viešą vardą, kurio faile nėra. Be simbolio jis duotų `exports` briauną į nesamą ID.
          for (const property of node.right.properties) {
            const name = property.name;
            if (name === undefined || !(ts.isIdentifier(name) || ts.isStringLiteral(name))) continue;
            exports.add(name.text);
            if (ts.isShorthandPropertyAssignment(property)) continue;
            const value = ts.isPropertyAssignment(property) ? property.initializer : undefined;
            symbols.push({
              name: name.text,
              kind: value === undefined ? "function" : symbolKindOf(ts, value),
              line: lineOf(property.getStart(sourceFile)),
              endLine: lineOf(property.getEnd()),
            });
          }
        } else {
          // `module.exports = function …` — vienintelis eksportas neturi vardo, tad „default",
          // kaip ir `export default` ESM pusėje. Simbolis būtinas dėl tos pačios priežasties.
          addAssignment("default", node.right, node);
        }
      }

      // `module.exports.NAME = …` / `exports.NAME = …`
      if (ts.isPropertyAccessExpression(left) && isExportsGateway(ts, left.expression) && !isShadowedGateway(left.expression)) {
        addAssignment(left.name.text, node.right, node);
      }
    }

    ts.forEachChild(node, (child) => {
      walk(child, shadowed);
    });

    function isShadowedGateway(target: TypeScriptApi.Expression): boolean {
      return ts.isIdentifier(target) ? shadowed.has(target.text) : shadowed.has("module");
    }
  };

  // IMPORTUOTAS binding'as vardu `require` irgi užgožia (2026-08-24, operatoriaus radinys):
  // `import { require } from "./shim.js"` reiškia, kad kvietimas nurodo TĄ vardą, o ne modulių
  // sistemą. Failo lygyje kartu imami hoistinti `var`, kurių bloko sakinių skaitymas nemato.
  const fileShadowed = new Set([...fileScopeBindings(ts, sourceFile), ...importBindingNames(ts, sourceFile)]);
  ts.forEachChild(sourceFile, (child) => {
    walk(child, fileShadowed);
  });

  return { imports: [...imports].sort(), exports: [...exports].sort(), symbols };
}
