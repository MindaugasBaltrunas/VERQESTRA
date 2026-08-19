// VQ-301: code-intelligence klasterio unit testai — mermaid parser, stack signal
// ekstrakcija, retrieval ranking/fragmentai, code-map generavimas/aprėptis, guard taisyklė.
// Fixture'inis parity gyvena characterization-code-index.test.ts.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { isMermaidFlowchart, parseMermaidFlowchart } from "../application/code-intelligence/graph-source/mermaid-parser.js";
import { extractStackSignals } from "../application/code-intelligence/graph-source/stack-signal-extraction.js";
import { fromGraphSource } from "../domain/architecture/graph-import.js";
import { rankRetrievalCandidates } from "../application/code-intelligence/retrieval/ranking.js";
import { chunkMarkdownByHeading } from "../application/code-intelligence/retrieval/markdown-chunks.js";
import { retrieveSpecFragments } from "../application/code-intelligence/retrieval/spec-fragments.js";
import {
  extractImportEdges,
  extractSymbolRecords,
  layerForSourcePath,
} from "../application/code-intelligence/code-map/ast-symbol-scanner.js";
import {
  classIdForFile,
  generateCodeMapMermaid,
  resolveImportTarget,
} from "../application/code-intelligence/code-map/generator.js";
import { computeCodeMapCoverage } from "../application/code-intelligence/code-map/coverage.js";
import { requiresFreshCodeIndex } from "../application/code-intelligence/query/guard.js";
import { nodeFsTestPort } from "./helpers/node-fs-port.js";

test("mermaid parser: node shapes, edge labels, directive gate", () => {
  assert.ok(isMermaidFlowchart("%% komentaras\nflowchart TD\nA-->B"));
  assert.ok(!isMermaidFlowchart("classDiagram\nclass X"));
  assert.throws(() => parseMermaidFlowchart("classDiagram"), /expected "flowchart" or "graph" directive/);

  const graph = parseMermaidFlowchart(
    ["graph LR", "A[Git Repository] --> B(Scanner)", "B -->|feeds| C{Gate}", "C -- verdict --> D", "E((Lone))"].join("\n"),
  );
  assert.deepEqual(
    graph.nodes.map((node) => `${node.id}:${node.label}`),
    ["A:Git Repository", "B:Scanner", "C:Gate", "D:D", "E:Lone"],
  );
  assert.deepEqual(graph.edges, [
    { from: "A", to: "B" },
    { from: "B", to: "C", label: "feeds" },
    { from: "C", to: "D", label: "verdict" },
  ]);
});

test("mermaid output feeds domain fromGraphSource structurally (E2 inversija)", () => {
  const parsed = parseMermaidFlowchart("graph TD\nA[Git Repository] --> B[Worker Service]");
  const architecture = fromGraphSource(parsed, "doc/a.mmd", "2026-08-19T00:00:00.000Z");
  assert.equal(architecture.nodes.find((node) => node.id === "A")?.external, true);
});

test("stack signal extraction: categories, app type, hints, unmodeled-node risk", () => {
  const graph = fromGraphSource(
    parseMermaidFlowchart(
      ["graph TD", "UI[Web Frontend] --> API[REST Controller]", "API --> DB[(ignored)]", "DB2[Postgres Store]"].join("\n"),
    ),
    "doc/a.mmd",
    "t",
  );
  const signals = extractStackSignals(graph, [
    { node_id: "API", source: "readme", excerpt: "Docker deploy su auth token", timestamp: "t" },
  ]);
  assert.equal(signals.appType, "fullstack");
  assert.ok(signals.uiNodeIds.includes("UI"));
  assert.ok(signals.apiNodeIds.includes("API"));
  assert.ok(signals.dataNodeIds.includes("DB2"));
  assert.ok(signals.deploymentHints.includes("deployment:docker"));
  assert.ok(signals.riskHints.includes("risk:auth"));
  assert.ok(signals.riskHints.includes("risk:secrets"));
  assert.ok(signals.riskHints.includes("risk:unmodeled-node"), "unknown kind mazgai kelia riziką");
  assert.equal(signals.complexity.level, "low");
});

