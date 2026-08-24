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

// 2026-08-23 (operatoriaus radinys): simbolių ID nebuvo unikalūs. TypeScript overload'ai duodavo
// TRIS identiškus `src/over.ts#over`, o C# įdėtinis ir top-level `Inner` — du `src/X.cs#Inner`.
// ID yra TAPATYBĖ: du įrašai tuo pačiu ID reiškia dvi `declares` briaunas į tą patį mazgą, t. y.
// indeksą, kuris pats nesilaiko savo taisyklės.
//
// Testas tikrina INVARIANTĄ visoms kalboms, o ne du pataisytus atvejus: kiekvienas naujas
// ištraukėjas jį paveldi automatiškai.
test("gate: simbolių ID unikalūs VISOSE kalbose", () => {
  const cases: { path: string; language: CodeIndexLanguage; text: string }[] = [
    {
      path: "src/X.cs",
      language: "csharp",
      text: "public class Outer\n{\n    public class Inner { }\n}\n\npublic class Inner { }\n",
    },
    { path: "src/dup.py", language: "python", text: "def f():\n    pass\n\ndef f():\n    pass\n" },
    { path: "src/Dup.php", language: "php", text: "<?php\nclass A {}\nconst A = 1;\n" },
    {
      path: "src/Dup.csproj",
      language: "dotnet",
      text: '<Project><Target Name="Build" /><Target Name="Build" /></Project>',
    },
  ];

  for (const testCase of cases) {
    const result = indexLexicalSource(fileOf(testCase.path, testCase.language), testCase.text, CONTEXT);
    assert.ok(result, testCase.language);

    const ids = result.symbols.map((symbol) => symbol.id);
    assert.equal(new Set(ids).size, ids.length, `${testCase.language}: pasikartojantys ID ${ids.join(", ")}`);

    // Ta pati taisyklė briaunoms: `declares` privalo būti po vieną kiekvienam simboliui.
    const declares = result.edges.filter((edge) => edge.type === "declares").map((edge) => edge.to);
    assert.equal(new Set(declares).size, declares.length, `${testCase.language}: dublikuotos declares briaunos`);
  }

  // C# atveju teisingas atsakymas yra KVALIFIKUOTI, o ne sulieti: `Outer.Inner` ir `Inner` yra
  // du SKIRTINGI tipai, ir indeksas privalo juos atskirti.
  const csharp = indexLexicalSource(fileOf("src/X.cs", "csharp"), cases[0]?.text ?? "", CONTEXT);
  assert.deepEqual(
    csharp?.symbols.map((symbol) => symbol.name),
    ["Outer", "Outer.Inner", "Inner"],
    "įdėtinis tipas kvalifikuojamas savininku, o ne suliejamas su bendravardžiu",
  );
});

