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

/** Vienas surištas vardas iš `BindingName` (įskaitant destrukūrizavimą). */
function collectBindingNames(ts: typeof TypeScriptApi, name: TypeScriptApi.BindingName, into: Set<string>): void {
  if (ts.isIdentifier(name)) {
    into.add(name.text);
    return;
  }
  for (const element of name.elements) {
    if (ts.isBindingElement(element)) collectBindingNames(ts, element.name, into);
  }
}

/** Vardai, kuriuos į savo scope įveda šie sakiniai: `var/let/const`, `function`, `class`. */
function statementBindings(ts: typeof TypeScriptApi, statements: readonly TypeScriptApi.Statement[]): Set<string> {
  const names = new Set<string>();
  for (const statement of statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) collectBindingNames(ts, declaration.name, names);
      continue;
    }
    if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name) {
      names.add(statement.name.text);
    }
  }
  return names;
}

/** Funkcijos formos mazgas su kūnu; `ts.isFunctionLike` netinka — jo tipas kūno neturi. */
function functionLikeOf(ts: typeof TypeScriptApi, node: TypeScriptApi.Node): TypeScriptApi.FunctionLikeDeclaration | undefined {
  return ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
    ? node
    : undefined;
}

/** Funkcijos parametrai — antras būdas užgožti `require`/`module`/`exports`. */
function parameterBindings(ts: typeof TypeScriptApi, node: TypeScriptApi.Node): Set<string> {
  const names = new Set<string>();
  for (const parameter of functionLikeOf(ts, node)?.parameters ?? []) collectBindingNames(ts, parameter.name, names);
  return names;
}

/**
 * Ar mazgas atidaro naują scope, kurio deklaracijos gali užgožti CommonJS vardus.
 *
 * `Block` ir funkcijos kūnas imami kartu: `let` ir `const` yra bloko lygio, tad
 * `{ const require = x; require("./y"); }` užgožia importą, nors deklaracija yra kvietimo KAIMYNAS,
 * o ne protėvis. Būtent todėl scope skaičiuojamas įeinant, o ne kaupiamas einant per medį.
 */
function scopeStatements(ts: typeof TypeScriptApi, node: TypeScriptApi.Node): readonly TypeScriptApi.Statement[] {
  if (ts.isBlock(node) || ts.isModuleBlock(node)) return node.statements;
  const body = functionLikeOf(ts, node)?.body;
  return body !== undefined && ts.isBlock(body) ? body.statements : [];
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
    const introduced = new Set([...parameterBindings(ts, node), ...statementBindings(ts, scopeStatements(ts, node))]);
    const shadowed: ReadonlySet<string> =
      introduced.size === 0 ? outerShadowed : new Set([...outerShadowed, ...introduced]);

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

  const fileShadowed = statementBindings(ts, sourceFile.statements);
  ts.forEachChild(sourceFile, (child) => {
    walk(child, fileShadowed);
  });

  return { imports: [...imports].sort(), exports: [...exports].sort(), symbols };
}
