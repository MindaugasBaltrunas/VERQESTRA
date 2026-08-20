// VQ-404 (2/2) testai — bootstrap tiekėjai: README intencijos parseris, bootstrap
// detekcija, architektūros grafo/progreso saugykla, .mmd -> grafas importas, openspec
// autogen (stub runner — jokio LLM) su deterministiniu template fallback'u ir realios
// BootstrapSpecPorts implementacijos end-to-end per generateProjectImplementationSpec.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { generateProjectImplementationSpec } from "../application/project-bootstrap/generate.js";
import { nodeFsAdapter } from "../infrastructure/fs/node-fs-adapter.js";
import {
  extractExplicitStackChoice,
  loadReadmeProductIntent,
  parseReadmeIntent,
} from "../infrastructure/bootstrap/readme-intent.js";
import { detectBootstrapEligibility, listFilesByExtension } from "../infrastructure/bootstrap/bootstrap-detector.js";
import {
  architectureGraphPath,
  architectureProgressPath,
  initProgress,
  readGraph,
  readProgress,
  updateNodeProgress,
  writeGraph,
} from "../infrastructure/bootstrap/architecture-graph-store.js";
import { bootstrapArchitectureFromSource } from "../infrastructure/bootstrap/bootstrap-architecture.js";
import {
  generateOpenSpecChange,
  parseJsonObject,
  slugFromTask,
  titleFromTask,
  writeTemplateOpenSpecChange,
} from "../infrastructure/bootstrap/openspec-autogen.js";
import { createBootstrapSpecPorts, listMarkdownFiles } from "../infrastructure/bootstrap/bootstrap-spec-ports.js";

const root = await mkdtemp(path.join(tmpdir(), "vq-bootstrap-"));
after(async () => {
  await rm(root, { recursive: true, force: true });
});

const FLOWCHART = "flowchart TD\n  A[Šaltinis] --> B[Parseris]\n  B --> C\n";

test("readme-intent: sekcijos, bullets, title; trūkstamas/tuščias README; stack extrakcija", async () => {
  const intent = parseReadmeIntent(
    ["preambulė be antraštės", "# Mano Produktas", "- pirmas", "1. antras", "## Stack", "- language: go", "- style: hexagonal", "tekstas"].join(
      "\n",
    ),
  );
  assert.equal(intent.title, "Mano Produktas");
  assert.equal(intent.sections.length, 3);
  assert.deepEqual(intent.sections[0], { heading: "", level: 0, bullets: [], paragraphs: ["preambulė be antraštės"] });
  assert.deepEqual(intent.sections[1]?.bullets, ["pirmas", "antras"]);
  assert.deepEqual(intent.sections[2]?.paragraphs, ["tekstas"]);

  assert.deepEqual(extractExplicitStackChoice(intent), { language: "go", architectureStyle: "hexagonal" });
  // Stack sekcija be atpažįstamų laukų — undefined (fallback į signalus).
  assert.equal(
    extractExplicitStackChoice(parseReadmeIntent("## Tech Stack\n- kazkas kita\n")),
    undefined,
  );
  assert.equal(extractExplicitStackChoice(parseReadmeIntent("# Be stack\n- x\n")), undefined);

  const missingDir = path.join(root, "be-readme");
  assert.deepEqual(await loadReadmeProductIntent(missingDir), { kind: "no-intent", reason: "readme-missing" });
  const emptyDir = path.join(root, "tuscias");
  await nodeFsAdapter.writeTextFile(path.join(emptyDir, "README.md"), "   \n\t\n");
  assert.deepEqual(await loadReadmeProductIntent(emptyDir), { kind: "no-intent", reason: "readme-empty" });
});

test("bootstrap-detector: bucket'ai AG/tasks, README ir vq/architecture/source/*.mmd įrodymai", async () => {
  const projectRoot = path.join(root, "det");
  const emptyVerdict = await detectBootstrapEligibility(projectRoot);
  assert.equal(emptyVerdict.bootstrapEligible, false);
  assert.equal(emptyVerdict.bucketsEmpty, true);
  assert.equal(emptyVerdict.hasReadme, false);

  await nodeFsAdapter.writeTextFile(path.join(projectRoot, "README.md"), "# Produktas\n- intencija\n");
  await nodeFsAdapter.writeTextFile(path.join(projectRoot, "vq", "architecture", "source", "flow.mmd"), FLOWCHART);
  const eligible = await detectBootstrapEligibility(projectRoot);
  assert.equal(eligible.bootstrapEligible, true);
  assert.deepEqual(eligible.mmdSources, [path.join(projectRoot, "vq", "architecture", "source", "flow.mmd")]);

  await nodeFsAdapter.writeTextFile(path.join(projectRoot, "AG", "tasks", "queue", "0001-task.md"), "# Task\n");
  const busy = await detectBootstrapEligibility(projectRoot);
  assert.equal(busy.bucketsEmpty, false);
  assert.equal(busy.bootstrapEligible, false);

  // listFilesByExtension: rikiuota, katalogai ignoruojami, tik nurodytas plėtinys.
  const scanDir = path.join(projectRoot, "skenas");
  await nodeFsAdapter.writeTextFile(path.join(scanDir, "b.mmd"), "x");
  await nodeFsAdapter.writeTextFile(path.join(scanDir, "a.mmd"), "x");
  await nodeFsAdapter.writeTextFile(path.join(scanDir, "c.txt"), "x");
  await nodeFsAdapter.writeTextFile(path.join(scanDir, "poaplankis.mmd", "vidus.mmd"), "x");
  const scanned = await listFilesByExtension(scanDir, ".mmd");
  assert.deepEqual(scanned, [path.join(scanDir, "a.mmd"), path.join(scanDir, "b.mmd")]);
});