// 2026-08-23 (operatoriaus radinys): JavaScript buvo pažymėtas pilnai aktyviu, bet CommonJS
// nepalaikomas. ESM `import`/`export` yra DEKLARACIJOS — indeksuotojas jas atpažįsta iš mazgo tipo;
// `require()` yra kvietimas, o `module.exports =` — priskyrimas. Todėl `.cjs` failai grąžindavo
// tuščius `imports`/`exports`, o `exports.go = function go() {}` prarasdavo net simbolį.
test("CommonJS: require, module.exports ir exports.x", async () => {
  const { indexTypeScriptFiles } = await import("../application/code-intelligence/indexing/ts-indexer.js");
  const sources: Record<string, string> = {
    "src/b.cjs": "function helper() { return 1; }\nmodule.exports = { helper };\n",
    "src/a.cjs": "const { helper } = require('./b.cjs');\nfunction run() { return helper(); }\nmodule.exports.run = run;\n",
    "src/legacy.js": "const util = require('./b.cjs');\nexports.go = function go() { return util; };\n",
    "src/esm.mjs": "import { helper } from './b.cjs';\nexport const go = () => helper();\n",
  };

  const scanned = Object.keys(sources).map((path) => fileOf(path, "javascript"));
  const fs = {
    readTextFile: (absolute: string) => {
      const key = Object.keys(sources).find((path) => absolute.split("\\").join("/").endsWith(path));
      return key === undefined ? Promise.reject(new Error(absolute)) : Promise.resolve(sources[key] as string);
    },
  };

  const indexed = await indexTypeScriptFiles(fs as never, "/repo", scanned);
  const of = (path: string) => indexed.get(path)?.file;

  assert.deepEqual(of("src/b.cjs")?.exports, ["helper"], "`module.exports = { helper }` yra eksportas");
  assert.deepEqual(of("src/a.cjs")?.imports, ["src/b.cjs"], "`require` yra importas");
  assert.deepEqual(of("src/a.cjs")?.exports, ["run"], "`module.exports.run` yra eksportas");
  assert.deepEqual(of("src/legacy.js")?.imports, ["src/b.cjs"], "CJS stiliaus `.js` irgi");
  assert.ok(of("src/legacy.js")?.symbols.includes("go"), "`exports.go = function go()` atgauna SIMBOLĮ");
  assert.deepEqual(of("src/esm.mjs")?.imports, ["src/b.cjs"], "ESM kelias nepaliestas");

  // Kiekvienas eksportas privalo turėti simbolį: `exports` briaunos rodo į `failas#vardas`.
  for (const path of Object.keys(sources)) {
    const file = of(path);
    for (const name of file?.exports ?? []) {
      assert.ok(file?.symbols.includes(name), `${path}: eksportas ${name} be simbolio duotų kabančią briauną`);
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

// 2026-08-24 (operatoriaus radinys): `exported_symbols` grąžindavo PASIEKIAMUS simbolius, ne viešus
// vardus. `export { local as renamed }` pažymi `local` pasiekiamu (jį realiai galima gauti — tik ne
// tuo vardu), tad užklausa grąžindavo abu; tas pats liesdavo eksportuotų klasių narius.
test("exported_symbols grąžina VIEŠUS vardus, ne paslėptus aliasus", () => {
  const data = {
    manifest: {},
    files: [
      {
        ...fileOf("src/a.ts", "typescript"),
        exports: ["renamed", "Service"],
        symbols: ["local", "renamed", "Service", "Service.run"],
      },
    ],
    symbols: [
      { id: "src/a.ts#local", file: "src/a.ts", name: "local", kind: "function", exported: true },
      { id: "src/a.ts#renamed", file: "src/a.ts", name: "renamed", kind: "function", exported: true },
      { id: "src/a.ts#Service", file: "src/a.ts", name: "Service", kind: "class", exported: true },
      { id: "src/a.ts#Service.run", file: "src/a.ts", name: "Service.run", kind: "function", exported: true },
    ],
    edges: [],
  } as unknown as CodeIndexData;

  assert.deepEqual(
    queryCodeGraphData(data, "src/a.ts").exported_symbols,
    ["src/a.ts#Service", "src/a.ts#renamed"],
    "`local` importuotojas įvardyti negali, o `Service.run` yra narys, ne modulio eksportas",
  );
});

// 2026-08-23 (RAG auditas 3): `impacted_tests` matė TIK tiesioginius testus.
//
// `testedBy` briauna gimsta ten, kur testas realiai importuoja. Grandinėje
// `core.ts → index.ts → behavior.test.ts` ji priklauso barrel'iui, tad užklausa apie `core.ts`
// grąžindavo tuščią sąrašą — o barrel'is ar tarpinis servisas yra ne išimtis, o įprasta forma.
test("impacted_tests randa testą PER barrel'į", () => {
  const data = {
    manifest: {},
    files: [fileOf("src/core.ts", "typescript"), fileOf("src/index.ts", "typescript"), fileOf("src/behavior.test.ts", "typescript")],
    symbols: [],
    edges: [
      { from: "src/index.ts", to: "src/core.ts", type: "imports" as const },
      { from: "src/behavior.test.ts", to: "src/index.ts", type: "imports" as const },
      { from: "src/index.ts", to: "src/behavior.test.ts", type: "testedBy" as const },
    ],
  } as unknown as CodeIndexData;

  assert.deepEqual(
    queryCodeGraphData(data, "src/core.ts").impacted_tests,
    ["src/behavior.test.ts"],
    "netiesioginis testas yra tikras testas — tik pasiekiamas per importuotoją",
  );
});
