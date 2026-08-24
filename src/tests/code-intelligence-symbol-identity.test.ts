// 2026-08-23 RAG auditas 3 — eksportų ir simbolių TAPATYBĖ, scope ir daugiakalbis leksinis tikslumas.
//
// `exports` briaunos rodo į `failas#vardas`, tad eksportuojamas vardas be simbolio yra kabanti
// briauna — mazgas, kurio grafe nėra. Ta pati klaida jau buvo uždaryta PHP ir C# pusėse, bet liko
// TypeScript'e (`export { a as b }`, `export default a`, re-eksportai) ir CommonJS'e
// (`module.exports = function () {}`, `module.exports = { run() {} }`). Kartu `exports = {…}` buvo
// laikomas eksportu, nors jis nutraukia ryšį su `module.exports`.
import assert from "node:assert/strict";
import test from "node:test";
import { indexTypeScriptFiles } from "../application/code-intelligence/indexing/ts-indexer.js";
import { indexLexicalSource } from "../application/code-intelligence/indexing/language-indexer.js";
import { bm25Scores } from "../application/code-intelligence/retrieval/ranking.js";
import type { CodeIndexFile, CodeIndexLanguage } from "../application/code-intelligence/indexing/types.js";

function fileOf(filePath: string, language: CodeIndexLanguage): CodeIndexFile {
  return { path: filePath, hash: "h", size: 0, language, kind: "source", imports: [], exports: [], symbols: [], isTest: false };
}

async function indexSources(
  sources: Record<string, string>,
): Promise<
  Map<
    string,
    {
      file: CodeIndexFile;
      symbols: { id: string; name: string; line?: number; endLine?: number }[];
      edges: { type: string; to: string }[];
    }
  >
> {
  const scanned = Object.keys(sources).map((filePath) =>
    fileOf(filePath, filePath.endsWith(".ts") ? "typescript" : "javascript"),
  );
  const fs = {
    readTextFile: (absolute: string) => {
      const key = Object.keys(sources).find((filePath) => absolute.split("\\").join("/").endsWith(filePath));
      return key === undefined ? Promise.reject(new Error(absolute)) : Promise.resolve(sources[key] as string);
    },
  };
  return await indexTypeScriptFiles(fs as never, "/repo", scanned);
}

// 2026-08-23 (operatoriaus radinys): simbolių ID nebuvo unikalūs. `code-intelligence-language-edges`
// prikalė tą invariantą LEKSINĖMS kalboms (`indexLexicalSource`: C#, Python, PHP, .NET), bet
// TypeScript overload'ai eina AST keliu (`indexTypeScriptFiles`) ir į tą vartą nepatenka — ta pusė
// iki 2026-08-24 įrodymo neturėjo.
//
// ID yra TAPATYBĖ: trys įrašai tuo pačiu `src/over.ts#over` reikštų tris `declares` briaunas į tą
// patį mazgą, t. y. indeksą, kuris pats nesilaiko savo taisyklės.
test("gate: TypeScript overload'ai duoda VIENĄ simbolį su platesniu intervalu", async () => {
  const indexed = await indexSources({
    "src/over.ts": [
      "export function over(a: string): void;",
      "export function over(a: number): void;",
      "export function over(a: unknown): void {",
      "  void a;",
      "}",
      "",
    ].join("\n"),
  });

  const result = indexed.get("src/over.ts");
  assert.ok(result);
  const ids = result.symbols.map((symbol) => symbol.id);
  assert.deepEqual(ids, ["src/over.ts#over"], `trys deklaracijos — vienas simbolis, gauta: ${ids.join(", ")}`);

  // Suliejant imamas PLATESNIS intervalas: overload'o prasmė yra visa grupė, ne paskutinė eilutė.
  const merged = result.symbols[0];
  assert.equal(merged?.line, 1, "pradžia — nuo pirmo overload'o");
  assert.equal(merged?.endLine, 5, "pabaiga — iki implementacijos kūno galo");
});

