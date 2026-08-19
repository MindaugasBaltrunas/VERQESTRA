// VQ-201: task-graph kontraktų testai — build normalizacija, hash stabilumas ir
// sąlyginiai laukai, traverse (exact>prefix, ciklai, gyliai), validate kodai.
// Elgesio atvejai perkelti iš AG_loop task-graph.test.ts branduolio.
import assert from "node:assert/strict";
import test from "node:test";
import {
  TASK_GRAPH_SCHEMA_VERSION,
  assertExecutableTaskGraph,
  buildTaskGraph,
  computeTaskGraphHash,
  dependenciesOf,
  detectTaskGraphCycles,
  internalEdges,
  resolveTaskNode,
  taskGraphDepths,
  taskNodeStatusFromBucket,
  validateTaskGraph,
  type TaskGraph,
} from "../domain/tasks/graph/index.js";

function graphOf(overrides: Parameters<typeof buildTaskGraph>[0]): TaskGraph {
  return buildTaskGraph(overrides);
}

test("build: normalizes ids/paths, drops placeholders, dedups and sorts edges, stamps hash", () => {
  const graph = graphOf({
    nodes: [
      { task_id: "0002-b", file: "AG\\tasks\\queue\\0002-b.md", depends_on: ["0001-a", "none", "0001-a"] },
      { task_id: "0001-a", file: "AG/tasks/queue/0001-a.md", checks: [" pnpm test ", ""], scope: ["src/**"] },
    ],
    dependencies: [{ task_id: "0002-b", depends_on: "0001-a", origin: "runtime" }],
  });
  assert.deepEqual(
    graph.nodes.map((node) => node.task_id),
    ["0001-a", "0002-b"],
  );
  assert.equal(graph.nodes[0]?.file, "AG/tasks/queue/0001-a.md");
  assert.deepEqual(graph.nodes[0]?.checks, ["pnpm test"]);
  assert.deepEqual(
    graph.dependencies.map((edge) => `${edge.task_id}<-${edge.depends_on}:${edge.origin}`),
    ["0002-b<-0001-a:markdown", "0002-b<-0001-a:runtime"],
  );
  assert.match(graph.graph_hash, /^tg1:[0-9a-f]{16}$/);
  assert.equal(graph.graph_hash, computeTaskGraphHash(graph));
});

test("hash: order-insensitive, status-sensitive, conditional write_symbols keeps legacy hashes", () => {
  const base = graphOf({
    nodes: [
      { task_id: "0001-a", file: "a.md" },
      { task_id: "0002-b", file: "b.md" },
    ],
  });
  const reordered = graphOf({
    nodes: [
      { task_id: "0002-b", file: "b.md" },
      { task_id: "0001-a", file: "a.md" },
    ],
  });
  assert.equal(base.graph_hash, reordered.graph_hash, "same plan -> same hash");
  const statusChanged = graphOf({
    nodes: [
      { task_id: "0001-a", file: "a.md", status: "done" },
      { task_id: "0002-b", file: "b.md" },
    ],
  });
  assert.notEqual(base.graph_hash, statusChanged.graph_hash);
  const declaring = graphOf({
    nodes: [
      { task_id: "0001-a", file: "a.md", write_symbols: ["a.ts#run"] },
      { task_id: "0002-b", file: "b.md" },
    ],
  });
  assert.notEqual(base.graph_hash, declaring.graph_hash);
  const emptyDeclared = graphOf({
    nodes: [
      { task_id: "0001-a", file: "a.md", write_symbols: [] },
      { task_id: "0002-b", file: "b.md" },
    ],
  });
  assert.equal(base.graph_hash, emptyDeclared.graph_hash, "empty declaration == no declaration");
});

