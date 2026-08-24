// Leksinis scope modelis TypeScript/JavaScript indeksavimui — VIENA vieta abiem skaitytojams.
//
// Du indeksuotojo praėjimai turi tą patį klausimą: „ar šis vardas šioje vietoje vis dar reiškia tai,
// ką manėme?" `ts-commonjs` klausia apie `require`/`module`/`exports`, `ts-source-indexer` — apie
// importuotus binding'us, kuriems jis gamina `references` briaunas. 2026-08-23 audite scope buvo
// pridėtas TIK pirmajam, ir 2026-08-24 operatorius rado, ko tai kainavo: funkcijos parametras,
// užgožiantis importuotą `foo`, vis tiek duodavo nuorodą į importo simbolį.
//
// Antra kopija būtų tas pats drift'as, kurį šioje sesijoje uždarėme keturis kartus, tad modelis yra
// vienas ir gyvena čia.
//
// ## Ką jis modeliuoja, ir ko ne
//
// `var` yra FUNKCIJOS apimties ir hoistinamas, tad jis renkamas iš VISO funkcijos kūno — įskaitant
// įdėtus blokus (`if (x) { var require = …; }` užgožia visą funkciją). `let`/`const`/`class`/
// `function` yra bloko apimties, tad renkami tik iš tiesioginių to bloko sakinių.
//
// Nemodeliuojama: `with`, `eval`, `globalThis` priskyrimai. Jie keičia vardų prasmę dinamiškai, o
// leksinis indeksuotojas tokių atsakymų duoti negali — riba įvardyta sąmoningai.

import type * as TypeScriptApi from "typescript";

/** Vienas surištas vardas iš `BindingName` (įskaitant destruktūrizavimą). */
function collectBindingNames(ts: typeof TypeScriptApi, name: TypeScriptApi.BindingName, into: Set<string>): void {
  if (ts.isIdentifier(name)) {
    into.add(name.text);
    return;
  }
  for (const element of name.elements) {
    if (ts.isBindingElement(element)) collectBindingNames(ts, element.name, into);
  }
}

/** Funkcijos formos mazgas su kūnu; `ts.isFunctionLike` netinka — jo tipas kūno neturi. */
export function functionLikeOf(
  ts: typeof TypeScriptApi,
  node: TypeScriptApi.Node,
): TypeScriptApi.FunctionLikeDeclaration | undefined {
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

/**
 * `VariableDeclarationList` bet kurioje pozicijoje — sakinyje ARBA `for` inicializatoriuje.
 *
 * 2026-08-24 (auditas 9): abu vardų rinkėjai rėmėsi `ts.isVariableStatement`, o `for (const x of …)`
 * inicializatorius yra PLIKAS `VariableDeclarationList` — jokio sakinio aplink jo nėra. Tad ciklo
 * kintamasis į scope nepatekdavo NIEKADA, ir abu skaitytojai klysdavo: `for (const foo of items)`
 * duodavo `references` briauną į importuotą `foo`, o `for (const require of list)` — netikrą
 * CommonJS importą. Vienas atpažinimas abiem vietoms, kad kopijos vėl neišsiskirtų.
 */
function declarationListOf(
  ts: typeof TypeScriptApi,
  node: TypeScriptApi.Node,
): TypeScriptApi.VariableDeclarationList | undefined {
  if (ts.isVariableStatement(node)) return node.declarationList;
  if (
    (ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node)) &&
    node.initializer !== undefined &&
    ts.isVariableDeclarationList(node.initializer)
  ) {
    return node.initializer;
  }
  return undefined;
}

/** Bloko apimties vardai: `let`/`const`/`var` deklaracijos, `function`, `class` — tiesioginiai sakiniai. */
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

/**
 * HOISTINTI `var` vardai iš viso kūno.
 *
 * Į įdėtas funkcijas neinama: ten `var` priklauso JŲ apimčiai, ne šiai. Būtent šito trūko iki
 * 2026-08-24 — `function f() { if (x) { var require = …; } require("./y"); }` buvo laikomas tikru
 * CommonJS importu, nors `var` hoistinamas į viso `f` viršų. `for (var require of …)` yra ta pati
 * forma: `var` funkcijos apimties nepraranda nuo to, kad stovi ciklo inicializatoriuje.
 */
