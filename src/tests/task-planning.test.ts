// Task planavimo klasterio testai (VQ-305 3/3-g): spec-source rezoliucija, queue task
// renderis, taskGenerate numeracija (DUP-14) ir openspec konteksto ištrauka.

import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { taskGenerate, nextAvailableTaskNumber, type TaskGeneratePorts } from "../application/task-planning/generate.js";
import {
  analyzeDeclaredOpenSpecReferences,
  analyzeOpenSpecReferences,
  buildOpenSpecContext,
  type OpenSpecContextPorts,
} from "../application/task-planning/openspec-context.js";
import { agentChainForTitle, inferAllowedPaths } from "../application/task-planning/queue-task.js";
import { findOpenSpecTaskPlan } from "../application/task-planning/spec-source.js";

const ROOT = path.resolve("/repo");
const abs = (rel: string): string => path.join(ROOT, rel).replace(/\\/g, "/");
const norm = (p: string): string => p.replace(/\\/g, "/");

function makePorts(files: Map<string, string>): TaskGeneratePorts {
  return {
    fs: {
      exists: async (p) => files.has(norm(p)),
      readTextFileIfExists: async (p) => files.get(norm(p)),
      listSubdirectories: async (dir) => {
        const prefix = `${norm(dir)}/`;
        const names = new Set<string>();
        for (const key of files.keys()) {
          if (key.startsWith(prefix) && key.slice(prefix.length).includes("/")) {
            names.add(key.slice(prefix.length).split("/")[0]!);
          }
        }
        return [...names];
      },
      listFiles: async (dir) => {
        const prefix = `${norm(dir)}/`;
        return [...files.keys()]
          .filter((key) => key.startsWith(prefix) && !key.slice(prefix.length).includes("/"))
          .map((key) => key.slice(prefix.length));
      },
      makeDirectory: async () => {},
      writeFileExclusive: async (p, content) => {
        if (files.has(norm(p))) return "exists";
        files.set(norm(p), content);
        return "created";
      },
    },
  };
}

test("findOpenSpecTaskPlan atmeta nesaugų change id ir reikalauja spec/tasks failų", async () => {
  const files = new Map<string, string>([
    [abs("AG/openspec/changes/my-change/spec.md"), "# Spec"],
    [abs("AG/openspec/changes/my-change/tasks.md"), "- [ ] A"],
  ]);
  const ports = makePorts(files);
  const plan = await findOpenSpecTaskPlan(ports.fs, ROOT, "AG/openspec/changes/my-change/");
  assert.equal(plan.id, "my-change");
  assert.equal(plan.relativeSpecPath, "openspec/changes/my-change");
  await assert.rejects(() => findOpenSpecTaskPlan(ports.fs, ROOT, "../evil"), /Invalid OpenSpec change id/);
  await assert.rejects(() => findOpenSpecTaskPlan(ports.fs, ROOT, "nesamas"), /OpenSpec spec missing/);
});

test("queue-task: klasifikacija parenka grandinę, o routine scope lieka broad", () => {
  assert.deepEqual(agentChainForTitle("Refactor architecture boundary schema"), [
    "readme-guard",
    "architect",
    "coder",
    "reviewer",
  ]);
  const broad = inferAllowedPaths("Visiškai neutralus darbas be raktažodžių");
  assert.equal(broad.isBroad, true);
  // VQ-703: variklio šaknis yra `src`, ne etalono `AG/orchestrator`. Sugeneruota užduotis su
  // riba į neegzistuojantį katalogą duotų agentui leidimą niekam.
  assert.deepEqual(broad.paths, ["src/**"]);
});

