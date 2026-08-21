// VQ-501 (5/5-d) testai — bootstrap pamatai: domain/policies/bootstrap-routing maršruto
// taisyklės (kada sintezė, kada žmogaus peržiūra) ir application/project-bootstrap/queue-synth
// (grafo trūkumas, įrodymų disciplina, priklausomybių tvarka, DUP-14 numerių alokatorius).

import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { evaluateBootstrapRouting } from "../domain/policies/bootstrap-routing.js";
import type { ArchitectureGraph, ArchitectureProgress } from "../domain/architecture/graph.js";
import type { EvidenceEntry } from "../domain/architecture/evidence.js";
import type { ArchitectureWaveFsPort } from "../application/architecture/ports.js";
import type { SynthesisInput, SynthesizedTask } from "../application/architecture/task-synthesizer.js";
import {
  generateBootstrapQueueTasks,
  nextAvailableTaskNumber,
  type BootstrapQueueSynthPorts,
} from "../application/project-bootstrap/queue-synth.js";

const ROOT = path.resolve("/repo");
const norm = (value: string): string => value.replace(/\\/g, "/");
const rel = (absolute: string): string => norm(path.relative(ROOT, absolute));

// ---------------------------------------------------------------------------
// domain: bootstrap routing
// ---------------------------------------------------------------------------

const READY_INPUT = { hasReadme: true, mmdSourceCount: 2, readmeMmdConflict: false };
const CONFIDENT_STACK = {
  confidence: "high" as const,
  explicitStackChoiceProvided: false,
  humanReviewRequired: false,
};

test("evaluateBootstrapRouting: pilni ir neprieštaringi įrodymai — synthesize", () => {
  const decision = evaluateBootstrapRouting(READY_INPUT, CONFIDENT_STACK);
  assert.equal(decision.route, "synthesize");
  assert.match(decision.reason, /confidence is sufficient/);
});

test("evaluateBootstrapRouting: trūkstami ar prieštaringi įrodymai — human-review su visomis priežastimis", () => {
  const decision = evaluateBootstrapRouting(
    { hasReadme: false, mmdSourceCount: 0, readmeMmdConflict: true },
    CONFIDENT_STACK,
  );
  assert.equal(decision.route, "human-review");
  assert.match(decision.reason, /README\.md is missing/);
  assert.match(decision.reason, /no Mermaid/);
  assert.match(decision.reason, /signals conflict/);
});

test("evaluateBootstrapRouting: eksplicitinis stack pasirinkimas praleidžia žemą confidence, bet ne rizikos signalą", () => {
  const lowAuto = evaluateBootstrapRouting(READY_INPUT, {
    confidence: "low",
    explicitStackChoiceProvided: false,
    humanReviewRequired: false,
  });
  assert.equal(lowAuto.route, "human-review");
  assert.match(lowAuto.reason, /confidence is low/);

  const lowExplicit = evaluateBootstrapRouting(READY_INPUT, {
    confidence: "low",
    explicitStackChoiceProvided: true,
    humanReviewRequired: false,
  });
  assert.equal(lowExplicit.route, "synthesize");

  // Realus rizikos signalas ant paties sprendimo galioja net su eksplicitiniu pasirinkimu.
  const risky = evaluateBootstrapRouting(READY_INPUT, {
    confidence: "high",
    explicitStackChoiceProvided: true,
    humanReviewRequired: true,
  });
  assert.equal(risky.route, "human-review");
  assert.match(risky.reason, /requires human review/);
});

// ---------------------------------------------------------------------------
// application: queue synthesis
// ---------------------------------------------------------------------------

const GRAPH: ArchitectureGraph = {
  source_path: "AG/architecture/source/app.mmd",
  imported_at: "2026-08-21T00:00:00.000Z",
  nodes: [
    { id: "api", label: "API", kind: "component", status: "planned" },
    { id: "core", label: "Core", kind: "component", status: "planned" },
    { id: "vendor", label: "Vendor", kind: "input", status: "planned", external: true },
  ],
  edges: [{ from: "core", to: "api", type: "depends_on" }],
};

