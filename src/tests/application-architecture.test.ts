// VQ-501 (3/5-c) testai — application/architecture klasteris + domain repair-policy per
// fake portus: evidence JSONL append/read, task sintezės markdown paritetas (backtick
// checks, spec-source tvarka, stack sekcija, evidence blokas), verifyNode taisyklės ir
// done persistencija, repair klasifikacijos lentelė su bandymų limitu.

import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import type {
  ArchitectureGraph,
  ArchitectureNodeProgress,
  ArchitectureProgress,
  NodeInterfaceContract,
} from "../domain/architecture/graph.js";
import {
  classifyRepairableIssue,
  evaluateRepairPolicy,
  UNCLASSIFIED_ISSUE,
} from "../domain/architecture/repair-policy.js";
import {
  appendEvidence,
  appendUnknown,
  readEvidenceLedger,
  readUnknowns,
  type EvidenceEntry,
} from "../application/architecture/evidence-ledger.js";
import { synthesizeTask, writeSynthesisOutput } from "../application/architecture/task-synthesizer.js";
import { verifyNode, type VerifyNodePorts } from "../application/architecture/node-verifier.js";
import type { ArchitectureStateFsPort } from "../application/architecture/ports.js";

const ROOT = path.resolve("/repo");
const norm = (p: string): string => p.replace(/\\/g, "/");

function makeFs(files: Map<string, string>): ArchitectureStateFsPort {
  return {
    exists: async (p) => files.has(norm(p)),
    readTextFileIfExists: async (p) => files.get(norm(p)),
    appendTextFile: async (p, text) => {
      files.set(norm(p), (files.get(norm(p)) ?? "") + text);
    },
    writeTextFile: async (p, text) => {
      files.set(norm(p), text);
    },
  };
}

const emptyContract = (over: Partial<NodeInterfaceContract> = {}): NodeInterfaceContract => ({
  inputs: [],
  outputs: [],
  upstream: [],
  downstream: [],
  public_exports: [],
  checks: [],
  ...over,
});

const nodeProgress = (over: Partial<ArchitectureNodeProgress> = {}): ArchitectureNodeProgress => ({
  status: "active",
  attempts: {},
  queued_tasks: [],
  done_tasks: [],
  implemented_files: [],
  evidence_refs: [],
  ...over,
});

const GRAPH: ArchitectureGraph = {
  source_path: "vq/architecture/source/main.mmd",
  imported_at: "2026-08-20T00:00:00.000Z",
  nodes: [{ id: "n1", label: "Parser", kind: "component", status: "planned", description: "Parsina įvestį." }],
  edges: [],
};

// ---------------------------------------------------------------------------
// repair-policy
// ---------------------------------------------------------------------------

test("classifyRepairableIssue: lentelė ir non-repairable pirmumas", () => {
  assert.equal(
    classifyRepairableIssue(["No test file found for: a", "Implemented file violates forbidden path governance: b"]),
    "governance-violation",
  );
  assert.equal(classifyRepairableIssue(['Node "x" not found in progress ledger.']), "unresolvable-node");
  assert.equal(classifyRepairableIssue(['Downstream node "d" contract does not list "n" as upstream.']), "missing-upstream-stub");
  assert.equal(classifyRepairableIssue(['Required export "foo" not found in implemented files.']), "unclear-interface");
  assert.equal(classifyRepairableIssue(["No test file found for: src/a.ts"]), "missing-test-target");
  assert.equal(classifyRepairableIssue(["Implemented file does not exist: src/a.ts"]), "stale-code-index");
  assert.equal(classifyRepairableIssue(["kažkas visai kito"]), UNCLASSIFIED_ISSUE);
});

test("evaluateRepairPolicy: bandymų limitas ir nerepair'inamos rūšys", () => {
  const first = evaluateRepairPolicy(nodeProgress(), "stale-code-index");
  assert.equal(first.action, "repair");
  assert.equal(first.reason, 'Attempt 1 of 3 for "stale-code-index".');
  assert.deepEqual(first.updated_attempts, { "stale-code-index": 1 });

  const progress = nodeProgress({ attempts: { "stale-code-index": 3 } });
  const capped = evaluateRepairPolicy(progress, "stale-code-index");
  assert.equal(capped.action, "human-review");
  assert.match(capped.reason, /maximum of 3/);
  assert.deepEqual(progress.attempts, { "stale-code-index": 3 });

  const unrepairable = evaluateRepairPolicy(nodeProgress(), "governance-violation");
  assert.equal(unrepairable.action, "human-review");
  assert.match(unrepairable.reason, /not repairable automatically/);
});

// ---------------------------------------------------------------------------
// evidence-ledger
// ---------------------------------------------------------------------------

