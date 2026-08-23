// Code-map: AST simbolių skenas, Mermaid renderis ir padengimas.
//
// Iškelta iš `code-intelligence` 2026-08-23 (500 eilučių vartai). Tema savarankiška: čia gimsta
// diagramos mazgai ir jų tapatybė.
import assert from "node:assert/strict";
import test from "node:test";
import { loadTypeScript } from "../application/code-intelligence/indexing/ts-loader.js";
import {
  extractImportEdges,
  extractSymbolRecords,
  layerForSourcePath,
} from "../application/code-intelligence/code-map/ast-symbol-scanner.js";
import {
  classIdForFile,
  generateCodeMapMermaid,
  resolveImportTarget,
} from "../application/code-intelligence/code-map/generator.js";
import { computeCodeMapCoverage } from "../application/code-intelligence/code-map/coverage.js";

test("code-map: scanner records, mermaid render and coverage close the loop", async () => {
  // `ts` paduodamas parametru (kaip ts-source-indexer): statinis typescript importas buvo
  // vienintelis code-intelligence pažeidėjas prieš ts-loader design §6.
  const ts = await loadTypeScript();
  const source = [
    'import { helper } from "./helper.js";',
    "export class Engine {",
    "  run(): string { return helper(); }",
    "}",
    "export const VERSION = 1;",
  ].join("\n");
  const symbols = extractSymbolRecords(ts, "src/application/engine.ts", source, "application");
  assert.deepEqual(
    symbols.map((record) => `${record.kind}:${record.name}`),
    ["class:Engine", "method:Engine.run", "const:VERSION"],
  );
  const helperSymbols = extractSymbolRecords(
    ts,
    "src/application/helper.ts",
    'export function helper(): string { return "x"; }',
    "application",
  );
  const imports = extractImportEdges(ts, "src/application/engine.ts", source, "application");
  assert.deepEqual(imports, [{ fromFile: "src/application/engine.ts", fromLayer: "application", toModule: "./helper.js" }]);

  const mermaid = generateCodeMapMermaid([...symbols, ...helperSymbols], imports);
  // ID nuo 2026-08-23 turi kelio hash'o uodegą (injektyvumui), tad tikrinamas per `classIdForFile`,
  // o ne prikalamas pažodžiui — kitaip testas tikrintų formatavimą, o ne ryšį.
  const engineId = classIdForFile("src/application/engine.ts");
  const helperId = classIdForFile("src/application/helper.ts");
  assert.match(mermaid, new RegExp(`class ${engineId}\\["src/application/engine\\.ts"\\]`));
  assert.match(mermaid, new RegExp(`${engineId} --> ${helperId}`));

  const coverage = computeCodeMapCoverage([...symbols, ...helperSymbols], mermaid);
  assert.equal(coverage.coverage_percent, 100);
  assert.deepEqual(coverage.missing_symbols, []);

  assert.equal(resolveImportTarget("src/a.ts", "./b.js", new Set(["src/b.ts"])), "src/b.ts");
  assert.equal(resolveImportTarget("src/a.ts", "zod", new Set(["src/b.ts"])), null);
  assert.equal(layerForSourcePath("src/application/engine.ts", { relativeDir: "src" }), "application");
  assert.equal(layerForSourcePath("src/cli.ts", { relativeDir: "src" }), "root");
  assert.equal(layerForSourcePath("ui/src/x.ts", { relativeDir: "ui/src", fixedLayer: "ui-app" }), "ui-app");
});

