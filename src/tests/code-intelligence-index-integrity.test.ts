// 2026-08-23 RAG auditas 3 — indekso VIENTISUMAS ir jo APIMTIS.
//
// Du nepriklausomi būdai, kuriais „fresh: true" indeksas galėjo meluoti:
//   1. Saugyklą galima buvo redaguoti nekeičiant įrašų skaičiaus. Schemos ir kiekiai praeidavo,
//      o pakeista `imports` briauna tyliai panaikindavo architektūros pažeidimą.
//   2. Skeneris tyliai išmesdavo teisėtą produkto kodą: `bin`, `obj`, `dist` ir `vendor` buvo
//      ignoruojami BET KURIAME gylyje, tad `src/bin/cli.ts` į indeksą nepatekdavo — o indeksas
//      vis tiek vadindavosi šviežiu, ir užklausa grąžindavo tuščią rezultatą be jokios žymos.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildCodeIndex } from "../application/code-intelligence/indexing/builder.js";
import { checkCodeIndexFreshness, codeIndexPath } from "../application/code-intelligence/store/code-index-store.js";
import { findArchitectureBoundaryViolations } from "../application/code-intelligence/boundary/architecture-boundary.js";
import { nodeFsTestPort } from "./helpers/node-fs-port.js";
import type { CodeIndexEdge } from "../application/code-intelligence/indexing/types.js";

const POLICY = { layers: ["domain", "application"], forbidden_dependencies: ["domain -> application"] };