test("evidence ledger: append rašo JSONL, read filtruoja tuščias eilutes, nesamas failas → []", async () => {
  const files = new Map<string, string>();
  const fs = makeFs(files);
  const ledger = path.join(ROOT, "vq", "state", "architecture", "evidence.jsonl");
  const entry: EvidenceEntry = { node_id: "n1", source: "README.md", excerpt: "aprašymas", timestamp: "t1" };
  await appendEvidence(fs, ledger, entry);
  await appendEvidence(fs, ledger, { ...entry, timestamp: "t2" });
  files.set(norm(ledger), `${files.get(norm(ledger))}\n`);
  const entries = await readEvidenceLedger(fs, ledger);
  assert.equal(entries.length, 2);
  assert.equal(entries[1]?.timestamp, "t2");
  assert.deepEqual(await readEvidenceLedger(fs, path.join(ROOT, "nėra.jsonl")), []);

  const unknowns = path.join(ROOT, "vq", "state", "architecture", "unknowns.jsonl");
  await appendUnknown(fs, unknowns, { node_id: "n1", reason: "neaišku", timestamp: "t3", repair_attempts: 0 });
  assert.equal((await readUnknowns(fs, unknowns))[0]?.reason, "neaišku");
});

// ---------------------------------------------------------------------------
// task-synthesizer
// ---------------------------------------------------------------------------

test("synthesizeTask: default'ai — slug failai, backtick checks, evidence marker, node aprašymas", () => {
  const progress: ArchitectureProgress = { graph_hash: "h", nodes: { n1: nodeProgress() } };
  const result = synthesizeTask({
    nodeId: "n1",
    graph: GRAPH,
    progress,
    evidence: [],
    contract: emptyContract(),
    runId: "r1",
  });
  assert.equal(result.node_label, "Parser");
  assert.equal(result.evidence_count, 0);
  assert.deepEqual(result.allowed_files, ["src/n1.ts", "src/tests/n1.test.ts"]);
  assert.ok(result.markdown.startsWith("# Task"));
  assert.ok(result.markdown.includes("architecture-node/n1 (run: r1)"));
  assert.ok(result.markdown.includes("Parsina įvestį."));
  assert.ok(result.markdown.includes("readme-guard"));
  assert.ok(result.markdown.includes("- `pnpm build`\n- `pnpm test`"));
  assert.ok(result.markdown.includes("_Nėra upstream/downstream sąsajų._"));
  assert.ok(result.markdown.includes("_No evidence entries found. Evidence repair required._"));
  assert.ok(!result.markdown.includes("\n\n\n"));
});

test("synthesizeTask: specSource pirmas, implemented_files perima, stack ir kontrakto sekcijos", () => {
  const progress: ArchitectureProgress = {
    graph_hash: "h",
    nodes: { n1: nodeProgress({ implemented_files: ["src/parser/core.ts"] }) },
  };
  const result = synthesizeTask({
    nodeId: "n1",
    graph: GRAPH,
    progress,
    evidence: [{ node_id: "n1", source: "README.md", excerpt: "faktas", timestamp: "t1" }],
    contract: emptyContract({
      upstream: ["n0"],
      inputs: ["raw text"],
      public_exports: ["parse"],
      checks: ["pnpm test"],
    }),
    runId: "r2",
    specSource: "openspec/changes/auto-0001-x",
    stackDecision: {
      selectedLanguage: "typescript",
      selectedFramework: null,
      architectureStyle: "layered",
      inputSignals: [],
      alternativesConsidered: [],
      confidence: "high",
      reason: "test",
      humanReviewRequired: false,
    },
  });
  const md = result.markdown;
  assert.ok(md.indexOf("openspec/changes/auto-0001-x") < md.indexOf("architecture-node/n1 (run: r2)"));
  assert.deepEqual(result.allowed_files, ["src/parser/core.ts"]);
  assert.ok(md.includes("- language: typescript"));
  assert.ok(md.includes("- framework: (not specified)"));
  assert.ok(md.includes("**Upstream:**\n- upstream node: `n0`\n  - input: raw text"));
  assert.ok(md.includes("**Expected exports:** parse"));
  assert.ok(md.includes("## Patikra\n\n- `pnpm test`"));
  assert.ok(md.includes("- [README.md] faktas _(node: n1, t1)_"));
});

test("writeSynthesisOutput: įrašo <statePath>/<run_id>.json", async () => {
  const files = new Map<string, string>();
  const statePath = path.join(ROOT, "vq", "state", "architecture", "task-synthesis");
  const progress: ArchitectureProgress = { graph_hash: "h", nodes: { n1: nodeProgress() } };
  const result = synthesizeTask({ nodeId: "n1", graph: GRAPH, progress, evidence: [], contract: emptyContract(), runId: "r9" });
  await writeSynthesisOutput(makeFs(files), statePath, result);
  const written = files.get(norm(path.join(statePath, "r9.json")));
  assert.ok(written);
  assert.equal((JSON.parse(written) as { node_id: string }).node_id, "n1");
});

// ---------------------------------------------------------------------------
// node-verifier
// ---------------------------------------------------------------------------