function hoistedVarNames(ts: typeof TypeScriptApi, body: TypeScriptApi.Node): Set<string> {
  const names = new Set<string>();
  const visit = (node: TypeScriptApi.Node): void => {
    if (functionLikeOf(ts, node) !== undefined) return;
    const declarations = declarationListOf(ts, node);
    if (declarations !== undefined && (declarations.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) === 0) {
      for (const declaration of declarations.declarations) collectBindingNames(ts, declaration.name, names);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(body, visit);
  return names;
}

/** Vardai, kuriuos surišo `import` sakiniai: default, namespace ir vardiniai elementai. */
export function importBindingNames(ts: typeof TypeScriptApi, sourceFile: TypeScriptApi.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || statement.importClause === undefined) continue;
    const clause = statement.importClause;
    if (clause.name) names.add(clause.name.text);
    if (clause.namedBindings === undefined) continue;
    if (ts.isNamespaceImport(clause.namedBindings)) {
      names.add(clause.namedBindings.name.text);
      continue;
    }
    for (const element of clause.namedBindings.elements) names.add(element.name.text);
  }
  return names;
}

/**
 * Vardai, kuriuos į scope įveda ĮĖJIMAS į šį mazgą.
 *
 * Skaičiuojama įeinant, o ne kaupiama einant per medį, nes `let`/`const` yra bloko lygio ir
 * deklaracija dažnai yra kvietimo KAIMYNAS, o ne protėvis:
 * `{ const require = x; require("./y"); }` užgožia, nors `const` nėra virš kvietimo medyje.
 */
export function scopeBindings(ts: typeof TypeScriptApi, node: TypeScriptApi.Node): Set<string> {
  const names = new Set<string>();
  const functionLike = functionLikeOf(ts, node);

  if (functionLike !== undefined) {
    for (const parameter of functionLike.parameters) collectBindingNames(ts, parameter.name, names);
    const body = functionLike.body;
    if (body !== undefined) {
      if (ts.isBlock(body)) for (const name of statementBindings(ts, body.statements)) names.add(name);
      for (const name of hoistedVarNames(ts, body)) names.add(name);
    }
    return names;
  }

  if (ts.isBlock(node) || ts.isModuleBlock(node)) {
    for (const name of statementBindings(ts, node.statements)) names.add(name);
  }
  if (ts.isCatchClause(node) && node.variableDeclaration) {
    collectBindingNames(ts, node.variableDeclaration.name, names);
  }
  // Ciklo inicializatorius rišamas ĮEINANT į patį ciklą, o ne per `statementBindings`: `for` yra
  // sakinys, tad iš aplinkinio bloko jo vardas atrodytų kaip to bloko vardas ir užgožtų dar ir
  // sakinius PO ciklo — vardas gyvena tik cikle.
  const loopDeclarations = declarationListOf(ts, node);
  if (loopDeclarations !== undefined && !ts.isVariableStatement(node)) {
    for (const declaration of loopDeclarations.declarations) collectBindingNames(ts, declaration.name, names);
  }
  return names;
}

/** Failo lygio vardai: top-level deklaracijos plius hoistinti `var` iš viso failo. */
export function fileScopeBindings(ts: typeof TypeScriptApi, sourceFile: TypeScriptApi.SourceFile): Set<string> {
  const names = statementBindings(ts, sourceFile.statements);
  for (const name of hoistedVarNames(ts, sourceFile)) names.add(name);
  return names;
}

/** Praplečia scope tik tada, kai tikrai yra kuo — kitaip grąžina tą patį rinkinį be kopijos. */
export function extendScope(outer: ReadonlySet<string>, introduced: ReadonlySet<string>): ReadonlySet<string> {
  return introduced.size === 0 ? outer : new Set([...outer, ...introduced]);
}
