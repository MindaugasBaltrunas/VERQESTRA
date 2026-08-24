// VQ-501 (3/5-d) testai — wave variklis per fake portus: sintezės banga (external
// satisfied, no-evidence gate, done skip, idempotencija), task-sync (done taskas →
// implemented_files + verify → done arba bounded repair), reconcile, 895 reclaim keliai
// ir implementation-detector (node-map pirmumas, label-filename walk).

import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import type {
  ArchitectureGraph,
  ArchitectureNodeProgress,
  ArchitectureProgress,
} from "../domain/architecture/graph.js";
import type { ArchitectureWaveFsPort, ArchitectureWavePorts } from "../application/architecture/ports.js";
import {
  detectNodeImplementation,
  readNodeImplementationMap,
} from "../application/architecture/implementation-detector.js";
import {
  reclaimEvidencelessSynthesizedTasks,
  reclaimExternalInputNodes,
} from "../application/architecture/wave-reclaim.js";
import {
  nodeIdForQueuedTask,
  reconcileArchitectureProgress,
  syncArchitectureTaskCompletion,
} from "../application/architecture/task-sync.js";
import {
  markAlreadyImplementedNodes,
  synthesizeReadyArchitectureWave,
} from "../application/architecture/wave.js";

const ROOT = path.resolve("/repo");
const norm = (p: string): string => p.replace(/\\/g, "/");
const abs = (rel: string): string => norm(path.join(ROOT, rel));

function makeWavePorts(files: Map<string, string>): ArchitectureWavePorts {
  const fs: ArchitectureWaveFsPort = {
    exists: async (p) => files.has(norm(p)),
    readTextFileIfExists: async (p) => files.get(norm(p)),
    appendTextFile: async (p, text) => {
      files.set(norm(p), (files.get(norm(p)) ?? "") + text);
    },
    writeTextFile: async (p, text) => {
      files.set(norm(p), text);
    },
    removeFile: async (p) => {
      files.delete(norm(p));
    },
    listFiles: async (d) =>
      [...files.keys()]
        .filter((key) => norm(path.dirname(key)) === norm(d))
        .map((key) => path.basename(key))
        .sort(),
    listDirectory: async (d) => {
      const dir = norm(d).replace(/\/+$/, "");
      const seen = new Map<string, { name: string; isDirectory: boolean; isFile: boolean }>();
      for (const key of files.keys()) {
        if (!key.startsWith(`${dir}/`)) continue;
        const rest = key.slice(dir.length + 1);
        const head = rest.split("/")[0];
        if (!head || seen.has(head)) continue;
        const isFile = !rest.includes("/");
        seen.set(head, { name: head, isDirectory: !isFile, isFile });
      }
      return [...seen.values()];
    },
  };
  return {
    fs,
    updateNodeProgress: async (progressPath, nodeId, update, clearFields = []) => {
      const raw = files.get(norm(progressPath));
      if (raw === undefined) throw new Error(`Progress ledger not found at: ${progressPath}`);
      const progress = JSON.parse(raw) as ArchitectureProgress;
      const existing = progress.nodes[nodeId];
      if (!existing) throw new Error(`Node "${nodeId}" not found in progress at: ${progressPath}`);
      const merged: Record<string, unknown> = { ...existing, ...update };
      for (const field of clearFields) delete merged[field];
      progress.nodes[nodeId] = merged as ArchitectureNodeProgress;
      files.set(norm(progressPath), JSON.stringify(progress, null, 2));
    },
    nowMs: () => 1111,
    nowIso: () => "2026-08-20T12:00:00.000Z",
  };
}

const nodeProgress = (over: Partial<ArchitectureNodeProgress> = {}): ArchitectureNodeProgress => ({
  status: "planned",
  attempts: {},
  queued_tasks: [],
  done_tasks: [],
  implemented_files: [],
  evidence_refs: [],
  ...over,
});

function seedState(
  files: Map<string, string>,
  graph: ArchitectureGraph,
  nodes: Record<string, ArchitectureNodeProgress>,
): void {
  files.set(abs("vq/state/architecture/graph.json"), JSON.stringify(graph));
  files.set(abs("vq/state/architecture/progress.json"), JSON.stringify({ graph_hash: "h", nodes }));
}

