// Code-map: AST simbolių skenas, Mermaid renderis ir padengimas.
//
// Iškelta iš `code-intelligence` 2026-08-23 (500 eilučių vartai). Tema savarankiška: čia gimsta
// diagramos mazgai ir jų tapatybė.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  layerForPath,
  projectCodeMapFromIndex,
} from "../application/code-intelligence/code-map/index-projection.js";
import { buildCodeIndex } from "../application/code-intelligence/indexing/builder.js";
import { readCodeIndex } from "../application/code-intelligence/store/code-index-store.js";
import {
  classIdForFile,
  expectedImportEdges,
  generateCodeMapMermaid,
} from "../application/code-intelligence/code-map/generator.js";
import { computeCodeMapCoverage } from "../application/code-intelligence/code-map/coverage.js";
import { nodeFsTestPort } from "./helpers/node-fs-port.js";
import type { CodeIndexData } from "../application/code-intelligence/indexing/types.js";

async function indexOf(files: Record<string, string>): Promise<{ root: string; data: CodeIndexData }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "vq-code-map-"));
  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(root, ...relative.split("/"));
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, content, "utf8");
  }
  await buildCodeIndex(nodeFsTestPort, root);
  return { root, data: await readCodeIndex(nodeFsTestPort, root) };
}

test("code-map: projekcija iš indekso, renderis ir aprėptis uždaro ratą", async () => {
  const { root, data } = await indexOf({
    "src/application/helper.ts": 'export function helper(): string {\n  return "x";\n}\n',
    "src/application/engine.ts": [
      'import { helper } from "./helper.js";',
      "",
      "export class Engine {",
      "  run(): string {",
      "    return helper();",
      "  }",
      "}",
      "",
      "export const VERSION = 1;",
      "",
    ].join("\n"),
  });
  try {
    const { symbols, imports, files } = projectCodeMapFromIndex(data);

    assert.deepEqual(
      symbols.filter((record) => record.filePath === "src/application/engine.ts").map((r) => `${r.kind}:${r.name}`),
      ["class:Engine", "method:Engine.run", "const:VERSION"],
      "metodas atkuriamas iš `Klasė.narys` vardo formos",
    );
    assert.equal(symbols[0]?.layer, "application", "sluoksnis — pirmas segmentas po šaknies");

    // Importas ateina JAU IŠSPRĘSTAS: projekcija nieko nesprendžia pati.
    assert.ok(
      imports.some((edge) => edge.fromFile === "src/application/engine.ts" && edge.toTarget === "src/application/helper.ts"),
      `indekso išspręstas kelias, ne specifikatorius: ${JSON.stringify(imports)}`,
    );

    const mermaid = generateCodeMapMermaid(symbols, imports, files);
    const engineId = classIdForFile("src/application/engine.ts");
    const helperId = classIdForFile("src/application/helper.ts");
    assert.match(mermaid, new RegExp(`class ${engineId}\\["src/application/engine\\.ts"\\]`));
    assert.match(mermaid, new RegExp(`${engineId} --> ${helperId}`));

    const coverage = computeCodeMapCoverage(symbols, mermaid, files.map((file) => file.filePath), imports);
    assert.equal(coverage.coverage_percent, 100);
    assert.deepEqual(coverage.missing_symbols, []);
    assert.equal(coverage.edges_total, 1, "briauna įeina į vardiklį");
    assert.equal(coverage.edges_rendered_in_mmd, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Sluoksnis kvalifikuojamas DARBO SRITIMI, nes monorepo skirtingi paketai turi vienodų segmentų
// vardų (`model`, `view`); nekvalifikuoti jie diagramoje susilietų į vieną sekciją.
test("code-map: sluoksnis = darbo sritis + segmentas po jos `src/`", () => {
  const packages = ["mobile-gateway", "ui-app", ""];
  assert.equal(layerForPath("src/application/engine.ts", packages), "application");
  assert.equal(layerForPath("src/cli.ts", packages), "root");
  assert.equal(layerForPath("scripts/stamp.mjs", packages), "scripts");
  assert.equal(layerForPath("ui-app/src/view/App.tsx", packages), "ui-app/view");
  assert.equal(layerForPath("ui-app/vite.config.ts", packages), "ui-app/root");
  assert.equal(layerForPath("mobile-gateway/src/routes/local.ts", packages), "mobile-gateway/routes");

  // Ilgiausias prefiksas laimi — įdėta darbo sritis nepriskiriama tėvinei.
  assert.equal(layerForPath("ui-app/src/model/types.ts", ["ui-app/src", "ui-app", ""]), "ui-app/src/model");
});

// Vienas AST variklis reiškia vieną REZOLIUCIJĄ. Ankstesnis vietinis rezolverius mokėjo tik
// reliatyvius kelius, tad path-mapped alias (`@lib/x`) iš diagramos dingdavo — nors indeksas jį jau
// turėjo išsprendęs per tikrą tsconfig rezoliuciją. Tai buvo tyli, ne garsi, spraga.
test("code-map: alias importas BEBEDINGSTA iš diagramos", async () => {
  const { root, data } = await indexOf({
    "tsconfig.json": JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@lib/*": ["src/lib/*"] } } }),
    "src/lib/helper.ts": "export function helper(): number {\n  return 1;\n}\n",
    "src/app/main.ts": 'import { helper } from "@lib/helper.js";\n\nexport const used = helper();\n',
  });
  try {
    const { symbols, imports, files } = projectCodeMapFromIndex(data);
    assert.ok(
      imports.some((edge) => edge.fromFile === "src/app/main.ts" && edge.toTarget === "src/lib/helper.ts"),
      `alias privalo būti išspręstas: ${JSON.stringify(imports)}`,
    );
    assert.match(
      generateCodeMapMermaid(symbols, imports, files),
      new RegExp(`${classIdForFile("src/app/main.ts")} --> ${classIdForFile("src/lib/helper.ts")}`),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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

// 2026-08-24 (operatoriaus radinys): code-map turėjo SAVO plėtinių sąrašą, ir jis jau buvo
// atsilikęs — `.mts` ir `.cts` registre yra nuo pat pradžių, bet į skenavimą nepateko.
//
// Pasekmė tyli ir būtent tokia, kokios saugomasi: tokio failo NĖRA nei diagramoje, nei aprėpties
// VARDIKLYJE, tad `--check` skelbia 100 %, kai dalis medžio apskritai neapžiūrėta. Šis vartas
// tikrina ne dvi trūkstamas eilutes, o INVARIANTĄ: ką indeksas priskiria AST keliui, tą code-map ir
// skenuoja.
// Nuo 2026-08-24 code-map SAVO plėtinių sąrašo nebeturi visai — projekcija atsirenka pagal indekso
// KALBĄ, tad drift'as tarp dviejų sąrašų nebeįmanomas iš principo. Vartas tikrina rezultatą, ne
// sąrašų lygybę: ką indeksas moka aprašyti, tas atsiduria diagramoje.
test("gate: KIEKVIENAS simbolius turintis indekso failas patenka į code-map projekciją", async () => {
  const { root, data } = await indexOf({
    "src/app/a.ts": "export const a = 1;\n",
    "src/app/b.mts": "export const b = 2;\n",
    "src/app/c.cts": "export const c = 3;\n",
    "src/app/d.mjs": "export const d = 4;\n",
    "src/app/e.cjs": "module.exports = { e: 5 };\n",
    "src/app/types.d.ts": "export declare const ignored: number;\n",
    "src/app/rules.py": "def rule():\n    pass\n",
  });
  try {
    const { files } = projectCodeMapFromIndex(data);
    const paths = files.map((file) => file.filePath).sort();

    assert.deepEqual(
      paths,
      ["src/app/a.ts", "src/app/b.mts", "src/app/c.cts", "src/app/d.mjs", "src/app/e.cjs", "src/app/rules.py"],
      "`.mts`/`.cts` anksčiau iškrisdavo tyliai; Python — nuo žingsnio 2",
    );
    assert.ok(!paths.includes("src/app/types.d.ts"), "`.d.ts` yra deklaracija, ne implementacija");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// 2026-08-24 (operatoriaus radinys): projekcija turėjo FIKSUOTĄ šaknų sąrašą (`src/`), paveldėtą iš
// etalono. Šiame repo tai reiškė 846 matomus failus ir 328 nematomus (`ui-app/src`,
// `mobile-gateway/src`, `mobile-app/src`, `scripts/`) — `--check` skelbdavo 100 % neapžiūrėjęs
// beveik trečdalio. Sąrašas dar ir senėdavo: `mobile-app` prijungtas šią savaitę ir iškart būtų
// buvęs nematomas.
test("darbo sritys už `src/` ribų patenka į diagramą ir į aprėpties vardiklį", async () => {
  const { root, data } = await indexOf({
    "package.json": JSON.stringify({ name: "root" }),
    "src/app/main.ts": "export const main = 1;\n",
    "scripts/stamp.mjs": "export const stamp = 1;\n",
    "ui-app/package.json": JSON.stringify({ name: "ui-app" }),
    "ui-app/src/view/App.tsx": "export const App = 1;\n",
    "mobile-gateway/package.json": JSON.stringify({ name: "mobile-gateway" }),
    "mobile-gateway/src/routes/local.ts": "export const route = 1;\n",
  });
  try {
    const { symbols, imports, files } = projectCodeMapFromIndex(data);

    assert.deepEqual(
      files.map((file) => `${file.layer}:${file.filePath}`).sort(),
      [
        "app:src/app/main.ts",
        "mobile-gateway/routes:mobile-gateway/src/routes/local.ts",
        "scripts:scripts/stamp.mjs",
        "ui-app/view:ui-app/src/view/App.tsx",
      ],
      "kiekviena darbo sritis matoma ir kvalifikuota savo vardu",
    );

    const coverage = computeCodeMapCoverage(
      symbols,
      generateCodeMapMermaid(symbols, imports, files),
      files.map((file) => file.filePath),
    );
    assert.equal(coverage.source_files_total, 4, "vardiklis apima VISAS darbo sritis");
    assert.equal(coverage.coverage_percent, 100, "perkurtas žemėlapis vėl pasiekiamas");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ŽINGSNIS 2 (2026-08-24): mišraus repo aprėptis nustojo meluoti.
//
// Iki tol vardiklis apėmė tik ECMAScript, tad Python/PHP/C# failai į `source_files_total`
// nepatekdavo — `--check` skelbdavo 100 % jų visai neapžiūrėjęs. Tai ta pati klasė kaip failas be
// eksportų: aprėptis, kurios vardiklį lemia tas pats, ką ji matuoja.
test("mišraus repo aprėptis apima VISAS simbolius turinčias kalbas", async () => {
  const { root, data } = await indexOf({
    "src/app/main.ts": "export const main = 1;\n",
    "src/app/service.py": "def run():\n    return 1\n",
    "src/app/Repo.php": "<?php\nclass Repo {}\n",
    "src/app/Rules.cs": "public class Rules { }\n",
    "src/app/notes.md": "# Pastabos\n",
  });
  try {
    const { symbols, imports, files } = projectCodeMapFromIndex(data);
    const paths = files.map((file) => file.filePath).sort();

    assert.deepEqual(
      paths,
      ["src/app/Repo.php", "src/app/Rules.cs", "src/app/main.ts", "src/app/service.py"],
      "keturios kalbos su simboliais — Markdown neįeina, nes mazgas be narių aprėpties nepraturtina",
    );

    // Ir svarbiausia: perkurtas žemėlapis vėl duoda 100 %, t. y. praplėstas vardiklis yra
    // PASIEKIAMAS, o ne amžinai raudonas.
    const mermaid = generateCodeMapMermaid(symbols, imports, files);
    const coverage = computeCodeMapCoverage(symbols, mermaid, paths);
    assert.equal(coverage.source_files_total, 4);
    assert.equal(coverage.coverage_percent, 100);

    // O senas, tik TypeScript apimantis žemėlapis dabar sąžiningai krenta žemiau 100 %.
    const ecmascriptOnly = files.filter((file) => file.filePath.endsWith(".ts"));
    const staleMermaid = generateCodeMapMermaid(
      symbols.filter((symbol) => symbol.filePath.endsWith(".ts")),
      imports,
      ecmascriptOnly,
    );
    assert.ok(
      computeCodeMapCoverage(symbols, staleMermaid, paths).coverage_percent < 100,
      "iki žingsnio 2 būtent šis atvejis grąžindavo 100 %",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// `.mts` failo ID negali prarasti tik DALIES plėtinio: `x.mts` → `x_m` reikštų kitą mazgą nei
// `x.ts` → `x`, bet vardas skaitytojui atrodytų sugadintas.
test("code-map: `.mts`/`.cts` ID nuima VISĄ plėtinį", () => {
  assert.match(classIdForFile("src/x.mts"), /^src_x_[0-9a-f]{8}$/);
  assert.match(classIdForFile("src/x.cts"), /^src_x_[0-9a-f]{8}$/);
  assert.notEqual(classIdForFile("src/x.mts"), classIdForFile("src/x.cts"), "skirtingi failai — skirtingi ID");
});

// 2026-08-23 (RAG auditas 3): `--check` galėjo rodyti 100 %, nors failo diagramoje nebuvo.
//
// Failų visuma buvo IŠVEDAMA iš simbolių, tad failas be eksportuotų deklaracijų (šalutinių efektų
// bootstrap'as, `export * from` barrel'is) į `source_files_total` nepatekdavo: jis neturėjo mazgo,
// importai į jį dingdavo, o aprėptis vis tiek buvo pilna. Aprėptis, kurios vardiklį lemia tas pats,
// ką ji matuoja, negali parodyti trūkumo.
test("code-map: failas be eksportų patenka į aprėptį ir gauna mazgą", async () => {
  const barrelPath = "src/lib/barrel.ts";
  const consumerPath = "src/app/consumer.ts";
  const { root, data } = await indexOf({
    "src/lib/engine.ts": "export const VERSION = 1;\n",
    [barrelPath]: 'export * from "./engine.js";\n',
    [consumerPath]: 'import { VERSION } from "../lib/barrel.js";\n\nexport const used = VERSION;\n',
  });
  const projected = projectCodeMapFromIndex(data);
  const symbols = projected.symbols.filter((record) => record.filePath === consumerPath);
  const imports = projected.imports.filter((edge) => edge.fromFile === consumerPath);
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
  await rm(root, { recursive: true, force: true });
});

// 2026-09-01 (operatoriaus reprodukcija): aprėptis priklausomybių briaunų NEMATAVO apskritai.
// Pašalinus VISAS `-->` eilutes iš diagramos, `--check` skelbdavo 100 % ir grąžindavo sėkmę —
// mazgai buvo vietoje, o visas priklausomybių sluoksnis dingdavo be pėdsako.
//
// Tai ta pati klasė kaip failas be eksportų: matavimas negali parodyti to, ko nėra jo vardiklyje.
// Todėl briauna dabar kainuoja lygiai tiek pat, kiek simbolis ar failas.
test("code-map: briaunos pašalinimas iš diagramos MAŽINA aprėptį", async () => {
  const { root, data } = await indexOf({
    "src/lib/helper.ts": "export function helper(): number {\n  return 1;\n}\n",
    "src/app/main.ts": 'import { helper } from "../lib/helper.js";\n\nexport const used = helper();\n',
  });
  try {
    const { symbols, imports, files } = projectCodeMapFromIndex(data);
    const paths = files.map((file) => file.filePath);
    const mermaid = generateCodeMapMermaid(symbols, imports, files);

    // A. Pilna diagrama — visos briaunos suskaičiuotos ir 100 % pasiekiama.
    const full = computeCodeMapCoverage(symbols, mermaid, paths, imports);
    assert.equal(full.edges_total, 1);
    assert.equal(full.edges_rendered_in_mmd, 1);
    assert.equal(full.coverage_percent, 100);
    assert.deepEqual(full.missing_symbols, []);

    // B. Regresija: ta pati diagrama be `-->` eilučių su tuo pačiu netuščiu `ImportEdge[]`.
    const withoutEdges = mermaid
      .split("\n")
      .filter((line) => !/-->/.test(line))
      .join("\n");
    assert.doesNotMatch(withoutEdges, /-->/, "kontrolė: briaunų diagramoje nebeliko");
    const stripped = computeCodeMapCoverage(symbols, withoutEdges, paths, imports);
    assert.equal(stripped.edges_total, 1, "laukiama briauna lieka vardiklyje");
    assert.equal(stripped.edges_rendered_in_mmd, 0);
    assert.ok(stripped.coverage_percent < 100, "iki 2026-09-02 būtent šis atvejis grąžindavo 100 %");
    assert.ok(
      stripped.missing_symbols.includes("src/app/main.ts-->src/lib/helper.ts"),
      `trūkstama briauna privalo būti matoma: ${JSON.stringify(stripped.missing_symbols)}`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Aprėptis ir renderis laukiamų briaunų aibę išveda VIENA funkcija, ne dviem kopijom: kopija
// išsiskirtų tyliai, ir matavimas vėl matuotų save. Šis vartas tikrina rezultatą — generatoriaus
// sugeneruotoje diagramoje kiekviena helper'io grąžinta briauna privalo turėti eilutę.
test("gate: laukiamų briaunų helper'is ir renderis sutaria", async () => {
  const { root, data } = await indexOf({
    "src/lib/a.ts": "export const a = 1;\n",
    "src/lib/b.ts": 'import { a } from "./a.js";\n\nexport const b = a + 1;\n',
    "src/app/main.ts": [
      'import { a } from "../lib/a.js";',
      'import { b } from "../lib/b.js";',
      'import path from "node:path";',
      "",
      "export const main = a + b + path.sep.length;",
      "",
    ].join("\n"),
  });
  try {
    const { symbols, imports, files } = projectCodeMapFromIndex(data);
    const paths = files.map((file) => file.filePath);
    const mermaid = generateCodeMapMermaid(symbols, imports, files);
    const expected = expectedImportEdges(imports, new Set(paths));

    assert.deepEqual(
      expected.map((edge) => `${edge.fromFile}-->${edge.toFile}`).sort(),
      ["src/app/main.ts-->src/lib/a.ts", "src/app/main.ts-->src/lib/b.ts", "src/lib/b.ts-->src/lib/a.ts"],
      "išorinis `node:path` briaunos negauna — jo diagramoje nėra",
    );
    for (const edge of expected) {
      assert.match(mermaid, new RegExp(`${edge.key.replace("-->", " --> ")}`), `renderis praleido ${edge.key}`);
    }

    const coverage = computeCodeMapCoverage(symbols, mermaid, paths, imports);
    assert.equal(coverage.edges_total, expected.length);
    assert.equal(coverage.edges_rendered_in_mmd, expected.length, "sugeneruota diagrama dengia VISAS briaunas");
    assert.equal(coverage.coverage_percent, 100);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