test("architecture-graph-store: roundtrip, initProgress išsaugo done + evidenciją, updateNodeProgress vartai", async () => {
  const projectRoot = path.join(root, "store");
  const graphPath = architectureGraphPath(projectRoot);
  const progressPath = architectureProgressPath(projectRoot);
  assert.equal(await readGraph(graphPath), null);

  const graph = {
    source_path: "vq/architecture/source/flow.mmd",
    imported_at: "2026-08-20T10:00:00.000Z",
    nodes: [
      { id: "A", label: "Šaltinis", kind: "unknown" as const, status: "planned" as const },
      { id: "B", label: "Parseris", kind: "unknown" as const, status: "planned" as const },
    ],
    edges: [{ from: "A", to: "B", type: "unknown" as const }],
  };
  await writeGraph(graphPath, graph);
  assert.deepEqual(await readGraph(graphPath), graph);

  const first = await initProgress(graph, progressPath);
  assert.deepEqual(Object.keys(first.nodes).sort(), ["A", "B"]);
  await updateNodeProgress(progressPath, "A", { status: "done", done_tasks: ["0001"], evidence_refs: ["ref1"] });

  // Refresh: A lieka done su evidencija, B (ne-done) grįžta į planned; graph_hash — imported_at.
  const refreshed = await initProgress({ ...graph, imported_at: "2026-08-20T11:00:00.000Z" }, progressPath);
  assert.equal(refreshed.graph_hash, "2026-08-20T11:00:00.000Z");
  assert.equal(refreshed.nodes["A"]?.status, "done");
  assert.deepEqual(refreshed.nodes["A"]?.done_tasks, ["0001"]);
  assert.deepEqual(refreshed.nodes["A"]?.evidence_refs, ["ref1"]);
  assert.equal(refreshed.nodes["B"]?.status, "planned");
  assert.deepEqual(await readProgress(progressPath), refreshed);

  await assert.rejects(updateNodeProgress(progressPath, "NERA", { status: "done" }), /not found in progress/);
  await assert.rejects(updateNodeProgress(path.join(projectRoot, "nera.json"), "A", {}), /Progress ledger not found/);
});

test("bootstrap-architecture: pirmas FLOWCHART šaltinis (ne-flowchart praleidžiamas), done statusas išgyvena refresh", async () => {
  const projectRoot = path.join(root, "arch");
  assert.deepEqual(await bootstrapArchitectureFromSource(projectRoot), { status: "no-architecture" });

  const sourceDir = path.join(projectRoot, "vq", "architecture", "source");
  await nodeFsAdapter.writeTextFile(path.join(sourceDir, "a-class.mmd"), "classDiagram\n  class X\n");
  await nodeFsAdapter.writeTextFile(path.join(sourceDir, "b-flow.mmd"), FLOWCHART);
  const imported = await bootstrapArchitectureFromSource(projectRoot, "2026-08-20T10:00:00.000Z");
  assert.deepEqual(imported, {
    status: "imported",
    sourcePath: "vq/architecture/source/b-flow.mmd",
    nodes: 3,
    edges: 2,
  });

  const graph = await readGraph(architectureGraphPath(projectRoot));
  assert.equal(graph?.imported_at, "2026-08-20T10:00:00.000Z");
  await updateNodeProgress(architectureProgressPath(projectRoot), "B", { status: "done" });
  await bootstrapArchitectureFromSource(projectRoot, "2026-08-20T11:00:00.000Z");
  const progress = await readProgress(architectureProgressPath(projectRoot));
  assert.equal(progress?.nodes["B"]?.status, "done");
  assert.equal(progress?.nodes["A"]?.status, "planned");
});

test("openspec-autogen: title/slug taisyklės ir parseJsonObject kandidatai", () => {
  assert.equal(titleFromTask("0001", "# Task\n\n## Tikslas\nSutvarkyti eilę\n"), "Sutvarkyti eilę");
  assert.equal(titleFromTask("0001", "# Reali antraštė\n"), "Reali antraštė");
  assert.equal(titleFromTask("0001", "be antraštės"), "0001");

  const slug = slugFromTask("0001-b", "# Task\n\n## Tikslas\nĄžuolo Eilė!\n");
  assert.ok(slug.startsWith("auto-0001-b-"), slug);
  assert.match(slug, /^auto-[a-z0-9-]+$/);
  assert.equal(slugFromTask("", ""), "auto-task");

  assert.deepEqual(parseJsonObject('{"a":1}'), { a: 1 });
  assert.deepEqual(parseJsonObject('```json\n{"a":2}\n```'), { a: 2 });
  assert.deepEqual(parseJsonObject('prierašas {"a":3} uodega'), { a: 3 });
  assert.equal(parseJsonObject("[1,2]"), null);
  assert.equal(parseJsonObject("visai ne json"), null);
});