test("gate: KIEKVIENAS eksportuojamas vardas turi simbolį", async () => {
  const sources: Record<string, string> = {
    "src/helpers.ts": "export function origin(): number {\n  return 1;\n}\n",
    "src/alias.ts": "function local(): number {\n  return 1;\n}\nexport { local as renamed };\n",
    "src/default.ts": "const value = 1;\nexport default value;\n",
    "src/barrel.ts": 'export { origin } from "./helpers.js";\nexport * as helpers from "./helpers.js";\n',
    "src/factory.cjs": "module.exports = function build() {\n  return 1;\n};\n",
    "src/shape.cjs": "function helper() {\n  return 1;\n}\nmodule.exports = { helper, run: helper, go() { return 2; } };\n",
  };

  const indexed = await indexSources(sources);
  for (const filePath of Object.keys(sources)) {
    const result = indexed.get(filePath);
    assert.ok(result, filePath);
    const symbolNames = new Set(result.file.symbols);
    for (const exportName of result.file.exports) {
      assert.ok(symbolNames.has(exportName), `${filePath}: eksportas ${exportName} be simbolio duotų kabančią briauną`);
    }
  }
});

test("`export { a as b }` eksportuoja TIK b", async () => {
  const indexed = await indexSources({ "src/alias.ts": "function local(): number {\n  return 1;\n}\nexport { local as renamed };\n" });
  assert.deepEqual(
    indexed.get("src/alias.ts")?.file.exports,
    ["renamed"],
    "`local` yra vidinis vardas — importuotojas jo nemato",
  );
});

test("eksportuotos klasės METODAS nėra modulio eksportas", async () => {
  const indexed = await indexSources({
    "src/service.ts": "export class Service {\n  run(): number {\n    return 1;\n  }\n}\n",
  });
  const service = indexed.get("src/service.ts");
  assert.deepEqual(service?.file.exports, ["Service"], "eksportuojamas tipas, o ne jo nariai");
  assert.ok(service?.file.symbols.includes("Service.run"), "narys lieka SIMBOLIU — tik ne eksporto vardu");
});

test("`exports = {…}` NĖRA CommonJS eksportas", async () => {
  const indexed = await indexSources({ "src/phantom.cjs": "exports = { phantom: 1 };\n" });
  assert.deepEqual(
    indexed.get("src/phantom.cjs")?.file.exports,
    [],
    "plikas `exports` perrašymas nutraukia ryšį su `module.exports` — importuotojas nemato nieko",
  );
});

test("užgožtas `require` nėra modulio importas", async () => {
  const indexed = await indexSources({
    "src/target.cjs": "module.exports = { ok: 1 };\n",
    "src/shadow.js": "function load(require) {\n  return require('./target.cjs');\n}\nmodule.exports = { load };\n",
    "src/local.js": "const require2 = 1;\nfunction go() {\n  const require = () => 0;\n  return require('./target.cjs');\n}\nmodule.exports = { go, require2 };\n",
    "src/real.js": "const target = require('./target.cjs');\nmodule.exports = { target };\n",
  });

  assert.deepEqual(indexed.get("src/shadow.js")?.file.imports, [], "parametru užgožtas `require` yra eilinis kvietimas");
  assert.deepEqual(indexed.get("src/local.js")?.file.imports, [], "vietine deklaracija užgožtas — taip pat");
  assert.deepEqual(indexed.get("src/real.js")?.file.imports, ["src/target.cjs"], "kontrolė: tikras `require` lieka importu");
});

// 2026-08-24 (operatoriaus radinys): dvi scope formos, kurių 2026-08-23 modelis nematė.
test("HOISTINTAS `var require` užgožia visą funkciją, ne tik savo bloką", async () => {
  const indexed = await indexSources({
    "src/target.cjs": "module.exports = { ok: 1 };\n",
    "src/hoisted.js": [
      "function load(flag) {",
      "  const first = require('./target.cjs');",
      "  if (flag) {",
      "    var require = () => 0;",
      "  }",
      "  return first;",
      "}",
      "module.exports = { load };",
      "",
    ].join("\n"),
  });

  assert.deepEqual(
    indexed.get("src/hoisted.js")?.file.imports,
    [],
    "`var` hoistinamas į funkcijos viršų, tad kvietimas PRIEŠ deklaraciją jau nurodo vietinį vardą",
  );
});