function verifierPorts(files: Map<string, string>): {
  ports: VerifyNodePorts;
  updates: Array<{ nodeId: string; update: Partial<ArchitectureNodeProgress> }>;
} {
  const updates: Array<{ nodeId: string; update: Partial<ArchitectureNodeProgress> }> = [];
  return {
    ports: {
      fs: makeFs(files),
      progress: {
        updateNodeProgress: async (nodeId, update) => {
          updates.push({ nodeId, update });
        },
      },
      nowIso: () => "2026-08-20T12:00:00.000Z",
    },
    updates,
  };
}

test("verifyNode: praeinantis mazgas persistina done + verified_at", async () => {
  const files = new Map<string, string>([
    [norm(path.join(ROOT, "src/a.ts")), "export function foo(): void {}\n"],
    [norm(path.join(ROOT, "src/a.test.ts")), "import { foo } from './a.js';\n"],
  ]);
  const { ports, updates } = verifierPorts(files);
  const progress: ArchitectureProgress = {
    graph_hash: "h",
    nodes: {
      n1: nodeProgress({
        implemented_files: ["src/a.ts"],
        interface_contract: emptyContract({ public_exports: ["foo"] }),
      }),
    },
  };
  const result = await verifyNode(ports, "n1", GRAPH, progress, ROOT);
  assert.equal(result.passed, true);
  assert.equal(result.verified_at, "2026-08-20T12:00:00.000Z");
  assert.deepEqual(updates, [{ nodeId: "n1", update: { status: "done", verified_at: "2026-08-20T12:00:00.000Z" } }]);
});

test("verifyNode: persistSuccess=false nerašo progreso", async () => {
  const files = new Map<string, string>([
    [norm(path.join(ROOT, "src/a.ts")), "export const x = 1;\n"],
    [norm(path.join(ROOT, "src/a.test.ts")), "x\n"],
  ]);
  const { ports, updates } = verifierPorts(files);
  const progress: ArchitectureProgress = { graph_hash: "h", nodes: { n1: nodeProgress({ implemented_files: ["src/a.ts"] }) } };
  const result = await verifyNode(ports, "n1", GRAPH, progress, ROOT, undefined, false);
  assert.equal(result.passed, true);
  assert.deepEqual(updates, []);
});

test("verifyNode: failure taisyklės — missing file/export/test, dist importas, ledger", async () => {
  const files = new Map<string, string>([
    [norm(path.join(ROOT, "src/b.ts")), 'import { z } from "../dist/z.js";\nexport const b = 1;\n'],
  ]);
  const { ports, updates } = verifierPorts(files);
  const progress: ArchitectureProgress = {
    graph_hash: "h",
    nodes: {
      n1: nodeProgress({
        implemented_files: ["src/a.ts", "src/b.ts"],
        interface_contract: emptyContract({ public_exports: ["foo"] }),
      }),
    },
  };
  const result = await verifyNode(ports, "n1", GRAPH, progress, ROOT);
  assert.equal(result.passed, false);
  assert.ok(result.failures.includes("Implemented file does not exist: src/a.ts"));
  assert.ok(result.failures.includes('Required export "foo" not found in implemented files.'));
  assert.ok(result.failures.includes("No test file found for: src/a.ts"));
  assert.ok(result.failures.includes("No test file found for: src/b.ts"));
  assert.ok(result.failures.includes('File "src/b.ts" imports from a forbidden dist path: "../dist/z.js"'));
  assert.deepEqual(updates, []);

  const missing = await verifyNode(ports, "nėra", GRAPH, progress, ROOT);
  assert.deepEqual(missing.failures, ['Node "nėra" not found in progress ledger.']);
});

test("verifyNode: policy blockers krauna passed=false, warnings — ne", async () => {
  const files = new Map<string, string>([
    [norm(path.join(ROOT, "src/a.ts")), "export const x = 1;\n"],
    [norm(path.join(ROOT, "src/a.test.ts")), "x\n"],
  ]);
  const { ports } = verifierPorts(files);
  const progress: ArchitectureProgress = { graph_hash: "h", nodes: { n1: nodeProgress({ implemented_files: ["src/a.ts"] }) } };
  const policies = {
    architectureStyle: { strictness: "block", forbidden_dependencies: ["ui->db"] },
    codingPrinciples: {},
    enforcement: { require_interface_contract_for_public_changes: true },
  };
  const blocked = await verifyNode(ports, "n1", GRAPH, progress, ROOT, policies);
  assert.equal(blocked.passed, false);
  assert.deepEqual(blocked.policy_blockers, ['Forbidden dependency: "ui->db"']);
  assert.match(blocked.policy_warnings[0] ?? "", /missing an interface_contract/);

  const warned = await verifyNode(ports, "n1", GRAPH, progress, ROOT, {
    ...policies,
    architectureStyle: { strictness: "warn", forbidden_dependencies: ["ui->db"] },
  });
  assert.equal(warned.passed, true);
  assert.deepEqual(warned.policy_blockers, []);
});