test("generateOpenSpecChange: stub runner — konfigas iš vq, failai į AG/openspec; nesėkmės grąžina null", async () => {
  const projectRoot = path.join(root, "gen");
  const agRoot = path.join(projectRoot, "AG");
  const runtimeRoot = path.join(projectRoot, "vq");
  await nodeFsAdapter.writeTextFile(path.join(runtimeRoot, "config", "architecture-rules.md"), "TAISYKLĖ-X\n");

  const seen: Array<{ prompt: string; model: string; stateDir: string }> = [];
  const contents = { proposal: "# P", design: "# D", spec: "# S", tasks: "# T" };
  const ref = await generateOpenSpecChange("# Task\n\n## Tikslas\nDaryti\n", "0002", agRoot, "sonnet-id", {
    runClaude: async (prompt, model, stateDir) => {
      seen.push({ prompt, model, stateDir });
      return { stdout: JSON.stringify(contents), stderr: "", code: 0 };
    },
  });
  assert.ok(ref?.startsWith("openspec/changes/auto-0002"), String(ref));
  // runtimeRoot išvestas kaip <agRoot>/../vq: taisyklės pateko į prompt'ą, state — vq/state.
  assert.ok(seen[0]!.prompt.includes("TAISYKLĖ-X"));
  assert.ok(seen[0]!.prompt.includes("## Tikslas"));
  assert.equal(seen[0]!.stateDir, path.join(runtimeRoot, "state"));
  const changeDir = path.join(agRoot, "openspec", "changes", ref!.split("/").at(-1)!);
  assert.equal(await nodeFsAdapter.readTextFileIfExists(path.join(changeDir, "proposal.md")), "# P\n");
  assert.equal((await listMarkdownFiles(changeDir)).length, 4);

  const failures: Array<{ stdout: string; code: number }> = [
    { stdout: JSON.stringify(contents), code: 1 },
    { stdout: "ne json", code: 0 },
    { stdout: JSON.stringify({ ...contents, tasks: "  " }), code: 0 },
  ];
  for (const failure of failures) {
    const failed = await generateOpenSpecChange("# Task\n", "0003", agRoot, "m", {
      runClaude: async () => ({ stdout: failure.stdout, stderr: "", code: failure.code }),
    });
    assert.equal(failed, null);
  }
  const thrown = await generateOpenSpecChange("# Task\n", "0003", agRoot, "m", {
    runClaude: async () => {
      throw new Error("cli sprogo");
    },
  });
  assert.equal(thrown, null);
});

test("writeTemplateOpenSpecChange + BootstrapSpecPorts end-to-end per generateProjectImplementationSpec", async () => {
  const projectRoot = path.join(root, "e2e");
  const agRoot = path.join(projectRoot, "AG");
  await nodeFsAdapter.writeTextFile(
    path.join(projectRoot, "README.md"),
    "# Mano Produktas\n\n## Funkcijos\n- eilių valdymas\n",
  );
  await nodeFsAdapter.writeTextFile(path.join(projectRoot, "vq", "architecture", "source", "flow.mmd"), FLOWCHART);

  // Template fallback — deterministinis, be LLM.
  const templateRef = await writeTemplateOpenSpecChange("# Task\n\n## Tikslas\nDaryti X\n", "0009", agRoot);
  assert.equal(templateRef, "openspec/changes/auto-0009-daryti-x");
  const templateTasks = await nodeFsAdapter.readTextFileIfExists(
    path.join(agRoot, "openspec", "changes", "auto-0009-daryti-x", "tasks.md"),
  );
  assert.ok(templateTasks?.includes("- 0009"));

  // Realios BootstrapSpecPorts su stub'intu LLM runner'iu (visa kita — tikri failai).
  const ports = createBootstrapSpecPorts({
    runClaude: async () => ({
      stdout: JSON.stringify({ proposal: "# P", design: "# D", spec: "# S", tasks: "# T" }),
      stderr: "",
      code: 0,
    }),
  });
  const result = await generateProjectImplementationSpec(ports, projectRoot, agRoot, "sonnet-id");
  assert.equal(result.status, "generated");
  if (result.status === "generated") {
    assert.ok(result.changeId.startsWith("auto-bootstrap-project-implementation"));
    assert.equal(result.files.length, 4);
    assert.ok(result.files.every((file) => file.startsWith("AG/openspec/changes/")));
  }
  // Grafas atnaujintas refreshArchitectureFromSource keliu.
  const graph = await ports.readArchitectureGraph(architectureGraphPath(projectRoot));
  assert.equal(graph?.nodes.length, 3);

  // Be README turinio — insufficient-evidence, jokio change.
  const bare = path.join(root, "e2e-be-readme");
  const bareResult = await generateProjectImplementationSpec(ports, bare, path.join(bare, "AG"), "m");
  assert.equal(bareResult.status, "insufficient-evidence");
});