test("importuotas binding'as vardu `require` NĖRA modulių sistema", async () => {
  const indexed = await indexSources({
    "src/target.cjs": "module.exports = { ok: 1 };\n",
    "src/shim.ts": "export function require(specifier: string): unknown {\n  return specifier;\n}\n",
    "src/imported.ts": 'import { require } from "./shim.js";\n\nexport const value = require("./target.cjs");\n',
  });

  assert.deepEqual(
    indexed.get("src/imported.ts")?.file.imports,
    ["src/shim.ts"],
    "importuotas `require` nurodo TĄ vardą — vienintelis tikras importas čia yra pats shim'as",
  );
});

// 2026-08-24 (operatoriaus radinys): `references` briaunos scope nepaisė visai. Bet kuris
// identifikatorius, sutapęs su importo vardu, duodavo nuorodą — net kai vardas toje vietoje reiškė
// ką kita. Tos briaunos maitina `semantic-context` įrodymus (`usedBy`/`testedBy`) ir kontraktų
// atranką, tad netikra nuoroda kelia nesusijusį simbolį į pack'ą ir stumia lauk tikrą.
test("užgožtas importas NEDUODA references briaunos", async () => {
  const indexed = await indexSources({
    "src/lib.ts": "export function foo(): number {\n  return 1;\n}\n",
    "src/shadowed.ts": [
      'import { foo } from "./lib.js";',
      "",
      "export function callsParameter(foo: () => number): number {",
      "  return foo();",
      "}",
      "",
    ].join("\n"),
    "src/real.ts": 'import { foo } from "./lib.js";\n\nexport const used = foo();\n',
  });

  const referencesOf = (file: string): string[] =>
    (indexed.get(file)?.edges ?? []).filter((edge) => edge.type === "references").map((edge) => edge.to);

  assert.deepEqual(referencesOf("src/shadowed.ts"), [], "parametras `foo` nėra importuotas `foo`");
  assert.deepEqual(referencesOf("src/real.ts"), ["src/lib.ts#foo"], "kontrolė: tikra nuoroda išlieka");
});

test("bloko lygio užgožimas irgi galioja", async () => {
  const indexed = await indexSources({
    "src/lib.ts": "export function foo(): number {\n  return 1;\n}\n",
    "src/block.ts": [
      'import { foo } from "./lib.js";',
      "",
      "export function run(): number {",
      "  const foo = () => 2;",
      "  return foo();",
      "}",
      "",
    ].join("\n"),
  });

  assert.deepEqual(
    (indexed.get("src/block.ts")?.edges ?? []).filter((edge) => edge.type === "references").map((edge) => edge.to),
    [],
    "vietinis `const foo` užgožia importą visame bloke",
  );
});

