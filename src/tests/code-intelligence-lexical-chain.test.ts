// Leksinių kalbų grandinė GALAS Į GALĄ: tikri failai → `buildCodeIndex` → `queryCodeGraph` →
// architektūros ribų vartas.
//
// Esami testai dengia dalis atskirai: `code-intelligence-language-indexers` tikrina ištraukėjus,
// `code-intelligence-language-edges` — `indexLexicalSource` išvestį ir `queryCodeGraphData` su
// rankomis sudėtais duomenimis. Nė vienas nepraeina VISO kelio per realų build'ą ir realią saugyklą,
// o būtent taip formuluojama reprodukcija: „Python faile imports=[...], bet imports briaunos ir
// query.imports buvo tušti". Ši grandinė turi savo testą, kad tvirtinimas būtų patikrinamas, o ne
// atsakomas iš atminties.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildCodeIndex } from "../application/code-intelligence/indexing/builder.js";
import { queryCodeGraph } from "../application/code-intelligence/query/query.js";
import { findArchitectureBoundaryViolations } from "../application/code-intelligence/boundary/architecture-boundary.js";
import { readCodeIndex } from "../application/code-intelligence/store/code-index-store.js";
import { isTestPath } from "../application/code-intelligence/indexing/scanner.js";
import { nodeFsTestPort } from "./helpers/node-fs-port.js";

async function world(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "vq-lexical-chain-"));
  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(root, ...relative.split("/"));
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, content, "utf8");
  }
  await buildCodeIndex(nodeFsTestPort, root);
  return root;
}

test("Python importas duoda IMPORTS briauną ir pasiekia query.imports", async () => {
  const root = await world({
    "src/helper.py": "def help_me():\n    return 1\n",
    "src/main.py": "from .helper import help_me\n\ndef run():\n    return help_me()\n",
  });
  try {
    const index = await readCodeIndex(nodeFsTestPort, root);
    assert.deepEqual(
      index.files.find((file) => file.path === "src/main.py")?.imports,
      ["src/helper.py"],
      "kontrolė: importas išspręstas",
    );
    assert.ok(
      index.edges.some(
        (edge) => edge.type === "imports" && edge.from === "src/main.py" && edge.to === "src/helper.py",
      ),
      `imports briaunos nėra: ${JSON.stringify(index.edges.filter((edge) => edge.type === "imports"))}`,
    );

    const query = await queryCodeGraph(nodeFsTestPort, root, "src/main.py");
    assert.deepEqual(query.imports, ["src/helper.py"], "briauna privalo pasiekti užklausos rezultatą");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("PHP, C# ir .NET taip pat duoda imports briaunas per realų build'ą", async () => {
  const root = await world({
    "composer.json": JSON.stringify({ autoload: { "psr-4": { "App\\": "src/" } } }),
    "src/Service.php": "<?php\nnamespace App;\n\nuse App\\Repo;\n\nclass Service {}\n",
    "src/Repo.php": "<?php\nnamespace App;\n\nclass Repo {}\n",
    "src/Rules.cs": "using System;\n\npublic class Rules { }\n",
    "src/App.csproj": '<Project Sdk="Microsoft.NET.Sdk" />',
  });
  try {
    const index = await readCodeIndex(nodeFsTestPort, root);
    const importsOf = (file: string): string[] =>
      index.edges.filter((edge) => edge.type === "imports" && edge.from === file).map((edge) => edge.to);

    assert.deepEqual(importsOf("src/Service.php"), ["src/Repo.php"], "PSR-4 išspręstas importas → briauna");
    assert.deepEqual(importsOf("src/Rules.cs"), ["System"], "C# namespace lieka tekstu, bet briauna YRA");
    assert.deepEqual(importsOf("src/App.csproj"), ["Microsoft.NET.Sdk"], ".NET projektas irgi");

    // Ir `declares` briaunos: kiekvienas simbolis turi po vieną.
    for (const file of ["src/Service.php", "src/Rules.cs"]) {
      const symbols = index.symbols.filter((symbol) => symbol.file === file);
      const declares = index.edges.filter((edge) => edge.type === "declares" && edge.from === file);
      assert.equal(declares.length, symbols.length, `${file}: kiekvienas simbolis deklaruojamas`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("test_main.py UŽ tests/ katalogo ribų yra testas ir pasiekia impacted_tests", async () => {
  // Abu radinio keliai vienu metu: (1) ar `isTestPath` atpažįsta standartinę pytest formą už
  // `tests/` ribų, (2) ar `testedBy` briauna pereina užklausą be plėtinių filtro.
  assert.equal(isTestPath("src/test_main.py"), true, "dažniausia pytest forma");
  assert.equal(isTestPath("src/main_test.py"), true, "antroji pytest forma");

  const root = await world({
    "src/main.py": "def run():\n    return 1\n",
    "src/test_main.py": "from .main import run\n\ndef test_run():\n    assert run() == 1\n",
  });
  try {
    const index = await readCodeIndex(nodeFsTestPort, root);
    assert.equal(
      index.files.find((file) => file.path === "src/test_main.py")?.isTest,
      true,
      "kontrolė: failas indekse pažymėtas testu",
    );
    assert.ok(
      index.edges.some((edge) => edge.type === "testedBy" && edge.from === "src/main.py"),
      "testedBy briauna privalo egzistuoti",
    );

    const query = await queryCodeGraph(nodeFsTestPort, root, "src/main.py");
    assert.deepEqual(query.impacted_tests, ["src/test_main.py"], "Python testas privalo pasiekti impacted_tests");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("architektūros vartas mato leksinės kalbos pažeidimą per realų build'ą", async () => {
  const root = await world({
    "src/application/service.py": "def run():\n    return 1\n",
    "src/domain/rules.py": "from ..application.service import run\n\ndef decide():\n    return run()\n",
  });
  try {
    const violations = findArchitectureBoundaryViolations(await readCodeIndex(nodeFsTestPort, root), {
      layers: ["domain", "application"],
      forbidden_dependencies: ["domain -> application"],
    });
    assert.deepEqual(
      violations.map((violation) => [violation.from, violation.to]),
      [["src/domain/rules.py", "src/application/service.py"]],
      "vartas skaito imports briaunas — be jų pažeidimas būtų nematomas",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