test("retrieval ranking: canonical tier order, heading fallback demoted, stable ties", () => {
  const ranked = rankRetrievalCandidates(
    [
      { ref: "doc/general.md", text: "nesusijęs tekstas visai", directSpecReference: false },
      { ref: "doc/spec.md", text: "spec turinys", directSpecReference: true },
      { ref: "doc/miss.md#nerasta", text: "visas dokumentas", directSpecReference: true, requestedHeading: "nerasta", headingMatched: false },
      { ref: "doc/hit.md#rasta", text: "sekcija", directSpecReference: true, requestedHeading: "rasta", headingMatched: true },
      { ref: "src/module.ts", text: "kodo kaimynas", directSpecReference: false, evidencePaths: ["src/module.ts"] },
      { ref: "doc/lex.md", text: "užklausos žodis budget planas", directSpecReference: false },
    ],
    { query: "budget planas" },
  );
  assert.deepEqual(
    ranked.map((entry) => entry.tier),
    ["direct_spec_reference", "heading_match", "code_architecture_evidence", "bm25", "general_docs", "general_docs"],
  );
  assert.equal(ranked[1]?.ref, "doc/hit.md#rasta");
  assert.equal(ranked[3]?.ref, "doc/lex.md");
  const generalRefs = ranked.slice(4).map((entry) => entry.ref);
  assert.deepEqual(generalRefs, ["doc/general.md", "doc/miss.md#nerasta"], "lygios bm25=0 poros laiko įvesties tvarką");
});

test("markdown chunks: preface root, heading sections, empty chunks dropped", () => {
  const chunks = chunkMarkdownByHeading(["prieš antraštę", "", "# Pirma", "turinys", "## Antra", "kitas"].join("\n"));
  assert.deepEqual(
    chunks.map((chunk) => `${chunk.level}:${chunk.heading}`),
    ["0:<root>", "1:Pirma", "2:Antra"],
  );
});

test("spec fragments: heading match, heading miss, change-dir expansion, char budget", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vq-301-frag-"));
  try {
    await writeFile(path.join(root, "spec.md"), "# Alfa\nalfa tekstas\n# Beta\nbeta tekstas\n", "utf8");
    await mkdir(path.join(root, "change"), { recursive: true });
    await writeFile(path.join(root, "change", "proposal.md"), "change proposal turinys", "utf8");

    const fragments = await retrieveSpecFragments(
      nodeFsTestPort,
      root,
      ["spec.md#beta", "spec.md#nerasta", "change", "nėra.md"],
      10,
      1000,
    );
    assert.equal(fragments.length, 3);
    assert.equal(fragments[0]?.text, "# Beta\nbeta tekstas");
    assert.equal(fragments[0]?.headingMiss, undefined);
    assert.equal(fragments[1]?.headingMiss, "nerasta", "nerasta antraštė deklaruojama, ne nutylima");
    assert.equal(fragments[2]?.text, "change proposal turinys", "katalogas išskleidžiamas į proposal.md");

    const clipped = await retrieveSpecFragments(nodeFsTestPort, root, ["spec.md"], 10, 5);
    assert.equal(clipped[0]?.text.length, 5, "char budget kerpa fragmentą");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("code-map: scanner records, mermaid render and coverage close the loop", () => {
  const source = [
    'import { helper } from "./helper.js";',
    "export class Engine {",
    "  run(): string { return helper(); }",
    "}",
    "export const VERSION = 1;",
  ].join("\n");
  const symbols = extractSymbolRecords("src/application/engine.ts", source, "application");
  assert.deepEqual(
    symbols.map((record) => `${record.kind}:${record.name}`),
    ["class:Engine", "method:Engine.run", "const:VERSION"],
  );
  const helperSymbols = extractSymbolRecords("src/application/helper.ts", "export function helper(): string { return \"x\"; }", "application");
  const imports = extractImportEdges("src/application/engine.ts", source, "application");
  assert.deepEqual(imports, [{ fromFile: "src/application/engine.ts", fromLayer: "application", toModule: "./helper.js" }]);

  const mermaid = generateCodeMapMermaid([...symbols, ...helperSymbols], imports);
  assert.match(mermaid, /class src_application_engine\["src\/application\/engine.ts"\]/);
  assert.match(mermaid, /src_application_engine --> src_application_helper/);
  const coverage = computeCodeMapCoverage([...symbols, ...helperSymbols], mermaid);
  assert.equal(coverage.coverage_percent, 100);
  assert.deepEqual(coverage.missing_symbols, []);

  assert.equal(classIdForFile("src/a-b.ts"), "src_a_b");
  assert.equal(resolveImportTarget("src/a.ts", "./b.js", new Set(["src/b.ts"])), "src/b.ts");
  assert.equal(resolveImportTarget("src/a.ts", "zod", new Set(["src/b.ts"])), null);
  assert.equal(layerForSourcePath("src/application/engine.ts", { relativeDir: "src" }), "application");
  assert.equal(layerForSourcePath("src/cli.ts", { relativeDir: "src" }), "root");
  assert.equal(layerForSourcePath("ui/src/x.ts", { relativeDir: "ui/src", fixedLayer: "ui-app" }), "ui-app");
});

test("guard rule: graph-aware task requires fresh index unless it builds one itself", () => {
  assert.ok(requiresFreshCodeIndex("Naudok code graph context analizei."));
  assert.ok(!requiresFreshCodeIndex("Paleisk code-index build ir tada code graph context."));
  assert.ok(!requiresFreshCodeIndex("Paprastas taskas be grafo."));
});