// 2026-08-23 (operatoriaus radinys): diagramos mazgo ID nebuvo injektyvus.
//
//   src/a-b.ts  src/a_b.ts  src/a.b.ts  src/a/b.ts  src/a b.ts  →  visi `src_a_b`
//   src/Ą-b.ts                                                   →  `src_b`
//
// Ketvirtasis sunkiausias: tai KITAS katalogas, tad diagrama rodydavo neteisingą STRUKTŪRĄ, o ne
// tik sulietą vardą. Skaitomumo kaina taisant nulinė — ID yra vidinis, o matomas žymuo yra pilnas
// kelias (`class <id>["src/a-b.ts"]`).
test("code-map: klasės ID injektyvus", () => {
  const colliding = ["src/a-b.ts", "src/a_b.ts", "src/a.b.ts", "src/a/b.ts", "src/a b.ts", "src/Ą-b.ts"];
  const ids = colliding.map(classIdForFile);

  assert.equal(new Set(ids).size, colliding.length, `kolizija: ${ids.join(", ")}`);
  assert.match(ids[0] ?? "", /^src_a_b_[0-9a-f]{8}$/, "skaitomas prefiksas išlieka, tapatybę duoda hash'as");
  assert.equal(classIdForFile("src/a-b.ts"), ids[0], "deterministinis");
  assert.match(classIdForFile("...ts"), /^f_[0-9a-f]{8}$/, "vardas be raidžių irgi gauna galiojantį ID");
});

// 2026-08-23 (RAG auditas 3): `--check` galėjo rodyti 100 %, nors failo diagramoje nebuvo.
//
// Failų visuma buvo IŠVEDAMA iš simbolių, tad failas be eksportuotų deklaracijų (šalutinių efektų
// bootstrap'as, `export * from` barrel'is) į `source_files_total` nepatekdavo: jis neturėjo mazgo,
// importai į jį dingdavo, o aprėptis vis tiek buvo pilna. Aprėptis, kurios vardiklį lemia tas pats,
// ką ji matuoja, negali parodyti trūkumo.
test("code-map: failas be eksportų patenka į aprėptį ir gauna mazgą", async () => {
  const ts = await loadTypeScript();
  const barrelPath = "src/lib/barrel.ts";
  const consumerPath = "src/app/consumer.ts";
  const barrelSource = 'export * from "./engine.js";\n';
  const consumerSource = 'import { VERSION } from "../lib/barrel.js";\n\nexport const used = VERSION;\n';

  const symbols = extractSymbolRecords(ts, consumerPath, consumerSource, "app");
  assert.deepEqual(extractSymbolRecords(ts, barrelPath, barrelSource, "lib"), [], "kontrolė: barrel'is eksportuotų deklaracijų neturi");
  const imports = extractImportEdges(ts, consumerPath, consumerSource, "app");
  const scanned = [
    { filePath: consumerPath, layer: "app" },
    { filePath: barrelPath, layer: "lib" },
  ];
  const scannedPaths = scanned.map((file) => file.filePath);

  // A. Senasis elgesys: failų visuma išvedama iš simbolių, tad barrel'io nėra NEI diagramoje, NEI
  // vardiklyje — ir importas į jį dingsta be pėdsako, o aprėptis skelbia 100 %.
  const blindMermaid = generateCodeMapMermaid(symbols, imports);
  assert.doesNotMatch(blindMermaid, new RegExp(`class ${classIdForFile(barrelPath)}\\[`), "kontrolė: barrel'io bloko nėra");
  assert.doesNotMatch(blindMermaid, /-->/, "kontrolė: importas į neaprašytą failą dingsta");
  assert.equal(computeCodeMapCoverage(symbols, blindMermaid).coverage_percent, 100, "kontrolė: senasis 100 %");

  // B. Vardiklis, matantis visus nuskenuotus failus, trūkumą parodo.
  assert.ok(
    computeCodeMapCoverage(symbols, blindMermaid, scannedPaths).coverage_percent < 100,
    "neaprašytas failas privalo kainuoti aprėpties",
  );

  // C. Ir generatorius jam duoda mazgą — kartu su importo briauna.
  const mermaid = generateCodeMapMermaid(symbols, imports, scanned);
  const coverage = computeCodeMapCoverage(symbols, mermaid, scannedPaths);
  assert.equal(coverage.source_files_total, 2);
  assert.equal(coverage.source_files_indexed, 2);
  assert.equal(coverage.coverage_percent, 100);
  assert.deepEqual(coverage.missing_symbols, []);
  assert.match(mermaid, new RegExp(`${classIdForFile(consumerPath)} --> ${classIdForFile(barrelPath)}`));
});