function storedProgress(files: Map<string, string>): ArchitectureProgress {
  return JSON.parse(files.get(abs("vq/state/architecture/progress.json"))!) as ArchitectureProgress;
}

const WAVE_GRAPH: ArchitectureGraph = {
  source_path: "vq/architecture/source/main.mmd",
  imported_at: "2026-08-20T00:00:00.000Z",
  nodes: [
    { id: "EXT", label: "Git Repository", kind: "input", status: "planned", external: true },
    { id: "B", label: "Parseris", kind: "component", status: "planned" },
    { id: "C", label: "Analizatorius", kind: "component", status: "planned" },
    { id: "NE", label: "Ataskaitos", kind: "component", status: "planned" },
    { id: "D", label: "Baigta", kind: "component", status: "done" },
  ],
  edges: [
    { from: "EXT", to: "B", type: "depends_on" },
    { from: "B", to: "C", type: "depends_on" },
    { from: "EXT", to: "NE", type: "depends_on" },
  ],
};

function seedWaveWorld(): Map<string, string> {
  const files = new Map<string, string>();
  seedState(files, WAVE_GRAPH, {
    EXT: nodeProgress(),
    B: nodeProgress(),
    C: nodeProgress(),
    NE: nodeProgress(),
    D: nodeProgress({ status: "done" }),
  });
  files.set(
    abs("vq/state/architecture/evidence.jsonl"),
    `${JSON.stringify({ node_id: "B", source: "README.md", excerpt: "parserio faktas", timestamp: "t1" })}\n`,
  );
  return files;
}

test("synthesizeReadyArchitectureWave: sintezuoja ready mazgą, external satisfied, no-evidence gate", async () => {
  const files = seedWaveWorld();
  const ports = makeWavePorts(files);
  const result = await synthesizeReadyArchitectureWave(ports, ROOT);

  assert.equal(result.status, "synthesized");
  assert.equal(result.synthesized, 1);
  assert.equal(result.external_satisfied, 1);
  assert.equal(result.no_evidence, 1);
  assert.equal(result.done, 1);
  assert.equal(result.blocked, 2);
  assert.equal(result.total, 5);

  const taskText = files.get(abs("AG/tasks/queue/run-tree-B-1111.md"));
  assert.ok(taskText);
  assert.ok(taskText.includes("architecture-node/B (run: run-tree-B-1111)"));
  assert.ok(taskText.includes("- [README.md] parserio faktas _(node: B, t1)_"));
  assert.ok(files.has(abs("vq/state/architecture/task-synthesis/run-tree-B-1111.json")));

  const progress = storedProgress(files);
  assert.equal(progress.nodes["B"]?.status, "queued");
  assert.deepEqual(progress.nodes["B"]?.queued_tasks, ["AG/tasks/queue/run-tree-B-1111.md"]);
  const ne = result.nodeResults.find((entry) => entry.nodeId === "NE");
  assert.equal(ne?.action, "no-evidence");
  assert.match(ne?.reason ?? "", /refusing to fabricate/);
});

test("synthesizeReadyArchitectureWave: idempotentiška — antra banga nekuria dublikatų", async () => {
  const files = seedWaveWorld();
  const ports = makeWavePorts(files);
  await synthesizeReadyArchitectureWave(ports, ROOT);
  const second = await synthesizeReadyArchitectureWave(ports, ROOT);
  assert.equal(second.synthesized, 0);
  assert.equal(second.status, "blocked");
  assert.deepEqual(storedProgress(files).nodes["B"]?.queued_tasks, ["AG/tasks/queue/run-tree-B-1111.md"]);
});

test("synthesizeReadyArchitectureWave: be grafo — no-graph", async () => {
  const result = await synthesizeReadyArchitectureWave(makeWavePorts(new Map()), ROOT);
  assert.equal(result.status, "no-graph");
  assert.equal(result.total, 0);
});

test("nodeIdForQueuedTask: tikslus vardas ir split-vaiko prefiksas", () => {
  const progress: ArchitectureProgress = {
    graph_hash: "h",
    nodes: { B: nodeProgress({ queued_tasks: ["AG/tasks/queue/run-tree-B-1.md"] }) },
  };
  assert.equal(nodeIdForQueuedTask(progress, "run-tree-B-1"), "B");
  assert.equal(nodeIdForQueuedTask(progress, "run-tree-B-1-02-dalis"), "B");
  assert.equal(nodeIdForQueuedTask(progress, "kitas-taskas"), undefined);
});