// 2026-08-24 (rasta tikrinant operatoriaus grafo auditą): `ENGINE_SOURCE_ROOT` prefiksas buvo
// taikomas VISIEMS ne-`AG/` klasifikacijos fragmentams, nors tie fragmentai jau yra repo-relative.
// Rezultatas — keliai, kurių nėra, t. y. „leidimas niekam": penkios iš 13 eilės užduočių (003, 005,
// 009, 013, 014) turėjo scope, kurio NĖ VIENAS kelias neegzistuoja.
//
// Prefiksas buvo įvestas VQ-703 dėl etalono `AG/orchestrator`, bet tas fragmentas prasideda `AG/`
// ir į prefiksuojamą šaką NIEKADA nepateko — jis nesprendė problemos, kuriai buvo įvestas.
test("inferAllowedPaths: klasifikacijos fragmentai NEPREFIKSUOJAMI antrą kartą", () => {
  const release = inferAllowedPaths("Įtraukti release-check į ci workflow kaip atskirą quality gate žingsnį");
  assert.equal(release.isBroad, false);
  assert.deepEqual(
    release.paths,
    [".github/workflows/**", "docs/release/**", "templates/VERSION/**"],
    "repo šaknies fragmentai lieka repo šaknyje — `src/.github/workflows/**` neegzistuoja",
  );

  // Fragmentas, kuris JAU yra `src/...`, nebegauna antro `src/`.
  const feature = inferAllowedPaths("Perrašyti src/commands įėjimus ir apps modulius");
  assert.ok(
    feature.paths.includes("src/commands/**"),
    `laukta "src/commands/**", gauta ${JSON.stringify(feature.paths)}`,
  );
  assert.equal(
    feature.paths.some((glob) => glob.startsWith("src/src/")),
    false,
    "dvigubas prefiksas yra leidimas niekam",
  );

  // Fragmentas su savo skirtuku (`/db/`) nebegamina `src//db/**`.
  const data = inferAllowedPaths("Sukurti migrations schema ir /db/ prieigą");
  assert.equal(
    data.paths.some((glob) => glob.includes("//")),
    false,
    `dvigubas skirtukas: ${JSON.stringify(data.paths)}`,
  );
});