const EVIDENCE: EvidenceEntry[] = [
  { node_id: "core", source: "README.md", excerpt: "Core does the work.", timestamp: "2026-08-21T00:00:00.000Z" },
  { node_id: "api", source: "README.md", excerpt: "API exposes it.", timestamp: "2026-08-21T00:00:00.000Z" },
];

function fakeSynthesize(input: SynthesisInput): SynthesizedTask {
  return {
    run_id: input.runId,
    node_id: input.nodeId,
    node_label: input.graph.nodes.find((node) => node.id === input.nodeId)?.label ?? input.nodeId,
    evidence_count: input.evidence.length,
    allowed_files: [`src/${input.nodeId}.ts`],
    markdown: `# ${input.runId}\nspec: ${input.specSource ?? "none"}\n`,
  };
}

function synthPorts(files: Record<string, string>, taskFiles: Record<string, string[]> = {}): {
  ports: BootstrapQueueSynthPorts;
  seen: SynthesisInput[];
} {
  const seen: SynthesisInput[] = [];
  const fs: ArchitectureWaveFsPort = {
    exists: async (p) => files[rel(p)] !== undefined,
    readTextFileIfExists: async (p) => files[rel(p)],
    appendTextFile: async () => {},
    writeTextFile: async () => {},
    removeFile: async () => {},
    listFiles: async (dir) => taskFiles[rel(dir)] ?? [],
    listDirectory: async () => [],
  };
  return {
    seen,
    ports: {
      fs,
      synthesize: (input) => {
        seen.push(input);
        return fakeSynthesize(input);
      },
    },
  };
}

const GRAPH_PATH = "vq/state/architecture/graph.json";
const EVIDENCE_PATH = "vq/state/architecture/evidence.jsonl";

test("generateBootstrapQueueTasks: be grafo — no-architecture, jokios sintezės", async () => {
  const world = synthPorts({});
  const result = await generateBootstrapQueueTasks(world.ports, ROOT, "auto-app");
  assert.equal(result.status, "no-architecture");
  assert.equal(world.seen.length, 0);

  const empty = synthPorts({ [GRAPH_PATH]: JSON.stringify({ ...GRAPH, nodes: [] }) });
  assert.equal((await generateBootstrapQueueTasks(empty.ports, ROOT, "auto-app")).status, "no-architecture");
});

test("generateBootstrapQueueTasks: mazgai be įrodymų negauna task'ų — insufficient-evidence su signalais", async () => {
  const world = synthPorts({ [GRAPH_PATH]: JSON.stringify(GRAPH) });
  const result = await generateBootstrapQueueTasks(world.ports, ROOT, "auto-app");

  assert.equal(result.status, "insufficient-evidence");
  assert.equal(world.seen.length, 0, "be įrodymų sintezatorius nekviečiamas");
  const weak = result.status === "insufficient-evidence" ? result.weakEvidence : [];
  // Išorinis `vendor` mazgas nelaukia darbo, tad į signalus nepatenka.
  assert.deepEqual(
    weak.map((signal) => signal.nodeId),
    ["core", "api"],
  );
  assert.match(weak[0]?.reason ?? "", /refusing to fabricate/);
});