// 2026-08-24: ta pati klasė kaip `dependencyMatches` radiniuose — tapatybė, sprendžiama prefiksu.
// Čia prefiksas TEISĖTAS (split-vaikas priklauso tėvo mazgui), bet atsakymas buvo renkamas
// pirmas pagal `Object.entries` tvarką, tad tas pats klausimas turėjo du atsakymus.
test("nodeIdForQueuedTask: tikslus atitikmuo nusveria prefiksą, dviprasmybė atmetama", () => {
  const nodes = {
    A: nodeProgress({ queued_tasks: ["AG/tasks/queue/0042-fix.md"] }),
    B: nodeProgress({ queued_tasks: ["AG/tasks/queue/0042-fix-more.md"] }),
  };
  const progress: ArchitectureProgress = { graph_hash: "h", nodes };
  // Ta pati aibė, tik kita raktų tvarka — atsakymas privalo nesikeisti.
  const flipped: ArchitectureProgress = { graph_hash: "h", nodes: { B: nodes.B, A: nodes.A } };

  // Anksčiau grąžindavo „A": task'as, priklausantis B PAŽODŽIUI, būdavo priskiriamas A, ir
  // `verified-done` gaudavo ne tas mazgas — o `done` atrakina downstream.
  assert.equal(nodeIdForQueuedTask(progress, "0042-fix-more"), "B", "tikslus atitikmuo laimi");
  assert.equal(nodeIdForQueuedTask(flipped, "0042-fix-more"), "B", "raktų tvarka atsakymo nekeičia");

  // Vaikas, kurio prefiksai yra ABU mazgai: „nežinau" vietoj spėjimo. Mazgas lieka `queued` —
  // matomas sustojimas vietoj tylaus neteisingo atrakinimo.
  assert.equal(nodeIdForQueuedTask(progress, "0042-fix-more-01-dalis"), undefined);
  assert.equal(nodeIdForQueuedTask(flipped, "0042-fix-more-01-dalis"), undefined);

  // Vienareikšmis split-vaikas ir toliau randa savo tėvą.
  const single: ArchitectureProgress = { graph_hash: "h", nodes: { B: nodes.B } };
  assert.equal(nodeIdForQueuedTask(single, "0042-fix-more-01-dalis"), "B");
});

const SYNC_GRAPH: ArchitectureGraph = {
  source_path: "s",
  imported_at: "t",
  nodes: [{ id: "B", label: "Parseris", kind: "component", status: "queued" }],
  edges: [],
};

const DONE_TASK_TEXT = ["# Task", "", "## Failai", "", "Leidžiama:", "- `src/b.ts`", "", "Draudžiama:", "- kita"].join("\n");

test("syncArchitectureTaskCompletion: done taskas → implemented_files + verify → done", async () => {
  const files = new Map<string, string>();
  seedState(files, SYNC_GRAPH, {
    B: nodeProgress({ status: "queued", queued_tasks: ["AG/tasks/queue/run-tree-B-1.md"] }),
  });
  files.set(abs("src/b.ts"), "export const b = 1;\n");
  files.set(abs("src/b.test.ts"), "test\n");
  files.set(abs("AG/tasks/done/run-tree-B-1.md"), DONE_TASK_TEXT);
  const ports = makeWavePorts(files);

  const result = await syncArchitectureTaskCompletion(ports, ROOT, "run-tree-B-1", abs("AG/tasks/done/run-tree-B-1.md"));
  assert.deepEqual(result, { action: "verified-done", nodeId: "B", implementedFiles: ["src/b.ts"] });
  const progress = storedProgress(files);
  assert.equal(progress.nodes["B"]?.status, "done");
  assert.deepEqual(progress.nodes["B"]?.implemented_files, ["src/b.ts"]);
  assert.deepEqual(progress.nodes["B"]?.done_tasks, ["run-tree-B-1"]);
  assert.equal(progress.nodes["B"]?.verified_at, "2026-08-20T12:00:00.000Z");
});

