// Persistence adapterių integraciniai testai (E4 VQ-403 1/2) — reali FS laikinuose
// kataloguose: runtime attempt store (write-once/CAS/tapatybė), task-graph snapshot,
// code-index store (JSONL byte-compat forma) ir state-history.

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { buildTaskGraph } from "../domain/tasks/graph/index.js";
import { parseTaskUsageEntries } from "../domain/tokens/usage-ledger.js";
import type { AttemptRef } from "../application/scheduling/worker-limits.js";
import { nodeFsAdapter } from "../infrastructure/fs/node-fs-adapter.js";
import { ABSENT_REVISION } from "../infrastructure/persistence/runtime-artifact-io.js";
import {
  appendUsageEntry,
  createAttempt,
  nextAttemptId,
  openAttempt,
  readAttemptManifest,
  writeAttemptJsonWithRetry,
  writeJsonArtifact,
  writeTextArtifact,
} from "../infrastructure/persistence/runtime-artifact-store.js";
import {
  createManifest,
  readCodeIndex,
  writeCodeIndex,
  codeIndexPath,
} from "../infrastructure/persistence/code-index-store.js";
import {
  readTaskGraphSnapshot,
  writeTaskGraphSnapshot,
} from "../infrastructure/persistence/task-graph-store.js";
import {
  appendStateHistory,
  readStateHistory,
  resolveHumanReviewStatus,
  stateHistoryPath,
} from "../infrastructure/state/state-history.js";

const projectRoot = await mkdtemp(path.join(tmpdir(), "vq-persist-"));
const runtimeRoot = path.join(projectRoot, "vq");
after(async () => {
  await rm(projectRoot, { recursive: true, force: true });
});

const REF: AttemptRef = { runId: "r1", workerId: "w1", taskId: "0042-task", attemptId: "a1" };

const CREATE_INPUT = {
  runtimeRoot,
  ref: REF,
  graphHash: "none",
  policy: { agent_chain: ["readme-guard", "coder"] },
  source: { origin: "queue-task", task_file: "AG/tasks/queue/0042-task.md" },
  createdAt: "2026-08-20T12:00:00.000Z",
};

test("createAttempt: užima id kartą; antras bandymas — already-exists ir NIEKAS nemodifikuojama", async () => {
  const created = await createAttempt(CREATE_INPUT);
  assert.equal(created.ok, true, JSON.stringify(created));
  if (!created.ok) return;
  assert.equal(created.value.manifest.task_id, "0042-task");
  assert.equal(created.value.manifest.attempt_sequence, 1);

  const again = await createAttempt(CREATE_INPUT);
  assert.equal(again.ok, false);
  if (!again.ok) assert.equal(again.reason, "already-exists");
});

test("tapatybė įrodoma: svetimas manifestas kataloge — identity-mismatch", async () => {
  // Sukuriamas a2 katalogas su a1 manifesto BAITAIS — skaitymas privalo tai atmesti.
  const foreignRef: AttemptRef = { ...REF, attemptId: "a2" };
  const a1Dir = path.join(runtimeRoot, "runtime", "runs", "r1", "workers", "w1", "tasks", "0042-task", "attempts");
  const manifestBytes = await readFile(path.join(a1Dir, "a1", "manifest.json"), "utf8");
  await nodeFsAdapter.makeDirectory(path.join(a1Dir, "a2"));
  await nodeFsAdapter.writeTextFile(path.join(a1Dir, "a2", "manifest.json"), manifestBytes);

  const read = await readAttemptManifest(runtimeRoot, foreignRef);
  assert.equal(read.ok, false);
  if (!read.ok) {
    assert.equal(read.reason, "identity-mismatch");
    assert.ok(read.errors.some((line) => line.includes("attempt_id")));
  }
});

test("write-once ir CAS politikos: task.md neperrašomas, execution-result reikalauja revision", async () => {
  const text = await writeTextArtifact(runtimeRoot, REF, "task", "# Task\n");
  assert.equal(text.ok, true);
  const textAgain = await writeTextArtifact(runtimeRoot, REF, "task", "kitas\n");
  assert.equal(textAgain.ok, false);
  if (!textAgain.ok) assert.equal(textAgain.reason, "already-exists");

  const noRevision = await writeJsonArtifact(runtimeRoot, REF, "execution-result", { status: "ok" });
  assert.equal(noRevision.ok, false);
  if (!noRevision.ok) assert.equal(noRevision.reason, "revision-required");

  const first = await writeJsonArtifact(runtimeRoot, REF, "execution-result", { status: "ok" }, { expectedRevision: ABSENT_REVISION });
  assert.equal(first.ok, true, JSON.stringify(first));

  const stale = await writeJsonArtifact(runtimeRoot, REF, "execution-result", { status: "kitas" }, { expectedRevision: ABSENT_REVISION });
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.equal(stale.reason, "revision-mismatch");

  const handle = await openAttempt(runtimeRoot, REF);
  assert.equal(handle.ok, true);
  if (!handle.ok) return;
  const retried = await writeAttemptJsonWithRetry(handle.data, "execution-result", { status: "atnaujintas" });
  assert.equal(retried.ok, true, JSON.stringify(retried));
});

