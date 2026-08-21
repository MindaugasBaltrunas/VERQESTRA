// VQ-501 (3/5-e) testai — architecture CLI komanda per fake portus: governance init/check
// (idempotencija, missing sąrašas, --json exit 0 paritetas), import-mmd (usage/containment/
// importas su klasifikacija), next-node, synthesize-node (evidence disciplina, preview be
// rašymo, --write su idempotency guard), verify-node (pass/done persist; fail → bounded
// repair; --json exit 0), run-tree (no-graph, sintezė), code-map (usage, tuščias projektas
// 100%, trūkstamas map failas) + application governance stack decision persist/load.

import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import type {
  ArchitectureGraph,
  ArchitectureNodeProgress,
  ArchitectureProgress,
} from "../domain/architecture/graph.js";
import type { StackDecision } from "../domain/policies/stack-decision.js";
import type { ArchitectureWaveFsPort } from "../application/architecture/ports.js";
import {
  loadStackDecisionState,
  persistStackDecisionState,
} from "../application/architecture/governance.js";
import type { CodeIntelligenceFileSystemPort } from "../application/code-intelligence/ports.js";
import type { CliIo } from "../interfaces/cli/registry.js";
import {
  architectureCommand,
  type ArchitectureCommandDeps,
} from "../interfaces/cli/architecture/command.js";

const ROOT = path.resolve("/repo");
const norm = (p: string): string => p.replace(/\\/g, "/");
const abs = (rel: string): string => norm(path.join(ROOT, rel));

function captureIo(): { io: CliIo; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (line) => out.push(line), error: (line) => err.push(line) }, out, err };
}