test("generateBootstrapQueueTasks: priklausomybių tvarka, spec nuoroda ir dalinis įrodymų rinkinys", async () => {
  const partialEvidence = EVIDENCE.filter((entry) => entry.node_id === "core");
  const world = synthPorts({
    [GRAPH_PATH]: JSON.stringify(GRAPH),
    [EVIDENCE_PATH]: partialEvidence.map((entry) => JSON.stringify(entry)).join("\n"),
  });
  const result = await generateBootstrapQueueTasks(world.ports, ROOT, "auto-app");

  assert.equal(result.status, "generated");
  const tasks = result.status === "generated" ? result.tasks : [];
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0]?.nodeId, "core");
  assert.equal(tasks[0]?.step, 1);
  assert.equal(tasks[0]?.taskId, "auto-app-001-core");
  // `api` priklauso nuo `core`, tad eina antras — ir be įrodymų lieka signalu, ne task'u.
  const weak = result.status === "generated" ? result.weakEvidence : [];
  assert.deepEqual(
    weak.map((signal) => signal.nodeId),
    ["api"],
  );
  assert.equal(world.seen[0]?.specSource, "openspec/changes/auto-app");
});

test("generateBootstrapQueueTasks: numeriai tęsiami nuo didžiausio VISUOSE bucket'uose (DUP-14)", async () => {
  const world = synthPorts(
    {
      [GRAPH_PATH]: JSON.stringify(GRAPH),
      [EVIDENCE_PATH]: EVIDENCE.map((entry) => JSON.stringify(entry)).join("\n"),
    },
    // Numeris guli TIK `done` bucket'e — per-katalogo wx patikra jo nematytų.
    { "AG/tasks/done": ["0007-senas.md"], "AG/tasks/queue": ["0003-kitas.md"] },
  );

  assert.equal(await nextAvailableTaskNumber(world.ports.fs, ROOT), 8);

  const result = await generateBootstrapQueueTasks(world.ports, ROOT, "auto-app");
  assert.equal(result.status, "generated");
  const tasks = result.status === "generated" ? result.tasks : [];
  assert.deepEqual(
    tasks.map((task) => task.taskId),
    ["auto-app-008-core", "auto-app-009-api"],
  );
  assert.deepEqual(
    tasks.map((task) => task.step),
    [8, 9],
  );
});

test("generateBootstrapQueueTasks: progresas su `done` mazgais palieka tik likusį darbą", async () => {
  const progress: ArchitectureProgress = {
    graph_hash: GRAPH.imported_at,
    nodes: {
      core: { status: "done", attempts: {}, queued_tasks: [], done_tasks: [], implemented_files: [], evidence_refs: [] },
      api: { status: "planned", attempts: {}, queued_tasks: [], done_tasks: [], implemented_files: [], evidence_refs: [] },
    },
  };
  const world = synthPorts({
    [GRAPH_PATH]: JSON.stringify(GRAPH),
    "vq/state/architecture/progress.json": JSON.stringify(progress),
    [EVIDENCE_PATH]: EVIDENCE.map((entry) => JSON.stringify(entry)).join("\n"),
  });

  const result = await generateBootstrapQueueTasks(world.ports, ROOT, "auto-app");
  assert.equal(result.status, "generated");
  const tasks = result.status === "generated" ? result.tasks : [];
  assert.deepEqual(
    tasks.map((task) => task.nodeId),
    ["api"],
  );
});

test("generateBootstrapQueueTasks: be laukiančių mazgų — insufficient-evidence be signalų", async () => {
  const allDone: ArchitectureProgress = {
    graph_hash: GRAPH.imported_at,
    nodes: {
      core: { status: "done", attempts: {}, queued_tasks: [], done_tasks: [], implemented_files: [], evidence_refs: [] },
      api: { status: "done", attempts: {}, queued_tasks: [], done_tasks: [], implemented_files: [], evidence_refs: [] },
    },
  };
  const world = synthPorts({
    [GRAPH_PATH]: JSON.stringify(GRAPH),
    "vq/state/architecture/progress.json": JSON.stringify(allDone),
  });

  const result = await generateBootstrapQueueTasks(world.ports, ROOT, "auto-app");
  assert.equal(result.status, "insufficient-evidence");
  assert.match(result.status === "insufficient-evidence" ? result.reason : "", /No pending architecture nodes/);
  assert.deepEqual(result.status === "insufficient-evidence" ? result.weakEvidence : ["x"], []);
});