test("traverse: exact match beats prefix, edges resolve abbreviations, depths order the plan", () => {
  const graph = graphOf({
    nodes: [
      { task_id: "0001-a", file: "a.md" },
      { task_id: "0002-b", file: "b.md", depends_on: ["0001"] },
      { task_id: "0003-c", file: "c.md", depends_on: ["0002-b"] },
    ],
  });
  assert.equal(resolveTaskNode(graph, "0001")?.task_id, "0001-a", "prefix fallback");
  assert.equal(resolveTaskNode(graph, "0002-b")?.task_id, "0002-b");
  assert.deepEqual(dependenciesOf(graph, "0002-b"), ["0001"]);
  assert.deepEqual(internalEdges(graph).get("0002-b"), ["0001-a"]);
  const depths = taskGraphDepths(graph);
  assert.equal(depths.get("0001-a"), 0);
  assert.equal(depths.get("0002-b"), 1);
  assert.equal(depths.get("0003-c"), 2);
});

test("cycles: mutual reachability groups participants, depths zero them", () => {
  const graph = graphOf({
    nodes: [
      { task_id: "0001-a", file: "a.md", depends_on: ["0002-b"] },
      { task_id: "0002-b", file: "b.md", depends_on: ["0001-a"] },
      { task_id: "0003-c", file: "c.md" },
    ],
  });
  const { members, groups } = detectTaskGraphCycles(graph);
  assert.deepEqual([...members].sort(), ["0001-a", "0002-b"]);
  assert.deepEqual(groups, [["0001-a", "0002-b"]]);
  // Etalono semantika: ciklo nariams gylis NEkešuojamas — jie map'e neegzistuoja
  // (undefined), o ne 0; ne-ciklo mazgai reikšmes turi.
  const depths = taskGraphDepths(graph);
  assert.equal(depths.get("0001-a"), undefined);
  assert.equal(depths.get("0003-c"), 0);
});

test("validate: every violation code fires and executable gates only on graph scope", () => {
  const cyclic = graphOf({
    nodes: [
      { task_id: "0001-a", file: "a.md", depends_on: ["0002-b"], checks: ["x"], scope: ["s"] },
      { task_id: "0002-b", file: "b.md", depends_on: ["0001-a"], checks: ["x"], scope: ["s"] },
    ],
  });
  const cyclicValidation = validateTaskGraph(cyclic);
  assert.ok(cyclicValidation.violations.some((entry) => entry.code === "dependency-cycle"));
  assert.equal(cyclicValidation.executable, false);
  assert.throws(() => assertExecutableTaskGraph(cyclic), /dependency cycle/);

  const nodeScoped = graphOf({
    nodes: [
      { task_id: "0001-a", file: "a.md", status: "human-review", checks: ["x"], scope: ["s"] },
      { task_id: "0002-b", file: "b.md", depends_on: ["0001-a", "0009-ghost"] },
    ],
  });
  const validation = validateTaskGraph(nodeScoped);
  const codes = validation.violations.map((entry) => entry.code).sort();
  assert.ok(codes.includes("missing-dependency"));
  assert.ok(codes.includes("invalid-terminal-dependency"));
  assert.ok(codes.includes("missing-checks"));
  assert.ok(codes.includes("missing-scope"));
  assert.equal(validation.ok, false, "node-scope errors still fail ok");
  assert.equal(validation.executable, true, "node-scope errors do not invalidate the graph");
  assert.equal(assertExecutableTaskGraph(nodeScoped), nodeScoped);

  const tampered = { ...nodeScoped, graph_hash: "tg1:0000000000000000" };
  assert.ok(validateTaskGraph(tampered).violations.some((entry) => entry.code === "graph-hash-mismatch"));
  const foreignSchema = { ...nodeScoped, schema_version: TASK_GRAPH_SCHEMA_VERSION + 1 };
  assert.ok(validateTaskGraph(foreignSchema).violations.some((entry) => entry.code === "schema-version-mismatch"));
});

test("bucket -> status mapping is the canonical one-way projection", () => {
  assert.equal(taskNodeStatusFromBucket("queue"), "queued");
  assert.equal(taskNodeStatusFromBucket("active"), "running");
  assert.equal(taskNodeStatusFromBucket("delegated"), "running");
  assert.equal(taskNodeStatusFromBucket("error"), "failed");
  assert.equal(taskNodeStatusFromBucket("failed"), "failed");
  assert.equal(taskNodeStatusFromBucket("human-review"), "human-review");
  assert.equal(taskNodeStatusFromBucket("done"), "done");
});