// 2026-08-24 (RAG auditas 9): trečia scope forma, kurios modelis nematė. Abu vardų rinkėjai rėmėsi
// `ts.isVariableStatement`, o `for (const x of …)` inicializatorius yra PLIKAS
// `VariableDeclarationList` — sakinio aplink jį nėra. Ciklo kintamasis į scope nepatekdavo niekada,
// ir klysdavo ABU skaitytojai vienu metu, tad testas laiko juos kartu.
test("ciklo inicializatoriaus vardas užgožia — visos trys `for` formos", async () => {
  const indexed = await indexSources({
    "src/lib.ts": "export function foo(): number {\n  return 1;\n}\n",
    "src/loop-of.ts": [
      'import { foo } from "./lib.js";',
      "",
      "export function run(items: (() => number)[]): number {",
      "  let total = 0;",
      "  for (const foo of items) {",
      "    total += foo();",
      "  }",
      "  return total;",
      "}",
      "",
    ].join("\n"),
    "src/loop-in.ts": [
      'import { foo } from "./lib.js";',
      "",
      "export function run(bag: Record<string, number>): string[] {",
      "  const seen: string[] = [];",
      "  for (const foo in bag) {",
      "    seen.push(foo);",
      "  }",
      "  return seen;",
      "}",
      "",
    ].join("\n"),
    "src/loop-classic.ts": [
      'import { foo } from "./lib.js";',
      "",
      "export function run(): number {",
      "  let total = 0;",
      "  for (let foo = 0; foo < 3; foo += 1) {",
      "    total += foo;",
      "  }",
      "  return total;",
      "}",
      "",
    ].join("\n"),
    "src/loop-after.ts": [
      'import { foo } from "./lib.js";',
      "",
      "export function run(items: number[]): number {",
      "  for (const value of items) {",
      "    void value;",
      "  }",
      "  return foo();",
      "}",
      "",
    ].join("\n"),
  });

  const referencesOf = (file: string): string[] =>
    (indexed.get(file)?.edges ?? []).filter((edge) => edge.type === "references").map((edge) => edge.to);

  for (const file of ["src/loop-of.ts", "src/loop-in.ts", "src/loop-classic.ts"]) {
    assert.deepEqual(referencesOf(file), [], `${file}: ciklo kintamasis nėra importuotas \`foo\``);
  }
  // Kontrolė BŪTINA: ciklo vardas gyvena tik cikle. Jei jis būtų surenkamas per aplinkinio bloko
  // sakinius, jis užgožtų ir po ciklo einantį kodą — teisingas atsakymas dingtų kartu su netikru.
  assert.deepEqual(referencesOf("src/loop-after.ts"), ["src/lib.ts#foo"], "po ciklo `foo` vėl yra importas");
});

test("`for (const require of …)` nėra CommonJS importas; `var` forma užgožia visą funkciją", async () => {
  const indexed = await indexSources({
    "src/loop-cjs.js": [
      "function run(list) {",
      "  for (const require of list) {",
      '    require("./slaptas.js");',
      "  }",
      "}",
      "module.exports = { run };",
      "",
    ].join("\n"),
    // `var` ciklo inicializatoriuje yra FUNKCIJOS apimties, tad jis užgožia ir kvietimą PO ciklo —
    // hoistinimas nuo to, kad `var` stovi cikle, nedingsta.
    "src/loop-var.js": [
      "function run(list) {",
      "  for (var require of list) {",
      "    void require;",
      "  }",
      '  require("./slaptas2.js");',
      "}",
      "module.exports = { run };",
      "",
    ].join("\n"),
    "src/real-cjs.js": 'const helper = require("./helper.js");\nmodule.exports = { helper };\n',
    "src/helper.js": "module.exports = 1;\n",
  });

  assert.deepEqual(indexed.get("src/loop-cjs.js")?.file.imports, [], "ciklo `const require` yra eilinis kvietimas");
  assert.deepEqual(indexed.get("src/loop-var.js")?.file.imports, [], "hoistintas ciklo `var require` užgožia funkciją");
  assert.deepEqual(indexed.get("src/real-cjs.js")?.file.imports, ["src/helper.js"], "kontrolė: tikras require išlieka");
});

test("PHP grupiniai ir kelių vardų `use` sakiniai nebenukerpami", () => {
  const result = indexLexicalSource(
    fileOf("src/App.php", "php"),
    "<?php\nuse Vendor\\Package\\{One, Two};\nuse Vendor\\Alpha, Vendor\\Beta;\nuse function Vendor\\helper;\nuse Vendor\\Long as Short;\n\nclass App {}\n",
    { knownPaths: new Set<string>(), psr4: new Map() },
  );

  assert.ok(result);
  assert.deepEqual(
    result.file.imports,
    ["Vendor\\Alpha", "Vendor\\Beta", "Vendor\\Long", "Vendor\\Package\\One", "Vendor\\Package\\Two", "Vendor\\helper"],
    "grupė išskleidžiama, kablelių sąrašas — visas, alias'as nurodo TAIKINĮ",
  );
});

