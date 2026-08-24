// Kalbų grandinė GALAS Į GALĄ: tikri failai → `buildCodeIndex` → `queryCodeGraph` → architektūros
// ribų vartas. Apima ir leksines kalbas (Python, PHP, C#, .NET), ir CommonJS — jos eina skirtingais
// ištraukimo keliais, bet nepadengta grandinės dalis buvo ta pati.
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
import { checkCodeIndexFreshness, readCodeIndex } from "../application/code-intelligence/store/code-index-store.js";
import { isTestPath } from "../application/code-intelligence/indexing/scanner.js";
import type { CodeIntelligenceFileSystemPort } from "../application/code-intelligence/ports.js";
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

// CommonJS eina NE leksiniu, o tuo pačiu `ts.createSourceFile` AST keliu kaip TypeScript, bet
// nepadengta grandinės dalis buvo ta pati: esamas testas kviečia `indexTypeScriptFiles` su FAKE fs,
// tad „`.cjs` faile require ir module.exports davė tuščius imports/exports" tekdavo atsakyti
// skaitymu. Čia — tikri failai diske, tikras `buildCodeIndex`, tikra saugykla.
test("CommonJS `.cjs` faile require ir module.exports duoda importus, eksportus IR briaunas", async () => {
  const root = await world({
    "src/b.cjs": "function helper() {\n  return 1;\n}\nmodule.exports = { helper };\n",
    "src/a.cjs": "const { helper } = require('./b.cjs');\n\nfunction run() {\n  return helper();\n}\nmodule.exports.run = run;\n",
    "src/legacy.js": "const util = require('./b.cjs');\nexports.go = function go() {\n  return util;\n};\n",
  });
  try {
    const index = await readCodeIndex(nodeFsTestPort, root);
    const fileOf = (candidate: string) => index.files.find((file) => file.path === candidate);

    assert.deepEqual(fileOf("src/a.cjs")?.imports, ["src/b.cjs"], "`require` yra importas");
    assert.deepEqual(fileOf("src/a.cjs")?.exports, ["run"], "`module.exports.run` yra eksportas");
    assert.deepEqual(fileOf("src/b.cjs")?.exports, ["helper"], "`module.exports = { helper }` yra eksportas");
    assert.deepEqual(fileOf("src/legacy.js")?.imports, ["src/b.cjs"], "CJS stiliaus `.js` irgi");
    assert.ok(fileOf("src/legacy.js")?.symbols.includes("go"), "`exports.go = function go()` atgauna simbolį");

    // Ir grandinės galas: briauna saugykloje plius užklausa. Be jos indekse importas matytųsi, o
    // grafe jo nebūtų — tiksliai ta pusinė būklė, kurią radinys aprašo.
    assert.ok(
      index.edges.some((edge) => edge.type === "imports" && edge.from === "src/a.cjs" && edge.to === "src/b.cjs"),
      "imports briauna privalo egzistuoti",
    );
    assert.deepEqual((await queryCodeGraph(nodeFsTestPort, root, "src/a.cjs")).imports, ["src/b.cjs"]);

    // INVARIANTAS, kurį uždarė 2026-08-24 auditas: kiekvienas eksportuojamas vardas turi simbolį,
    // nes `exports` briaunos rodo į `failas#vardas`.
    for (const file of ["src/a.cjs", "src/b.cjs", "src/legacy.js"]) {
      const entry = fileOf(file);
      for (const name of entry?.exports ?? []) {
        assert.ok(entry?.symbols.includes(name), `${file}: eksportas ${name} be simbolio duotų kabančią briauną`);
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/** Portas, kuris atsisako perskaityti nurodytus kelius — teisių problema arba lenktynė su trynimu. */
function portRefusing(suffixes: readonly string[]): CodeIntelligenceFileSystemPort {
  return {
    ...nodeFsTestPort,
    readTextFile: async (absolute: string) => {
      const normalized = absolute.split("\\").join("/");
      if (suffixes.some((suffix) => normalized.endsWith(suffix))) {
        throw new Error(`EACCES: ${normalized}`);
      }
      return nodeFsTestPort.readTextFile(absolute);
    },
  };
}

// Leksinio ŠALTINIO skaitymo klaida privalo būti GARSI — kaip TypeScript kelyje.
//
// Iki 2026-08-23 abu keliai naudojo tą pačią tolerantišką funkciją, tad leksinis failas, kurio
// nebepavyko perskaityti, likdavo indekse be importų ir simbolių, o TypeScript failas tokiu atveju
// metė. Dvi to paties gedimo elgsenos viename indekse reiškia, kad pusė jo gali būti tyliai tuščia.
//
// 2026-08-24: patikrinta mutacija — grąžinus rijimą VISI 1614 testų liko žali, tad apsauga buvo
// be sargybinio. Šis testas jį pastato.
test("neperskaitomas leksinis ŠALTINIS nutraukia build'ą, o ne tyliai ištuština failą", async () => {
  const root = await world({ "src/main.py": "def run():\n    return 1\n" });
  try {
    await assert.rejects(
      () => buildCodeIndex(portRefusing(["src/main.py"]), root),
      /EACCES/,
      "pusiau tuščias indeksas, atrodantis pilnas, yra blogiau nei garsi klaida",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ta pati elgsena TypeScript kelyje — vienas gedimas, vienas atsakymas", async () => {
  const root = await world({ "src/main.ts": "export const a = 1;\n" });
  try {
    await assert.rejects(
      () => buildCodeIndex(portRefusing(["src/main.ts"]), root),
      "TypeScript kelias metė visada; leksinis privalo elgtis TAIP PAT",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("neperskaitomas composer.json NĖRA klaida — tolerancija galioja TIK konfigui", async () => {
  const root = await world({
    "composer.json": JSON.stringify({ autoload: { "psr-4": { "App\\": "src/" } } }),
    "src/Service.php": "<?php\nnamespace App;\n\nclass Service {}\n",
  });
  try {
    const index = await buildCodeIndex(portRefusing(["composer.json"]), root);
    assert.ok(
      index.files.some((file) => file.path === "src/Service.php"),
      "be PSR-4 žemėlapio importai tiesiog lieka kvalifikuotais vardais, bet build'as tęsiasi",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// 2026-08-24 (operatoriaus radinys): `src` išdėstymas buvo atpažįstamas TIK repo šaknyje
// (`candidate.startsWith("src/")`), tad monorepo `packages/api/src` šaknimi netapdavo niekada. Su
// neišspręstu importu dingsta VISKAS, kas iš jo auga: briauna, architektūros pažeidimas, testai.
test("monorepo `src` išdėstymas BET KURIAME gylyje yra paketo šaknis", async () => {
  const root = await world({
    "packages/api/src/app/service.py": "def run():\n    return 1\n",
    "packages/api/src/app/main.py": "from app.service import run\n\ndef main():\n    return run()\n",
  });
  try {
    const index = await readCodeIndex(nodeFsTestPort, root);
    assert.deepEqual(
      index.files.find((file) => file.path === "packages/api/src/app/main.py")?.imports,
      ["packages/api/src/app/service.py"],
      "`packages/api/src` yra sys.path įrašas — `src` layout yra dominuojanti Python forma",
    );
    assert.deepEqual(
      (await queryCodeGraph(nodeFsTestPort, root, "packages/api/src/app/main.py")).imports,
      ["packages/api/src/app/service.py"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Antra to paties radinio pusė: iš keturių deklaruotų markerių realiai veikė TIK `setup.py`, nes jis
// vienintelis buvo indeksuojamas plėtinys — likusieji į `knownPaths` nepatekdavo iš principo, ir
// sąrašas apsimetinėjo platesniu, nei buvo.
//
// Sprendimas — juos INDEKSUOTI (`config` kalba), o ne zonduoti atskirai: markeris, keičiantis importų
// prasmę, privalo būti ir indekse, ir jo atspaude. Todėl žemiau tikrinama ir tai, kad jis TEN YRA.
test("pyproject.toml daro katalogą paketo šaknimi ir pats patenka į indeksą", async () => {
  const root = await world({
    "packages/api/pyproject.toml": '[project]\nname = "api"\n',
    "packages/api/app/service.py": "def run():\n    return 1\n",
    "packages/api/app/main.py": "from app.service import run\n",
  });
  try {
    const index = await readCodeIndex(nodeFsTestPort, root);
    const marker = index.files.find((file) => file.path === "packages/api/pyproject.toml");
    assert.equal(marker?.language, "config", "markeris indeksuojamas — būtent todėl jis ir pasendina indeksą");
    assert.deepEqual(marker?.imports, [], "`config` kalba nieko neištraukia; ji tik dalyvauja atspaude");
    assert.deepEqual(
      index.files.find((file) => file.path === "packages/api/app/main.py")?.imports,
      ["packages/api/app/service.py"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// 2026-08-24 (operatoriaus radinys): markeris keičia importų PRASMĘ, tad jo atsiradimas privalo
// pasendinti indeksą. Trumpai buvusi realizacija markerius zondavo per FS portą — jie nebuvo
// indeksuojami, tad rezoliucija pasikeisdavo, o `source_hash` ne, ir indeksas likdavo klaidingai
// „fresh" iki priverstinio perstatymo. Tai sulaužė `computeSourceHash` invariantą: kas veikia
// indeksą, tas privalo būti jo atspaude.
test("pridėtas pyproject.toml PASENDINA indeksą, o ne tyliai pakeičia prasmę", async () => {
  const root = await world({
    "packages/api/app/service.py": "def run():\n    return 1\n",
    "packages/api/app/main.py": "from app.service import run\n",
  });
  try {
    // Prieš markerį `packages/api` nėra paketo šaknis, tad importas teisėtai lieka tekstinis.
    const before = await readCodeIndex(nodeFsTestPort, root);
    assert.deepEqual(
      before.files.find((file) => file.path === "packages/api/app/main.py")?.imports,
      ["app.service"],
      "kontrolė: be markerio šaknies nėra",
    );
    assert.equal((await checkCodeIndexFreshness(nodeFsTestPort, root)).ok, true);

    await writeFile(path.join(root, "packages", "api", "pyproject.toml"), '[project]\nname = "api"\n', "utf8");

    const freshness = await checkCodeIndexFreshness(nodeFsTestPort, root);
    assert.equal(freshness.ok, false, "markeris keičia rezoliuciją — indeksas nebegali būti šviežias");

    await buildCodeIndex(nodeFsTestPort, root);
    const after = await readCodeIndex(nodeFsTestPort, root);
    assert.deepEqual(
      after.files.find((file) => file.path === "packages/api/app/main.py")?.imports,
      ["packages/api/app/service.py"],
      "po perstatymo importas išsprendžiamas",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// 2026-08-24 (operatoriaus radinys): `from . import helper` yra standartinė forma broliškam
// submoduliui pasiekti, bet importuojamų VARDŲ sąrašas buvo ignoruojamas visiškai — sprendžiamas
// tik `module`, kuris tokioje formoje tuščias. Importas virsdavo paketo `__init__.py`, o jo
// neturint — tekstiniu `"."`, ir tikras ryšys dingdavo kartu su pažeidimais bei `impacted_tests`.
test("`from . import helper` išsisprendžia į brolišką submodulį", async () => {
  const root = await world({
    "pkg/__init__.py": "",
    "pkg/helper.py": "def help_me():\n    return 1\n",
    "pkg/main.py": "from . import helper\n\ndef run():\n    return helper.help_me()\n",
  });
  try {
    const index = await readCodeIndex(nodeFsTestPort, root);
    assert.deepEqual(
      index.files.find((file) => file.path === "pkg/main.py")?.imports.sort(),
      ["pkg/__init__.py", "pkg/helper.py"],
      "abu ryšiai tikri: paketo `__init__` įvykdomas, o `helper` yra prašytas submodulis",
    );
    assert.deepEqual(
      (await queryCodeGraph(nodeFsTestPort, root, "pkg/main.py")).imports,
      ["pkg/__init__.py", "pkg/helper.py"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("`from .models import User` NEIŠGALVOJA submodulio iš simbolio vardo", async () => {
  const root = await world({
    "pkg/__init__.py": "",
    "pkg/models.py": "class User:\n    pass\n",
    "pkg/service.py": "from .models import User\n",
  });
  try {
    const index = await readCodeIndex(nodeFsTestPort, root);
    assert.deepEqual(
      index.files.find((file) => file.path === "pkg/service.py")?.imports.sort(),
      ["pkg/models.py"],
      "`User` yra klasė, ne modulis — kandidatas dedamas tik kai toks failas indekse REALIAI yra",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// 2026-08-24 (operatoriaus radinys): `testedBy` vardų atitikimas buvo SUBSTRING'as, tad `src/id.ts`
// prisikabindavo prie `src/grid.test.ts` — „id" yra „grid" viduje. Trumpi vardai (`id`, `db`, `fs`)
// taip susirinkdavo dešimtis nesusijusių testų, o RAG juos siūlydavo kaip paliestus.
test("testedBy vardų atitikimas NEBĖRA substring'as", async () => {
  const root = await world({
    "src/id.ts": "export const id = 1;\n",
    "src/grid.ts": "export const grid = 2;\n",
    "src/grid.test.ts": "export const checked = true;\n",
    "src/id.test.ts": "export const checkedId = true;\n",
  });
  try {
    const index = await readCodeIndex(nodeFsTestPort, root);
    const testsOf = (source: string): string[] =>
      index.edges.filter((edge) => edge.type === "testedBy" && edge.from === source).map((edge) => edge.to).sort();

    assert.deepEqual(testsOf("src/id.ts"), ["src/id.test.ts"], "`grid.test.ts` NĖRA `id.ts` testas");
    assert.deepEqual(testsOf("src/grid.ts"), ["src/grid.test.ts"]);
    assert.deepEqual(
      (await queryCodeGraph(nodeFsTestPort, root, "src/id.ts")).impacted_tests,
      ["src/id.test.ts"],
      "netikra briauna būtų plitusi dar ir per importuotojų uždarinį",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("testedBy atpažįsta kiekvienos kalbos ĮRANKIO konvenciją be substring'o", async () => {
  const root = await world({
    "src/main.py": "def run():\n    return 1\n",
    "src/test_main.py": "def test_run():\n    assert True\n",
    "src/Repo.php": "<?php\nclass Repo {}\n",
    "src/RepoTest.php": "<?php\nclass RepoTest {}\n",
    "src/Users.cs": "public class Users { }\n",
    "src/UsersTests.cs": "public class UsersTests { }\n",
  });
  try {
    const index = await readCodeIndex(nodeFsTestPort, root);
    const testsOf = (source: string): string[] =>
      index.edges.filter((edge) => edge.type === "testedBy" && edge.from === source).map((edge) => edge.to).sort();

    assert.deepEqual(testsOf("src/main.py"), ["src/test_main.py"], "pytest `test_<vardas>`");
    assert.deepEqual(testsOf("src/Repo.php"), ["src/RepoTest.php"], "PHPUnit `<Vardas>Test`");
    assert.deepEqual(testsOf("src/Users.cs"), ["src/UsersTests.cs"], "xUnit `<Vardas>Tests`");
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
