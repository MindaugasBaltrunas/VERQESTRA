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

async function indexSources(sources: Record<string, string>): Promise<Map<string, { file: CodeIndexFile; symbols: { id: string }[] }>> {
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

test("BM25 skaido ne ASCII tekstą", () => {
  const documents = ["nesusijęs dokumentas apie kitką", "интерфейс модуля описан здесь", "užduoties įrodymas ir sąrašas"];

  const cyrillic = bm25Scores(documents, "интерфейс модуля");
  assert.ok((cyrillic[1] ?? 0) > (cyrillic[0] ?? 0), "kirilicos atitikmuo privalo laimėti prieš nesusijusį dokumentą");

  const lithuanian = bm25Scores(documents, "įrodymas sąrašas");
  assert.ok((lithuanian[2] ?? 0) > (lithuanian[0] ?? 0), "lietuviški žodžiai nebeskyla į ASCII gabalus");
});