test("Python deklaracijos pjūvis apima dekoratorių ir baigiasi ties bloko įtrauka", () => {
  const source = [
    "@route(\"/x\")",
    "@cached",
    "def handler():",
    "    return 1",
    "",
    "SECRET = load_secret()",
    "",
    "def other():",
    "    return 2",
    "",
  ].join("\n");

  const result = indexLexicalSource(fileOf("src/api.py", "python"), source, { knownPaths: new Set<string>(), psr4: new Map() });
  assert.ok(result);
  const handler = result.symbols.find((symbol) => symbol.name === "handler");
  assert.equal(handler?.line, 1, "dekoratorius yra deklaracijos dalis, o ne kaimynas");
  assert.equal(handler?.endLine, 4, "modulio lygio `SECRET` funkcijai nepriklauso");
});

// 2026-08-24 (operatoriaus radiniai): dvi Python pjūvio ribos formos.
test("KELIŲ EILUČIŲ dekoratorius patenka į simbolio pradžią", () => {
  const source = [
    "@route(",
    '    "/x",',
    ")",
    "def handler():",
    "    return 1",
    "",
  ].join("\n");

  const result = indexLexicalSource(fileOf("src/api.py", "python"), source, { knownPaths: new Set<string>(), psr4: new Map() });
  assert.ok(result);
  const handler = result.symbols.find((symbol) => symbol.name === "handler");
  assert.equal(handler?.line, 1, "pjūvis be dekoratoriaus rodo funkciją, kuri atrodo neužregistruota");
  assert.equal(handler?.endLine, 5);
});

// Tarp dekoratoriaus ir `def` Python leidžia tuščias eilutes ir komentarus. `blankOutNoise` komentarą
// paverčia tarpais, tad abi formos indeksuotojui atrodo vienodai — ir abi turi būti praeinamos.
test("dekoratorius randamas ir per tuščią eilutę ar komentarą", () => {
  const cases: [string, string[]][] = [
    ["tuščia eilutė", ["@route", "", "def handler():", "    return 1", ""]],
    ["komentaras", ["@route", "# pastaba", "def handler():", "    return 1", ""]],
    ["sukrauti dekoratoriai", ["@route", "@cached", "", "def handler():", "    return 1", ""]],
  ];

  for (const [label, lines] of cases) {
    const result = indexLexicalSource(fileOf("src/api.py", "python"), lines.join("\n"), {
      knownPaths: new Set<string>(),
      psr4: new Map(),
    });
    assert.ok(result, label);
    assert.equal(result.symbols.find((symbol) => symbol.name === "handler")?.line, 1, label);
  }
});

test("modulio lygio tęstinė eilutė NEPATENKA į ankstesnės funkcijos kūną", () => {
  const source = [
    "def handler():",
    "    return 1",
    "",
    "SECRET = load_secret(",
    '    "name",',
    ")",
    "",
  ].join("\n");

  const result = indexLexicalSource(fileOf("src/api.py", "python"), source, { knownPaths: new Set<string>(), psr4: new Map() });
  assert.ok(result);
  const handler = result.symbols.find((symbol) => symbol.name === "handler");
  assert.equal(
    handler?.endLine,
    2,
    "top-level išraiškos tęsinys yra ĮTRAUKTAS, bet priklauso moduliui, ne funkcijai",
  );
});

test("BM25 skaido ne ASCII tekstą", () => {
  const documents = ["nesusijęs dokumentas apie kitką", "интерфейс модуля описан здесь", "užduoties įrodymas ir sąrašas"];

  const cyrillic = bm25Scores(documents, "интерфейс модуля");
  assert.ok((cyrillic[1] ?? 0) > (cyrillic[0] ?? 0), "kirilicos atitikmuo privalo laimėti prieš nesusijusį dokumentą");

  const lithuanian = bm25Scores(documents, "įrodymas sąrašas");
  assert.ok((lithuanian[2] ?? 0) > (lithuanian[0] ?? 0), "lietuviški žodžiai nebeskyla į ASCII gabalus");
});
