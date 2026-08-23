// VQ-201: task-graph kontraktų testai — build normalizacija, hash stabilumas ir
// sąlyginiai laukai, traverse (exact>prefix, ciklai, gyliai), validate kodai.
// Elgesio atvejai perkelti iš AG_loop task-graph.test.ts branduolio.
import assert from "node:assert/strict";
import test from "node:test";
import {
  TASK_GRAPH_SCHEMA_VERSION,
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

test("build: dedup key is injective — adjacent ids do not merge distinct edges", () => {
  // Be skirtuko rakte "ab"+"c" ir "a"+"bc" suliedavo į "abc" ir viena briauna tyliai dingdavo.
  const graph = graphOf({
    nodes: [
      { task_id: "a", file: "a.md" },
      { task_id: "ab", file: "ab.md" },
      { task_id: "bc", file: "bc.md" },
      { task_id: "c", file: "c.md" },
    ],
    dependencies: [
      { task_id: "ab", depends_on: "c" },
      { task_id: "a", depends_on: "bc" },
    ],
  });
  assert.deepEqual(
    graph.dependencies.map((edge) => `${edge.task_id}<-${edge.depends_on}`),
    ["a<-bc", "ab<-c"],
  );
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
  // `executable: false` yra visa elgsena. Iki 2026-08-22 čia buvo dar ir
  // `assertExecutableTaskGraph` — metanti apvalkalė, kurios doc'as teigė esąs „the single guard
  // every execution path goes through" ir kurios nekvietė niekas. Ištrinta kartu su ja: eilutė
  // aukščiau tikrina tą patį sprendimą, tik ties jo šaltiniu.
  assert.equal(cyclicValidation.executable, false);

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

  const tampered = { ...nodeScoped, graph_hash: "tg1:0000000000000000" };
  assert.ok(validateTaskGraph(tampered).violations.some((entry) => entry.code === "graph-hash-mismatch"));
  const foreignSchema = { ...nodeScoped, schema_version: TASK_GRAPH_SCHEMA_VERSION + 1 };
  assert.ok(validateTaskGraph(foreignSchema).violations.some((entry) => entry.code === "schema-version-mismatch"));
});

/**
 * 2026-08-23 (operatoriaus radinys): svetimos TAISYKLIŲ versijos grafas praeidavo domeno vartus.
 *
 * `validateTaskGraph` tikrino schemą ir hash'ą, bet ne `rules_version`, tad grafas su
 * `rules_version: 999` ir PERSKAIČIUOTU hash'u grąžindavo `ok: true` / `executable: true` — ir,
 * kadangi `executable` yra produkcinis vykdymo vartas, būtų buvęs vykdomas. Persistencijos
 * adapteris tai gaudė atskirai, bet domeno API kontraktas liko neteisingas.
 */
test("validate: svetima rules_version yra grafo lygio klaida, o hash prefiksas ją įvardija", () => {
  const base = graphOf({ nodes: [{ task_id: "0001-a", file: "a.md", checks: ["x"], scope: ["s"] }] });
  assert.equal(validateTaskGraph(base).executable, true, "kontrolė: einamosios taisyklės praeina");

  const foreignRules = { ...base, rules_version: 999 };
  // Hash perskaičiuojamas — būtent taip radinys ir apeidavo vienintelį turėtą vartą.
  foreignRules.graph_hash = computeTaskGraphHash(foreignRules);

  const validation = validateTaskGraph(foreignRules);
  assert.ok(
    validation.violations.some((entry) => entry.code === "rules-version-mismatch"),
    "taisyklių versija tikrinama kaip ir schema",
  );
  assert.equal(validation.ok, false);
  assert.equal(validation.executable, false, "svetimos taisyklės sustabdo VISĄ grafą");
  assert.ok(
    validation.violations.every((entry) => entry.code !== "graph-hash-mismatch"),
    "hash'as sutampa — tai antras, NEPRIKLAUSOMAS signalas, o ne tas pats",
  );

  // Prefiksas ima GRAFO taisykles: anksčiau abu variantai duodavo `tg1:` ir buvo neatskiriami.
  assert.match(foreignRules.graph_hash, /^tg999:/);
  assert.match(base.graph_hash, /^tg1:/, "realiam grafui forma nepakito");
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

/**
 * Viena nuorodų atitikimo taisyklė, ne dvi.
 *
 * `resolveTaskNode` buvo vienkryptė (`node.startsWith(ref + "-")`), o domeno `dependencyMatches` —
 * simetriška. Tas pats klausimas gaudavo du atsakymus: mazgui `1111` nuoroda `1111-fix-parser`
 * planuotojui buvo `missing-dependency`, o `schedule-next-wave` ir `route-blocked` laikė ją
 * atitikmeniu. Abu fail-closed, tad nesaugaus planavimo nebuvo — bet dvi taisyklės tam pačiam
 * klausimui yra vieta, kur trečias kvietėjas pasirenka neteisingą.
 */
test("resolve: abi sutrumpinimo kryptys, o dviprasmybė atmetama", () => {
  const abbreviated = graphOf({ nodes: [{ task_id: "1111", file: "AG/tasks/queue/1111.md" }] });
  // Kryptis, kurios anksčiau nebuvo: mazgas trumpas, nuoroda pilna.
  assert.equal(resolveTaskNode(abbreviated, "1111-fix-parser")?.task_id, "1111");
  assert.equal(resolveTaskNode(abbreviated, "1111")?.task_id, "1111");

  // Kryptis, kuri veikė ir anksčiau: mazgas pilnas, nuoroda trumpa.
  const full = graphOf({ nodes: [{ task_id: "2222-rename-store", file: "AG/tasks/queue/2222-rename-store.md" }] });
  assert.equal(resolveTaskNode(full, "2222")?.task_id, "2222-rename-store");

  // Dviprasmybė: `3333` tinka ir `3333-a`, ir `3333-b`. Anksčiau tyliai laimėdavo pirmas pagal id.
  // Klaidingas blokuotojas ATRAKINA task'ą, kuris turėjo laukti, tad teisingas atsakymas yra
  // „nežinau" — o `buildReadySet` jį paverčia `missing-dependency` bloku.
  const ambiguous = graphOf({
    nodes: [
      { task_id: "3333-a", file: "AG/tasks/queue/3333-a.md" },
      { task_id: "3333-b", file: "AG/tasks/queue/3333-b.md" },
    ],
  });
  assert.equal(resolveTaskNode(ambiguous, "3333"), undefined);

  // Tikslus sutapimas visada nugali prefiksą, net kai prefiksas irgi tiktų.
  const both = graphOf({
    nodes: [
      { task_id: "4444", file: "AG/tasks/queue/4444.md" },
      { task_id: "4444-later", file: "AG/tasks/queue/4444-later.md" },
    ],
  });
  assert.equal(resolveTaskNode(both, "4444")?.task_id, "4444");
});

// 2026-08-23 (operatoriaus radinys): briauna iš NEEGZISTUOJANČIO mazgo buvo tyliai praleidžiama.
// `ghost -> a` grafe, turinčiame tik mazgą `a`, grąžindavo `executable: true` ir NULINĮ pažeidimų
// sąrašą. Produkcinis Markdown importas tokių briaunų nekuria — jos ten gimsta tik iš mazgų
// `depends_on` — bet domeno kontraktas leido patvirtinti struktūriškai sugadintą grafą, o modelis
// `runtime` kilmės briaunas palaiko, tad šaltinis atsirastų kartu su pirmu tokiu kvietėju.
test("briauna iš nesamo mazgo yra GRAFO lygio klaida, o ne nutylėjimas", () => {
  const graph = graphOf({
    nodes: [{ task_id: "a", file: "AG/tasks/queue/a.md" }],
    dependencies: [{ task_id: "ghost", depends_on: "a" }],
  });

  const validation = validateTaskGraph(graph);
  assert.equal(validation.executable, false, "grafas su briauna iš niekur nėra vykdomas");
  assert.deepEqual(
    validation.violations.filter((entry) => entry.code === "unknown-edge-source").map((entry) => [entry.scope, entry.task_id]),
    [["graph", "ghost"]],
    "įvardijamas ir kodas, ir nesamas šaltinis",
  );

  // Kontrolė: tas pats grafas be vaiduoklio briaunos lieka vykdomas — vartas nesugriežtėjo plačiau.
  assert.equal(validateTaskGraph(graphOf({ nodes: [{ task_id: "a", file: "AG/tasks/queue/a.md" }] })).executable, true);
});