test("taskGenerate: DUP-14 numeracija nuo cross-bucket maksimumo, pakartotinis run kolizijos negeneruoja", async () => {
  const files = new Map<string, string>([
    [abs("AG/openspec/changes/my-change/spec.md"), "# Spec"],
    [
      abs("AG/openspec/changes/my-change/tasks.md"),
      "- [ ] Pirmas planuojamas darbas\n- [ ] Antras planuojamas darbas\n- [x] Jau baigtas\n",
    ],
    [abs("AG/tasks/done/007-senas.md"), "# Task\n\n## Tikslas\nsenas\n"],
    [abs("vq/architecture/enforcement-policy.json"), JSON.stringify({ require_tests_for_code_changes: true })],
  ]);
  const ports = makePorts(files);
  assert.equal(await nextAvailableTaskNumber(ports, ROOT), 8);

  const result = await taskGenerate(ports, { openspecChangeId: "my-change", startIndex: 1 }, "/repo", path.join(ROOT, "vq"));
  assert.equal(result.specId, "my-change");
  assert.deepEqual(result.created, [
    "AG/tasks/queue/008-pirmas-planuojamas-darbas.md",
    "AG/tasks/queue/009-antras-planuojamas-darbas.md",
  ]);
  assert.deepEqual(result.skipped, []);

  const rendered = files.get(abs("AG/tasks/queue/008-pirmas-planuojamas-darbas.md"))!;
  assert.match(rendered, /^# Task\n/);
  assert.match(rendered, /readme-guard/);
  // enforcement require_tests_for_code_changes prideda tester į grandinę.
  assert.match(rendered, /tester/);

  // Pakartotinis run: cross-bucket maksimumas dabar 9, tad nauji numeriai — jokios
  // kolizijos su jau sugeneruotais failais (DUP-14 esmė; wx lieka lenktynių sargu).
  const rerun = await taskGenerate(ports, { openspecChangeId: "my-change", startIndex: 1 }, "/repo", path.join(ROOT, "vq"));
  assert.deepEqual(rerun.created, [
    "AG/tasks/queue/010-pirmas-planuojamas-darbas.md",
    "AG/tasks/queue/011-antras-planuojamas-darbas.md",
  ]);
});

test("openspec-context: aktyvi nuoroda skaitoma su biudžetu, trūkstama — pažymima", async () => {
  const files = new Map<string, string>([
    [abs("AG/openspec/project.md"), "Projekto kontekstas"],
    [abs("AG/openspec/changes/foo/proposal.md"), "Pasiūlymo tekstas"],
    [abs("AG/openspec/changes/foo/tasks.md"), "- [ ] darbas"],
  ]);
  const dirs = new Set([abs("AG/openspec/changes/foo")]);
  const ports: OpenSpecContextPorts = {
    fs: makePorts(files).fs,
    isDirectory: async (p) => dirs.has(norm(p)),
  };
  const taskText = "Žr. openspec/changes/foo ir AG/openspec/changes/nesamas kelius";
  const analysis = await analyzeOpenSpecReferences(ports, ROOT, taskText);
  assert.deepEqual(analysis.activeChangeDirs, ["openspec/changes/foo"]);
  assert.deepEqual(analysis.missingChangeDirs, ["openspec/changes/nesamas"]);

  const context = await buildOpenSpecContext(ports, ROOT, taskText);
  assert.match(context, /Projekto kontekstas/);
  assert.match(context, /Pasiūlymo tekstas/);

  // Be project.md ir be nuorodų — kontekstas neišgalvojamas.
  const emptyPorts: OpenSpecContextPorts = { fs: makePorts(new Map()).fs, isDirectory: async () => false };
  assert.equal(await buildOpenSpecContext(emptyPorts, ROOT, "be jokių nuorodų"), "OpenSpec context not found for this task.");
});

test("openspec-context: deklaruotų nuorodų analizė mato tik ## Spec source sekciją", async () => {
  const dirs = new Set([abs("AG/openspec/changes/foo")]);
  const ports: OpenSpecContextPorts = {
    fs: makePorts(new Map()).fs,
    isDirectory: async (p) => dirs.has(norm(p)),
  };

  // Kūno citata su nesama nuoroda (039/041 klasė) į deklaruotų rinkinį NEpatenka.
  const taskText = [
    "# Task",
    "",
    "## Spec source",
    "openspec/changes/foo",
    "",
    "## Neįtraukta",
    "- task'as krito 21:42 (`openspec/changes/auto- does not exist`)",
    "- archyvo paminėjimas: openspec/changes/archive/senas",
  ].join("\n");
  const declared = await analyzeDeclaredOpenSpecReferences(ports, ROOT, taskText);
  assert.deepEqual(declared.activeChangeDirs, ["openspec/changes/foo"]);
  assert.deepEqual(declared.missingChangeDirs, []);
  assert.deepEqual(declared.archivedChangeDirs, []);

  // Ta pati citata VISO teksto analizėje lieka matoma — konteksto praturtinimas nesusiaurėja.
  const full = await analyzeOpenSpecReferences(ports, ROOT, taskText);
  assert.deepEqual(full.missingChangeDirs, ["openspec/changes/auto-"]);
  assert.deepEqual(full.archivedChangeDirs, ["openspec/changes/archive/senas"]);

  // Nesama nuoroda PAČIOJE ## Spec source sekcijoje tebeklasifikuojama kaip missing.
  const badDeclared = await analyzeDeclaredOpenSpecReferences(
    ports,
    ROOT,
    "## Spec source\nopenspec/changes/nesamas\n\n## Tikslas\nX.",
  );
  assert.deepEqual(badDeclared.missingChangeDirs, ["openspec/changes/nesamas"]);

  // Be ## Spec source sekcijos — tuščia analizė, net jei kūnas pilnas nuorodų.
  const noSection = await analyzeDeclaredOpenSpecReferences(ports, ROOT, "Žr. openspec/changes/foo");
  assert.deepEqual(noSection.activeChangeDirs, []);
  assert.deepEqual(noSection.missingChangeDirs, []);
});
