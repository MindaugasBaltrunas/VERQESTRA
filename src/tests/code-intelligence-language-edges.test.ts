// 2026-08-23 (operatoriaus radinys): naujieji kalbų ištraukėjai nekūrė GRAFO BRIAUNŲ.
//
// `file.imports` ir simboliai būdavo užpildyti, bet `edges` grįždavo tuščias. `code-graph` ir
// architektūros ribų vartas skaito BŪTENT `imports` briaunas (`architecture-boundary`:
// `if (edge.type !== "imports") continue`), tad naujos kalbos indekse matėsi, o grafe jų nebuvo —
// funkcionalumas veikė tik iš pusės.
//
// Šis failas tikrina ne ištraukėjus (tai daro `code-intelligence-language-indexers`), o GRANDINĘ:
// ar iš `imports` gimsta briauna ir ar tą briauną mato tikras vartotojas.
import assert from "node:assert/strict";
import test from "node:test";
import { indexLexicalSource } from "../application/code-intelligence/indexing/language-indexer.js";
import { findArchitectureBoundaryViolations } from "../application/code-intelligence/boundary/architecture-boundary.js";
import { isTestPath as isTestFilePath } from "../application/code-intelligence/indexing/scanner.js";
import { queryCodeGraphData } from "../application/code-intelligence/query/query.js";
import type { CodeIndexData, CodeIndexFile, CodeIndexLanguage } from "../application/code-intelligence/indexing/types.js";

function fileOf(path: string, language: CodeIndexLanguage): CodeIndexFile {
  return { path, hash: "h", size: 0, language, kind: "source", imports: [], exports: [], symbols: [], isTest: false };
}

const CONTEXT = { knownPaths: new Set<string>(["src/application/service.py", "src/domain/rules.py"]), psr4: new Map() };

test("kiekviena leksinė kalba duoda imports/declares/exports briaunas", () => {
  const cases: { path: string; language: CodeIndexLanguage; text: string; expectImport: string }[] = [
    { path: "src/domain/rules.py", language: "python", text: "from ..application.service import run\n\ndef rule():\n    pass\n", expectImport: "src/application/service.py" },
    { path: "src/domain/Rules.php", language: "php", text: "<?php\nuse Vendor\\Thing;\nclass Rules {}\n", expectImport: "Vendor\\Thing" },
    { path: "src/domain/Rules.cs", language: "csharp", text: "using System;\npublic class Rules { }\n", expectImport: "System" },
    { path: "src/domain/Domain.csproj", language: "dotnet", text: '<Project Sdk="Microsoft.NET.Sdk" />', expectImport: "Microsoft.NET.Sdk" },
  ];

  for (const testCase of cases) {
    const result = indexLexicalSource(fileOf(testCase.path, testCase.language), testCase.text, CONTEXT);
    assert.ok(result, `${testCase.language}: ištraukėjas privalo atsakyti`);

    const imports = result.edges.filter((edge) => edge.type === "imports");
    assert.ok(
      imports.some((edge) => edge.from === testCase.path && edge.to === testCase.expectImport),
      `${testCase.language}: laukta imports briauna ${testCase.path} -> ${testCase.expectImport}`,
    );
    assert.equal(imports.length, result.file.imports.length, `${testCase.language}: kiekvienas importas turi briauną`);
    assert.equal(
      result.edges.filter((edge) => edge.type === "declares").length,
      result.symbols.length,
      `${testCase.language}: kiekvienas simbolis deklaruojamas`,
    );

    // `exports` briaunos privalo rodyti į TIKRUS simbolių ID: būtent todėl eksportai laikomi
    // plikais vardais, o ne kvalifikuoti namespace'u.
    const symbolIds = new Set(result.symbols.map((symbol) => symbol.id));
    for (const edge of result.edges.filter((entry) => entry.type === "exports")) {
      assert.ok(symbolIds.has(edge.to), `${testCase.language}: exports briauna rodo į nesamą simbolį ${edge.to}`);
    }
  }
});

// 2026-08-23 (operatoriaus radinys): daugiakalbiai testai buvo prarandami DVIEM nepriklausomais
// būdais, tad net rankiniu būdu pateikus galiojančią briauną `impacted_tests` grįždavo tuščias.
test("testų atpažinimas seka kiekvienos kalbos ĮRANKIO konvenciją", () => {
  const cases: [string, boolean][] = [
    // pytest `python_files` numatytoji reikšmė yra `test_*.py *_test.py` — abi formos.
    ["src/test_main.py", true],
    ["src/main_test.py", true],
    ["src/main.py", false],
    // `test_.py` be vardo NĖRA įprasta forma, bet ir ji yra testas — svarbu, kad `test_main.py`
    // nustotų būti vienintele nepatenkančia.
    ["src/util.test.mjs", true],
    ["src/util.test.cjs", true],
    ["src/util.spec.jsx", true],
    ["app/ServiceTest.php", true],
    ["app/Service.php", false],
    ["src/UsersTests.cs", true],
    ["src/Users.cs", false],
    ["tests/anything.py", true],
  ];

  for (const [candidate, expected] of cases) {
    assert.equal(
      isTestFilePath(candidate),
      expected,
      `${candidate}: laukta isTest=${String(expected)}`,
    );
  }
});

test("architektūros ribų vartas MATO ne-TypeScript pažeidimą", () => {
  // Python domain'as importuoja application — tiksliai tai, ką draudžia šio repo politika.
  const violating = indexLexicalSource(
    fileOf("src/domain/rules.py", "python"),
    "from ..application.service import run\n",
    CONTEXT,
  );
  assert.ok(violating);

  const index = {
    manifest: {},
    files: [violating.file],
    symbols: violating.symbols,
    edges: violating.edges,
  } as unknown as CodeIndexData;

  const violations = findArchitectureBoundaryViolations(index, {
    layers: ["domain", "application"],
    forbidden_dependencies: ["domain -> application"],
  });

  assert.deepEqual(
    violations.map((violation) => [violation.from, violation.to, violation.fromLayer, violation.toLayer]),
    [["src/domain/rules.py", "src/application/service.py", "domain", "application"]],
    "be briaunų šis pažeidimas buvo NEMATOMAS — vartas skaito tik imports briaunas",
  );
});

// Antrasis to paties radinio kelias: `impacted_tests` filtravo rezultatą iki `.ts`/`.tsx`, tad net
// esant galiojančiai `testedBy` briaunai užklausa grąžindavo tuščią sąrašą. Filtras buvo likutis iš
// laiko, kai indeksas pažinojo tik TypeScript'ą; briaunos TIPAS jau sako, kad taikinys yra testas.
test("impacted_tests grąžina VISŲ kalbų testus, ne tik TypeScript", () => {
  const data = {
    manifest: {},
    files: [fileOf("src/main.py", "python"), fileOf("src/test_main.py", "python")],
    symbols: [],
    edges: [{ from: "src/main.py", to: "src/test_main.py", type: "testedBy" as const }],
  } as unknown as CodeIndexData;

  assert.deepEqual(
    queryCodeGraphData(data, "src/main.py").impacted_tests,
    ["src/test_main.py"],
    "Python testas privalo pasiekti užklausos rezultatą",
  );
});