function makeDeps(files: Map<string, string>, io: CliIo): ArchitectureCommandDeps {
  // Katalogas fake pasaulyje egzistuoja, kai bent vienas failas guli po juo — to reikia
  // governance check adr KATALOGO patikrai (realiame adapteryje exists veikia ir dirams).
  const existsFn = async (p: string): Promise<boolean> => {
    const key = norm(p);
    if (files.has(key)) return true;
    for (const other of files.keys()) {
      if (other.startsWith(`${key}/`)) return true;
    }
    return false;
  };
  const listDirectory = async (d: string): Promise<Array<{ name: string; isDirectory: boolean; isFile: boolean }>> => {
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
  };
  const fs: ArchitectureWaveFsPort = {
    exists: existsFn,
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
    listDirectory,
  };
  const codeFs: CodeIntelligenceFileSystemPort = {
    listDirectory,
    // Fake pasaulyje failas = raktas žemėlapyje; katalogas = kažkas guli po juo.
    statKind: async (p) => (files.has(norm(p)) ? "file" : (await existsFn(p)) ? "directory" : "absent"),
    readTextFile: async (p) => {
      const text = files.get(norm(p));
      if (text === undefined) throw new Error(`ENOENT: ${p}`);
      return text;
    },
    readFileBytes: async () => new Uint8Array(),
    fileSize: async () => 0,
    exists: existsFn,
    writeTextFileAtomic: async (p, content) => {
      files.set(norm(p), content);
    },
    makeDirectory: async () => {},
  };
  return {
    wave: {
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
    },
    codeFs,
    graphStore: {
      writeGraph: async (statePath, graph) => {
        files.set(norm(statePath), JSON.stringify(graph, null, 2));
      },
      initProgress: async (graph, statePath) => {
        const nodes: Record<string, ArchitectureNodeProgress> = {};
        for (const node of graph.nodes) {
          nodes[node.id] = {
            status: "planned",
            attempts: {},
            queued_tasks: [],
            done_tasks: [],
            implemented_files: [],
            evidence_refs: [],
          };
        }
        const progress: ArchitectureProgress = { graph_hash: graph.imported_at, nodes };
        files.set(norm(statePath), JSON.stringify(progress, null, 2));
        return progress;
      },
    },
    projectRoot: ROOT,
    io,
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

const B_GRAPH: ArchitectureGraph = {
  source_path: "s",
  imported_at: "t",
  nodes: [{ id: "B", label: "Parseris", kind: "component", status: "planned" }],
  edges: [],
};

const B_EVIDENCE = `${JSON.stringify({ node_id: "B", source: "README.md", excerpt: "faktas", timestamp: "t1" })}\n`;

test("architecture init: sukuria 9 failus, antras kvietimas viską praleidžia", async () => {
  const files = new Map<string, string>();
  const { io, out } = captureIo();
  const deps = makeDeps(files, io);
  assert.equal(await architectureCommand(deps, ["init"]), 0);
  assert.equal(out[0], "architecture governance initialized");
  assert.equal(out[1], "config: vq/architecture/governance.json");
  assert.equal(out[2], "created: 9");
  assert.ok(files.has(abs("vq/architecture/governance.json")));
  assert.ok(files.has(abs("vq/architecture/adr/README.md")));

  const { io: io2, out: out2 } = captureIo();
  assert.equal(await architectureCommand(makeDeps(files, io2), ["init"]), 0);
  assert.equal(out2[2], "created: 0");
  assert.equal(out2[3], "skipped: 9");
});

test("architecture check: missing kai konfigo nėra, ok po init, --json visada 0", async () => {
  const files = new Map<string, string>();
  const { io, out } = captureIo();
  assert.equal(await architectureCommand(makeDeps(files, io), ["check"]), 1);
  assert.equal(out[0], "architecture governance: missing");
  assert.equal(out[2], "missing: vq/architecture/governance.json");

  const { io: ioJson, out: outJson } = captureIo();
  assert.equal(await architectureCommand(makeDeps(files, ioJson), ["check", "--json"]), 0);
  assert.equal((JSON.parse(outJson.join("\n")) as { ok: boolean }).ok, false);

  await architectureCommand(makeDeps(files, captureIo().io), ["init"]);
  const { io: io2, out: out2 } = captureIo();
  assert.equal(await architectureCommand(makeDeps(files, io2), ["check"]), 0);
  assert.equal(out2[0], "architecture governance: ok");
});

test("architecture import-mmd: usage, containment ir sėkmingas importas", async () => {
  const files = new Map<string, string>();
  const { io, err } = captureIo();
  assert.equal(await architectureCommand(makeDeps(files, io), ["import-mmd"]), 2);
  assert.equal(err[0], "Usage: verqestra architecture import-mmd <file>");

  const { io: ioEsc, err: errEsc } = captureIo();
  assert.equal(await architectureCommand(makeDeps(files, ioEsc), ["import-mmd", "../evil.mmd"]), 2);
  assert.equal(errEsc[0], "import-mmd: failas turi būti projekto kataloge");

  files.set(abs("vq/architecture/source/main.mmd"), "flowchart TD\n  A[Git Repository] --> B[Parseris]\n");
  const { io: ioOk, out } = captureIo();
  assert.equal(await architectureCommand(makeDeps(files, ioOk), ["import-mmd", "vq/architecture/source/main.mmd"]), 0);
  assert.deepEqual(out, ["nodes: 2", "edges: 1"]);
  const graph = JSON.parse(files.get(abs("vq/state/architecture/graph.json"))!) as ArchitectureGraph;
  assert.equal(graph.nodes.find((n) => n.id === "A")?.external, true);
  assert.equal(storedProgress(files).nodes["B"]?.status, "planned");
});

test("architecture next-node: ready mazgas ir no ready node", async () => {
  const files = new Map<string, string>();
  seedState(files, B_GRAPH, { B: nodeProgress() });
  const { io, out } = captureIo();
  assert.equal(await architectureCommand(makeDeps(files, io), ["next-node"]), 0);
  assert.deepEqual(out, ["id: B", "label: Parseris"]);

  seedState(files, B_GRAPH, { B: nodeProgress({ status: "done" }) });
  const { io: io2, out: out2 } = captureIo();
  assert.equal(await architectureCommand(makeDeps(files, io2), ["next-node"]), 0);
  assert.deepEqual(out2, ["no ready node"]);
});

test("architecture next-node: be grafo — klaida ir exit 2", async () => {
  const { io, err } = captureIo();
  assert.equal(await architectureCommand(makeDeps(new Map(), io), ["next-node"]), 2);
  assert.match(err[0] ?? "", /architecture graph not found/);
});

test("architecture synthesize-node: usage, nežinomas mazgas, evidence disciplina", async () => {
  const files = new Map<string, string>();
  seedState(files, B_GRAPH, { B: nodeProgress() });
  const { io, err } = captureIo();
  assert.equal(await architectureCommand(makeDeps(files, io), ["synthesize-node"]), 2);
  assert.equal(err[0], "Usage: verqestra architecture synthesize-node <node-id> [--write]");

  const { io: io2, err: err2 } = captureIo();
  assert.equal(await architectureCommand(makeDeps(files, io2), ["synthesize-node", "X"]), 2);
  assert.equal(err2[0], "node not found: X");

  const { io: io3, err: err3 } = captureIo();
  assert.equal(await architectureCommand(makeDeps(files, io3), ["synthesize-node", "B"]), 2);
  assert.match(err3[0] ?? "", /refusing to synthesize a fabricated task/);
});

test("architecture synthesize-node: preview nerašo, --write rašo ir antras kartas skipina", async () => {
  const files = new Map<string, string>();
  seedState(files, B_GRAPH, { B: nodeProgress() });
  files.set(abs("vq/state/architecture/evidence.jsonl"), B_EVIDENCE);

  const { io: ioPrev, out: outPrev } = captureIo();
  assert.equal(await architectureCommand(makeDeps(files, ioPrev), ["synthesize-node", "B"]), 0);
  assert.ok(outPrev.join("\n").startsWith("# Task"));
  assert.ok(!files.has(abs("AG/tasks/queue/synthesize-B-1111.md")));

  const { io: ioWrite, out: outWrite } = captureIo();
  assert.equal(await architectureCommand(makeDeps(files, ioWrite), ["synthesize-node", "B", "--write"]), 0);
  assert.deepEqual(outWrite, ["run_id: synthesize-B-1111", "task: AG/tasks/queue/synthesize-B-1111.md"]);
  assert.ok(files.has(abs("AG/tasks/queue/synthesize-B-1111.md")));
  assert.ok(files.has(abs("vq/state/architecture/task-synthesis/synthesize-B-1111.json")));
  assert.equal(storedProgress(files).nodes["B"]?.status, "queued");

  const { io: ioAgain, out: outAgain } = captureIo();
  assert.equal(await architectureCommand(makeDeps(files, ioAgain), ["synthesize-node", "B", "--write"]), 0);
  assert.deepEqual(outAgain, ["skipped: B (queued)"]);
});

test("architecture verify-node: pass persistina done, fail eina per bounded repair", async () => {
  const files = new Map<string, string>();
  seedState(files, B_GRAPH, { B: nodeProgress({ status: "queued", implemented_files: ["src/b.ts"] }) });
  files.set(abs("src/b.ts"), "export const b = 1;\n");
  files.set(abs("src/b.test.ts"), "test\n");
  const { io, out } = captureIo();
  assert.equal(await architectureCommand(makeDeps(files, io), ["verify-node", "B"]), 0);
  assert.deepEqual(out, ["passed: true"]);
  assert.equal(storedProgress(files).nodes["B"]?.status, "done");

  seedState(files, B_GRAPH, {
    B: nodeProgress({
      status: "queued",
      implemented_files: ["src/b.ts"],
      interface_contract: { inputs: [], outputs: [], upstream: [], downstream: [], public_exports: ["foo"], checks: [] },
    }),
  });
  const { io: io2, out: out2 } = captureIo();
  assert.equal(await architectureCommand(makeDeps(files, io2), ["verify-node", "B"]), 2);
  assert.equal(out2[0], "passed: false");
  assert.equal(out2[1], 'failure: Required export "foo" not found in implemented files.');
  assert.equal(out2[2], 'repair: repair (Attempt 1 of 3 for "unclear-interface".)');
  assert.equal(storedProgress(files).nodes["B"]?.status, "repairing");
});

test("architecture verify-node --json: verdiktas JSON'e, exit 0 (etalono paritetas)", async () => {
  const files = new Map<string, string>();
  seedState(files, B_GRAPH, {
    B: nodeProgress({ status: "queued", implemented_files: ["src/missing.ts"] }),
  });
  const { io, out } = captureIo();
  assert.equal(await architectureCommand(makeDeps(files, io), ["verify-node", "B", "--json"]), 0);
  const parsed = JSON.parse(out.join("\n")) as { passed: boolean; repair?: { action: string } };
  assert.equal(parsed.passed, false);
  assert.equal(parsed.repair?.action, "repair");
});

test("architecture run-tree: be grafo — exit 2, su ready mazgu — sintezė", async () => {
  const { io, err } = captureIo();
  assert.equal(await architectureCommand(makeDeps(new Map(), io), ["run-tree"]), 2);
  assert.match(err[0] ?? "", /architecture graph\/progress not found/);

  const files = new Map<string, string>();
  seedState(files, B_GRAPH, { B: nodeProgress() });
  files.set(abs("vq/state/architecture/evidence.jsonl"), B_EVIDENCE);
  const { io: io2, out } = captureIo();
  assert.equal(await architectureCommand(makeDeps(files, io2), ["run-tree"]), 0);
  assert.ok(out.includes("synthesized: B"));
  assert.ok(out.includes("synthesized: 1"));
  assert.ok(files.has(abs("AG/tasks/queue/run-tree-B-1111.md")));
});

test("architecture code-map: usage, tuščias projektas 100%, --check be failo", async () => {
  const files = new Map<string, string>();
  const { io, err } = captureIo();
  assert.equal(await architectureCommand(makeDeps(files, io), ["code-map"]), 2);
  assert.equal(err[0], "Usage: verqestra architecture code-map --write|--check [--json]");

  const { io: io2, out } = captureIo();
  assert.equal(await architectureCommand(makeDeps(files, io2), ["code-map", "--write"]), 0);
  assert.equal(out[0], "code-map: write");
  assert.ok(out.includes("symbols_total: 0"));
  assert.ok(out.includes("coverage_percent: 100"));
  assert.ok(files.has(abs("vq/architecture/generated/code-map.generated.mmd")));
  assert.ok(files.has(abs("vq/architecture/generated/code-map.coverage.json")));

  files.delete(abs("vq/architecture/generated/code-map.generated.mmd"));
  const { io: io3, err: err3 } = captureIo();
  assert.equal(await architectureCommand(makeDeps(files, io3), ["code-map", "--check"]), 2);
  assert.match(err3[0] ?? "", /code map not found/);
});

test("architecture: nežinoma subkomanda — usage klaida per catch", async () => {
  const { io, err } = captureIo();
  assert.equal(await architectureCommand(makeDeps(new Map(), io), ["frobnicate"]), 2);
  assert.match(err[0] ?? "", /^Usage: verqestra architecture \[init\|check/);
});

test("governance stack decision: persist tik su inputSignals, load valiadavęs", async () => {
  const files = new Map<string, string>();
  const { io } = captureIo();
  const deps = makeDeps(files, io);
  const decision: StackDecision = {
    selectedLanguage: "typescript",
    selectedFramework: null,
    architectureStyle: "layered",
    inputSignals: ["app-type:cli"],
    alternativesConsidered: [],
    confidence: "high",
    reason: "test",
    humanReviewRequired: false,
  };
  const persisted = await persistStackDecisionState(deps.wave.fs, decision, ROOT);
  assert.equal(persisted.persisted, true);
  const loaded = await loadStackDecisionState(deps.wave.fs, ROOT);
  assert.equal(loaded?.selectedLanguage, "typescript");

  const files2 = new Map<string, string>();
  const deps2 = makeDeps(files2, io);
  const explicit = await persistStackDecisionState(deps2.wave.fs, { ...decision, inputSignals: [] }, ROOT);
  assert.equal(explicit.persisted, false);
  assert.equal(await loadStackDecisionState(deps2.wave.fs, ROOT), undefined);
});