test("syncArchitectureTaskCompletion: verify nesėkmė → bounded repair (repairing)", async () => {
  const files = new Map<string, string>();
  seedState(files, SYNC_GRAPH, {
    B: nodeProgress({
      status: "queued",
      queued_tasks: ["AG/tasks/queue/run-tree-B-1.md"],
      interface_contract: { inputs: [], outputs: [], upstream: [], downstream: [], public_exports: ["foo"], checks: [] },
    }),
  });
  files.set(abs("src/b.ts"), "export const b = 1;\n");
  files.set(abs("src/b.test.ts"), "test\n");
  files.set(abs("AG/tasks/done/run-tree-B-1.md"), DONE_TASK_TEXT);
  const ports = makeWavePorts(files);

  const result = await syncArchitectureTaskCompletion(ports, ROOT, "run-tree-B-1", abs("AG/tasks/done/run-tree-B-1.md"));
  assert.equal(result.action, "verify-failed");
  if (result.action === "verify-failed") {
    assert.equal(result.repair, "repair");
    assert.ok(result.failures.includes('Required export "foo" not found in implemented files.'));
  }
  const progress = storedProgress(files);
  assert.equal(progress.nodes["B"]?.status, "repairing");
  assert.deepEqual(progress.nodes["B"]?.attempts, { "unclear-interface": 1 });
});

test("syncArchitectureTaskCompletion: svetimas taskas — not-architecture-task", async () => {
  const files = new Map<string, string>();
  seedState(files, SYNC_GRAPH, { B: nodeProgress({ status: "queued" }) });
  const ports = makeWavePorts(files);
  const result = await syncArchitectureTaskCompletion(ports, ROOT, "0042", abs("AG/tasks/done/0042.md"));
  assert.deepEqual(result, { action: "not-architecture-task" });
});

test("reconcileArchitectureProgress: done bucket'e gulintis queue taskas sinchronizuojamas", async () => {
  const files = new Map<string, string>();
  seedState(files, SYNC_GRAPH, {
    B: nodeProgress({ status: "queued", queued_tasks: ["AG/tasks/queue/run-tree-B-1.md"] }),
  });
  files.set(abs("src/b.ts"), "export const b = 1;\n");
  files.set(abs("src/b.test.ts"), "test\n");
  files.set(abs("AG/tasks/done/run-tree-B-1.md"), DONE_TASK_TEXT);
  const ports = makeWavePorts(files);

  const synced = await reconcileArchitectureProgress(ports, ROOT);
  assert.deepEqual(synced, ["B:verified-done"]);
  assert.equal(storedProgress(files).nodes["B"]?.status, "done");
});

test("reclaimExternalInputNodes: external mazgo stale būsena ir taskai išvalomi", async () => {
  const files = new Map<string, string>();
  const graph: ArchitectureGraph = {
    source_path: "s",
    imported_at: "t",
    nodes: [{ id: "EXT", label: "Git Repository", kind: "input", status: "planned", external: true }],
    edges: [],
  };
  seedState(files, graph, {
    EXT: nodeProgress({
      status: "human-review",
      human_review_reason: "sena priežastis",
      queued_tasks: ["AG/tasks/queue/run-tree-EXT-1.md"],
    }),
  });
  files.set(abs("AG/tasks/queue/run-tree-EXT-1.md"), "task");
  files.set(abs("AG/tasks/human-review/run-tree-EXT-1.md"), "task");
  const ports = makeWavePorts(files);

  const result = await reclaimExternalInputNodes(ports, ROOT);
  assert.deepEqual(result.nodes, ["EXT"]);
  assert.deepEqual(result.removedQueueTasks.sort(), [
    "AG/tasks/human-review/run-tree-EXT-1.md",
    "AG/tasks/queue/run-tree-EXT-1.md",
  ]);
  assert.ok(!files.has(abs("AG/tasks/queue/run-tree-EXT-1.md")));
  const ext = storedProgress(files).nodes["EXT"];
  assert.equal(ext?.status, "planned");
  assert.deepEqual(ext?.queued_tasks, []);
  assert.equal("human_review_reason" in (ext ?? {}), false);
});

