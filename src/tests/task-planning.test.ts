// Task planavimo klasterio testai (VQ-305 3/3-g): spec-source rezoliucija, queue task
// renderis, taskGenerate numeracija (DUP-14) ir openspec konteksto ištrauka.

import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { taskGenerate, nextAvailableTaskNumber, type TaskGeneratePorts } from "../application/task-planning/generate.js";
import {
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