async function temporaryRoot(prefix: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

test("briaunos TAIKINIO pakeitimas nekeičiant kiekių NEBEPRAEINA kaip šviežias", async () => {
  const root = await temporaryRoot("vq-records-hash-");
  try {
    await mkdir(path.join(root, "src", "domain"), { recursive: true });
    await mkdir(path.join(root, "src", "application"), { recursive: true });
    await writeFile(path.join(root, "src", "application", "service.py"), "def run():\n    return 1\n", "utf8");
    await writeFile(path.join(root, "src", "domain", "rules.py"), "from ..application.service import run\n", "utf8");
    const index = await buildCodeIndex(nodeFsTestPort, root);

    assert.equal(findArchitectureBoundaryViolations(index, POLICY).length, 1, "kontrolė: pažeidimas matomas");
    assert.equal((await checkCodeIndexFreshness(nodeFsTestPort, root)).ok, true);

    // Reprodukcija: viena briauna nukreipiama į nesamą taikinį. Įrašų KIEKIS nesikeičia, schema
    // praeina — būtent todėl kiekių tikrinimo nepakako.
    const edgesPath = codeIndexPath(root, "edges.jsonl");
    const edges = (await readFile(edgesPath, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as CodeIndexEdge);
    const tampered = edges.map((edge) =>
      edge.type === "imports" && edge.to === "src/application/service.py" ? { ...edge, to: "src/domain/rules.py" } : edge,
    );
    assert.equal(tampered.length, edges.length, "reprodukcija privalo išlaikyti įrašų skaičių");
    await writeFile(edgesPath, `${tampered.map((edge) => JSON.stringify(edge)).join("\n")}\n`, "utf8");

    const freshness = await checkCodeIndexFreshness(nodeFsTestPort, root);
    assert.equal(freshness.ok, false, "redaguota saugykla NEGALI būti laikoma šviežia");
    assert.match(
      freshness.ok ? "" : freshness.reason,
      /fingerprint/,
      "priežastis įvardija ATSPAUDĄ, o ne kiekius — gedimas kitoks",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("src/bin ir src/dist yra produkto kodas, o ne build'o išvestis", async () => {
  const root = await temporaryRoot("vq-scan-scope-");
  try {
    await mkdir(path.join(root, "src", "bin"), { recursive: true });
    await mkdir(path.join(root, "src", "dist"), { recursive: true });
    await mkdir(path.join(root, "src", "obj"), { recursive: true });
    await mkdir(path.join(root, "src", "vendor"), { recursive: true });
    await writeFile(path.join(root, "src", "bin", "cli.ts"), "export const cli = 1;\n", "utf8");
    await writeFile(path.join(root, "src", "dist", "shipped.ts"), "export const shipped = 1;\n", "utf8");
    await writeFile(path.join(root, "src", "obj", "model.ts"), "export const model = 1;\n", "utf8");
    await writeFile(path.join(root, "src", "vendor", "adapter.ts"), "export const adapter = 1;\n", "utf8");

    const index = await buildCodeIndex(nodeFsTestPort, root);
    assert.deepEqual(
      index.files.map((file) => file.path).sort(),
      ["src/bin/cli.ts", "src/dist/shipped.ts", "src/obj/model.ts", "src/vendor/adapter.ts"],
      "be manifesto kaimyno šie katalogai yra eiliniai šaltinio katalogai",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("build'o išvestis atpažįstama pagal ŠALIA gulintį manifestą", async () => {
  const root = await temporaryRoot("vq-scan-build-out-");
  try {
    // `package.json` šalia `dist/` — tai JS build'o išvestis.
    await mkdir(path.join(root, "app", "dist"), { recursive: true });
    await writeFile(path.join(root, "app", "package.json"), '{"name":"app"}\n', "utf8");
    await writeFile(path.join(root, "app", "dist", "bundle.js"), "export const bundled = 1;\n", "utf8");
    await writeFile(path.join(root, "app", "main.ts"), "export const main = 1;\n", "utf8");

    // `.csproj` šalia `bin/` ir `obj/` — tai .NET build'o išvestis.
    await mkdir(path.join(root, "svc", "bin"), { recursive: true });
    await mkdir(path.join(root, "svc", "obj"), { recursive: true });
    await writeFile(path.join(root, "svc", "Svc.csproj"), '<Project Sdk="Microsoft.NET.Sdk" />\n', "utf8");
    await writeFile(path.join(root, "svc", "bin", "Generated.cs"), "public class Generated { }\n", "utf8");
    await writeFile(path.join(root, "svc", "obj", "Assembly.cs"), "public class Assembly { }\n", "utf8");
    await writeFile(path.join(root, "svc", "Service.cs"), "public class Service { }\n", "utf8");

    const index = await buildCodeIndex(nodeFsTestPort, root);
    const indexed = index.files.map((file) => file.path).sort();
    assert.deepEqual(
      indexed,
      ["app/main.ts", "app/package.json", "svc/Service.cs", "svc/Svc.csproj"],
      "generuoti medžiai lieka už indekso ribų, o produkto kodas — indekse",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("architektūros vartas mato C# NAMESPACE pažeidimą, ne tik kelią", async () => {
  const root = await temporaryRoot("vq-csharp-boundary-");
  try {
    await mkdir(path.join(root, "src", "domain"), { recursive: true });
    await mkdir(path.join(root, "src", "infrastructure"), { recursive: true });
    await writeFile(
      path.join(root, "src", "domain", "Rules.cs"),
      "using Company.Infrastructure;\n\nnamespace Company.Domain;\n\npublic class Rules { }\n",
      "utf8",
    );
    await writeFile(
      path.join(root, "src", "infrastructure", "Repo.cs"),
      "namespace Company.Infrastructure;\n\npublic class Repo { }\n",
      "utf8",
    );

    const index = await buildCodeIndex(nodeFsTestPort, root);
    const violations = findArchitectureBoundaryViolations(index, {
      layers: ["domain", "infrastructure"],
      forbidden_dependencies: ["domain -> infrastructure"],
    });

    assert.deepEqual(
      violations.map((violation) => [violation.from, violation.to, violation.fromLayer, violation.toLayer]),
      [["src/domain/Rules.cs", "Company.Infrastructure", "domain", "infrastructure"]],
      "namespace segmentas yra sluoksnio vardas — kitaip vartas C# pusėje yra fail-open",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("stdlib vardo NEUŽGOŽIA bet kur repo gulintis to paties vardo failas", async () => {
  const root = await temporaryRoot("vq-python-roots-");
  try {
    await mkdir(path.join(root, "src", "infrastructure"), { recursive: true });
    await mkdir(path.join(root, "src", "domain"), { recursive: true });
    await writeFile(path.join(root, "src", "infrastructure", "json.py"), "def dumps():\n    return 1\n", "utf8");
    await writeFile(path.join(root, "src", "domain", "rules.py"), "import json\n", "utf8");

    const index = await buildCodeIndex(nodeFsTestPort, root);
    const rules = index.files.find((file) => file.path === "src/domain/rules.py");
    assert.deepEqual(
      rules?.imports,
      ["json"],
      "`src/infrastructure` nėra sys.path įrašas — susiejimas su juo būtų išgalvota briauna",
    );
    assert.equal(
      findArchitectureBoundaryViolations(index, {
        layers: ["domain", "infrastructure"],
        forbidden_dependencies: ["domain -> infrastructure"],
      }).length,
      0,
      "netikras ryšys duotų netikrą pažeidimą — o jis reikalauja veiksmo",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("absoliutus Python importas VIS TIEK išsisprendžia nuo paketo šaknies", async () => {
  const root = await temporaryRoot("vq-python-rooted-");
  try {
    await mkdir(path.join(root, "src", "app"), { recursive: true });
    await writeFile(path.join(root, "pyproject.toml"), "[project]\nname = \"demo\"\n", "utf8");
    await writeFile(path.join(root, "src", "app", "models.py"), "class User:\n    pass\n", "utf8");
    await writeFile(path.join(root, "src", "app", "service.py"), "from app.models import User\n", "utf8");

    const index = await buildCodeIndex(nodeFsTestPort, root);
    assert.deepEqual(
      index.files.find((file) => file.path === "src/app/service.py")?.imports,
      ["src/app/models.py"],
      "`src/` yra tikra paketo šaknis, tad ryšys yra įrodytas",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