test("reclaimEvidencelessSynthesizedTasks: evidence_count=0 taskas šalinamas, kiti lieka", async () => {
  const files = new Map<string, string>();
  const graph: ArchitectureGraph = {
    source_path: "s",
    imported_at: "t",
    nodes: [{ id: "B", label: "Parseris", kind: "component", status: "queued" }],
    edges: [],
  };
  seedState(files, graph, {
    B: nodeProgress({
      status: "queued",
      queued_tasks: ["AG/tasks/queue/run-tree-B-9.md", "AG/tasks/queue/run-tree-B-8.md"],
    }),
  });
  files.set(abs("vq/state/architecture/task-synthesis/run-tree-B-9.json"), JSON.stringify({ evidence_count: 0 }));
  files.set(abs("vq/state/architecture/task-synthesis/run-tree-B-8.json"), JSON.stringify({ evidence_count: 2 }));
  files.set(abs("AG/tasks/queue/run-tree-B-9.md"), "task");
  files.set(abs("AG/tasks/queue/run-tree-B-8.md"), "task");
  const ports = makeWavePorts(files);

  const result = await reclaimEvidencelessSynthesizedTasks(ports, ROOT);
  assert.deepEqual(result.nodes, ["B"]);
  assert.deepEqual(result.removedTasks, ["AG/tasks/queue/run-tree-B-9.md"]);
  assert.ok(files.has(abs("AG/tasks/queue/run-tree-B-8.md")));
  const b = storedProgress(files).nodes["B"];
  assert.equal(b?.status, "queued");
  assert.deepEqual(b?.queued_tasks, ["AG/tasks/queue/run-tree-B-8.md"]);
});

test("implementation-detector: node-map pirmumas ir stale map be fallthrough", async () => {
  const files = new Map<string, string>();
  files.set(
    abs("vq/architecture/node-map.json"),
    JSON.stringify({ nodes: { M1: { implemented: true }, M2: { paths: ["src/yra.ts", "src/nera.ts"] } } }),
  );
  files.set(abs("src/yra.ts"), "x");
  const ports = makeWavePorts(files);
  const map = await readNodeImplementationMap(ports.fs, ROOT);

  const m1 = await detectNodeImplementation(
    ports.fs,
    ROOT,
    { id: "M1", label: "Elgsenos mazgas", kind: "component", status: "planned" },
    map,
  );
  assert.deepEqual(m1, { files: [], source: "map" });

  const m2 = await detectNodeImplementation(
    ports.fs,
    ROOT,
    { id: "M2", label: "pollLoop.ts", kind: "component", status: "planned" },
    map,
  );
  assert.equal(m2, null);
});

test("implementation-detector: label failo vardas randamas ribotu walk'u", async () => {
  const files = new Map<string, string>();
  files.set(abs("src/x/pollLoop.ts"), "export const p = 1;\n");
  files.set(abs("node_modules/pkg/pollLoop.ts"), "vendor kopija nesiskaito");
  const ports = makeWavePorts(files);
  const detection = await detectNodeImplementation(
    ports.fs,
    ROOT,
    { id: "P", label: "pollLoop.ts valdiklis", kind: "component", status: "planned" },
    { nodes: {} },
  );
  assert.deepEqual(detection, { files: ["src/x/pollLoop.ts"], source: "label-filename" });
});

test("markAlreadyImplementedNodes: aptiktas mazgas žymimas done ir queue taskas išvalomas", async () => {
  const files = new Map<string, string>();
  const graph: ArchitectureGraph = {
    source_path: "s",
    imported_at: "t",
    nodes: [{ id: "P", label: "pollLoop.ts", kind: "component", status: "planned" }],
    edges: [],
  };
  seedState(files, graph, {
    P: nodeProgress({ status: "queued", queued_tasks: ["AG/tasks/queue/old-P.md"] }),
  });
  files.set(abs("src/pollLoop.ts"), "export const p = 1;\n");
  files.set(abs("src/pollLoop.test.ts"), "test\n");
  files.set(abs("AG/tasks/queue/old-P.md"), "task");
  const ports = makeWavePorts(files);

  const progress = JSON.parse(files.get(abs("vq/state/architecture/progress.json"))!) as ArchitectureProgress;
  const result = await markAlreadyImplementedNodes(ports, ROOT, graph, progress, abs("vq/state/architecture/progress.json"));
  assert.deepEqual(result.markedDone, ["P"]);
  assert.equal(result.progress.nodes["P"]?.status, "done");
  assert.deepEqual(result.progress.nodes["P"]?.implemented_files, ["src/pollLoop.ts"]);
  assert.ok(!files.has(abs("AG/tasks/queue/old-P.md")));
  assert.equal(storedProgress(files).nodes["P"]?.status, "done");
});