test("appendUsage: eilutės skaitomos kanoniniu parseTaskUsageEntries; nextAttemptId — max+1", async () => {
  const appended = await appendUsageEntry(runtimeRoot, REF, { task_id: "0042-task", phase: "dispatch", input_tokens: 10 });
  assert.equal(appended.ok, true);
  if (!appended.ok) return;
  const raw = await nodeFsAdapter.readTextFile(appended.value.path);
  const entries = parseTaskUsageEntries(raw);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.task_id, "0042-task");

  const next = await nextAttemptId(runtimeRoot, { runId: "r1", workerId: "w1", taskId: "0042-task" });
  assert.equal(next.ok, true);
  if (next.ok) assert.deepEqual(next.value, { attemptId: "a3", sequence: 3 });
});

test("task-graph snapshot: atominis roundtrip; sugadintas hash — corrupted", async () => {
  const graph = buildTaskGraph({
    nodes: [
      { task_id: "t1", file: "AG/tasks/queue/t1.md", checks: ["pnpm test"], scope: ["src/**"] },
      { task_id: "t2", file: "AG/tasks/queue/t2.md", depends_on: ["t1"] },
    ],
  });
  await writeTaskGraphSnapshot(graph, runtimeRoot, { source: "test", generatedAt: "2026-08-20T12:00:00.000Z" });

  const read = await readTaskGraphSnapshot(runtimeRoot);
  assert.equal(read.ok, true, JSON.stringify(read));
  if (read.ok) {
    assert.deepEqual(read.graph, graph);
    assert.equal(read.snapshot.source, "test");
  }

  // Hash'o sugadinimas diske privalo būti aptiktas skaitymo vartuose.
  const target = path.join(runtimeRoot, "state", "task-graph.json");
  const rawSnapshot = JSON.parse(await nodeFsAdapter.readTextFile(target)) as { graph_hash: string };
  rawSnapshot.graph_hash = "tg1:0000000000000000";
  await nodeFsAdapter.writeTextFile(target, JSON.stringify(rawSnapshot, null, 2));
  const corrupted = await readTaskGraphSnapshot(runtimeRoot);
  assert.equal(corrupted.ok, false);
  if (!corrupted.ok) assert.equal(corrupted.reason, "corrupted");

  // Nesutampančiu hash'u grafo rašyti NEGALIMA.
  await assert.rejects(
    () => writeTaskGraphSnapshot({ ...graph, graph_hash: "tg1:0000000000000000" }, runtimeRoot),
    /snapshot refused/,
  );
});

test("code-index store: JSONL byte-compat forma ir manifest roundtrip", async () => {
  const file = {
    path: "src/a.ts",
    hash: "abc",
    size: 10,
    language: "typescript" as const,
    kind: "source" as const,
    imports: [],
    exports: ["a"],
    symbols: ["src/a.ts#a"],
    isTest: false,
  };
  const symbol = { id: "src/a.ts#a", file: "src/a.ts", name: "a", kind: "function" as const, exported: true };
  const edge = { from: "src/a.ts", to: "src/b.ts", type: "imports" as const };
  const manifest = createManifest(projectRoot, [file], [symbol], [edge], "hash-1");

  await writeCodeIndex(runtimeRoot, { manifest, files: [file], symbols: [symbol], edges: [edge] });

  // BYTE forma: po vieną JSON.stringify eilutę + galinis \n (AG_loop formato kontraktas).
  const filesRaw = await nodeFsAdapter.readTextFile(codeIndexPath(runtimeRoot, "files.jsonl"));
  assert.equal(filesRaw, `${JSON.stringify(file)}\n`);

  const read = await readCodeIndex(runtimeRoot);
  assert.deepEqual(read.files, [file]);
  assert.deepEqual(read.symbols, [symbol]);
  assert.deepEqual(read.edges, [edge]);
  assert.equal(read.manifest.source_hash, "hash-1");
});

test("state-history: append/read roundtrip, o resolveHumanReviewStatus sprendžia iš paskutinio įvykio", async () => {
  const filePath = stateHistoryPath(runtimeRoot);
  await appendStateHistory(filePath, {
    task_id: "t1",
    previous_folder: "queue",
    next_folder: "human-review",
    result: "routed",
    reason: "gates raudoni",
  });
  await appendStateHistory(filePath, {
    task_id: "t1",
    previous_folder: "human-review",
    next_folder: "human-review",
    result: "resolved",
    reason: "operatorius patvirtino",
  });
  const history = await readStateHistory(filePath);
  assert.equal(history.length, 2);
  assert.equal(resolveHumanReviewStatus(history, "t1"), "resolved");
  assert.equal(resolveHumanReviewStatus(history, "t2"), "pending");
  assert.equal(resolveHumanReviewStatus([...history].reverse(), "t1"), "pending");
});
