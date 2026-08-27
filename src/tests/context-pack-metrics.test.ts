// Task 0032: shadow telemetry must measure the pair a compression decision is actually made
// on — the worker prompt WITH compression vs WITHOUT it, both wrapped in the SAME execution
// context a real dispatch would attach. Before this task, `persist.ts` logged
// `workerTaskIrChars(ir)` (the bare IR JSON) vs `input.taskText.length` (the bare task
// Markdown) — neither is what the worker actually receives, so the comparison answered the
// decision question systematically too gently.
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { persistContextPack } from "../application/context-pack/assemble/persist.js";
import { compileWorkerPromptTask } from "../application/context-pack/worker-prompt-compilation.js";
import { buildWorkerPrompt } from "../application/task-execution/execution-context-gate.js";
import {
  appendContextSizeMetrics,
  buildContextSizeMetrics,
  contextSizeMetricsLogPath,
  readContextSizeMetrics,
} from "../application/context-pack/metrics.js";
import { parseContextCompressionConfig } from "../domain/policies/compression/features.js";
import type { ContextPackFileSystemPort } from "../application/context-pack/ports.js";

function memoryFs(files: Record<string, string> = {}): ContextPackFileSystemPort {
  const store = new Map(Object.entries(files).map(([key, value]) => [path.resolve(key), value]));
  return {
    async readTextFileIfExists(absolutePath) {
      return store.get(path.resolve(absolutePath));
    },
    async readFileBytes(absolutePath) {
      const value = store.get(path.resolve(absolutePath));
      if (value === undefined) throw new Error(`ENOENT: ${absolutePath}`);
      return new TextEncoder().encode(value);
    },
    async exists(absolutePath) {
      return store.has(path.resolve(absolutePath));
    },
    async appendTextFile(absolutePath, text) {
      const key = path.resolve(absolutePath);
      store.set(key, (store.get(key) ?? "") + text);
    },
    async writeTextFile(absolutePath, content) {
      store.set(path.resolve(absolutePath), content);
    },
    async makeDirectory() {
      // in-memory — nėra ką kurti
    },
  };
}

const COMPILABLE_TASK = [
  "# Task",
  "",
  "## Tikslas",
  "Ilgas tikslas su pakankamai teksto, kad prompt'as turėtų realų dydį matuoti.",
  "",
  "## Failai",
  "Leidžiama:",
  "- `src/module/a.ts`",
  "Draudžiama:",
  "- `.env*`",
  "",
  "## Veiksmas",
  "- Pirmas žingsnis.",
  "- Antras žingsnis.",
  "",
  "## Patikra",
  "- `pnpm test`",
  "",
  "## Stop",
  "Kai patikros žalios, sustok.",
  "",
].join("\n");

const NON_COMPILABLE_TASK = [
  "# Task",
  "",
  "## Tikslas",
  "Tikslas be jokių backtick patikrų — IR kompiliacija privalo atsisakyti.",
  "",
  "## Failai",
  "Leidžiama:",
  "- `src/module/b.ts`",
  "",
  "## Patikra",
  "Patikrų nėra šiam task'ui — prozinis sakinys be backtick komandos.",
  "",
].join("\n");

function packFor(taskId: string, goal: string, allowedPaths: string[], checks: string[]): Record<string, unknown> {
  return {
    task_id: taskId,
    phase: "implementation",
    goal,
    allowed_paths: allowedPaths,
    agents: [],
    spec_fragments: [],
    spec_fragment_warnings: [],
    spec_fragment_truncated: [],
    acceptance_criteria: [],
    architecture_rules: [],
    checks,
    out_of_scope: [],
  };
}

const WORKER_TASK_IR_ONLY_CONFIG = parseContextCompressionConfig({
  version: 1,
  features: { worker_task_ir: true },
});

test("persistContextPack: raw/compiled prompt chars measure the SAME pair real dispatch builds", async () => {
  const runtimeRoot = path.resolve("vq-test-root-0032-compilable");
  const fs = memoryFs();
  const pack = packFor("0032-compilable", "Ilgas tikslas su pakankamai teksto, kad prompt'as turėtų realų dydį matuoti.", [
    "src/module/a.ts",
  ], ["pnpm test"]);

  const result = await persistContextPack({
    fs,
    runtimeRoot,
    taskText: COMPILABLE_TASK,
    encoded: JSON.stringify(pack),
    maxContextChars: 20_000,
    cacheStatus: "bypass",
    droppedItemCount: 0,
    specDroppedCount: 0,
    codeContextDroppedCount: 0,
    codeContextRebuilt: false,
    canaryFeatures: [],
    canarySizeFallback: false,
  });
  assert.ok(result.workerTaskIr, "kompiliuojamas task'as -> shadow IR yra");

  // Tas pats artefaktas, kurį realus dispatch skaitytų iš disko (persist.ts jį rašo per tą
  // patį `writeGlobalArtifact` kelią, kurį naudoja realus surinkimas be injektuoto sink'o).
  const writtenExecutionContext = await fs.readTextFileIfExists(result.executionContextPath);
  assert.ok(writtenExecutionContext, "execution-context.md turi būti parašytas");

  const expectedRawPromptChars = buildWorkerPrompt({
    taskText: COMPILABLE_TASK,
    executionContext: writtenExecutionContext,
  }).length;
  const compilation = compileWorkerPromptTask({
    config: WORKER_TASK_IR_ONLY_CONFIG,
    taskId: "0032-compilable",
    taskText: COMPILABLE_TASK,
  });
  assert.equal(compilation.kind, "compiled");
  const compiledBody = compilation.kind === "compiled" ? compilation.task.text : "";
  const expectedCompiledPromptChars = buildWorkerPrompt({
    taskText: COMPILABLE_TASK,
    compiledTask: compiledBody,
    executionContext: writtenExecutionContext,
  }).length;

  const metricsRaw = await fs.readTextFileIfExists(contextSizeMetricsLogPath(runtimeRoot));
  const record = JSON.parse(metricsRaw?.trim().split("\n").at(-1) ?? "{}") as Record<string, unknown>;

  assert.equal(record["raw_prompt_chars"], expectedRawPromptChars);
  assert.equal(record["compiled_prompt_chars"], expectedCompiledPromptChars);
  // Reprodukuoja pačią spragą, dėl kurios šis task'as egzistuoja: seni laukai matuoja VISAI
  // kitus dalykus (task kūną be konteksto), tad jie neturi sutapti su naująja pora.
  assert.notEqual(record["raw_prompt_chars"], record["raw_task_chars"]);
  assert.notEqual(record["compiled_prompt_chars"], record["ir_json_chars"]);
});

test("persistContextPack: compiled prompt chars absent (not zero) when shadow IR refuses the task", async () => {
  const runtimeRoot = path.resolve("vq-test-root-0032-noncompilable");
  const fs = memoryFs();
  const pack = packFor(
    "0032-noncompilable",
    "Tikslas be jokių backtick patikrų — IR kompiliacija privalo atsisakyti.",
    ["src/module/b.ts"],
    [],
  );

  const result = await persistContextPack({
    fs,
    runtimeRoot,
    taskText: NON_COMPILABLE_TASK,
    encoded: JSON.stringify(pack),
    maxContextChars: 20_000,
    cacheStatus: "bypass",
    droppedItemCount: 0,
    specDroppedCount: 0,
    codeContextDroppedCount: 0,
    codeContextRebuilt: false,
    canaryFeatures: [],
    canarySizeFallback: false,
  });
  assert.equal(result.workerTaskIr, undefined, "trūksta backtick patikrų -> IR atsisako");

  const metricsRaw = await fs.readTextFileIfExists(contextSizeMetricsLogPath(runtimeRoot));
  const record = JSON.parse(metricsRaw?.trim().split("\n").at(-1) ?? "{}") as Record<string, unknown>;

  assert.equal(typeof record["raw_prompt_chars"], "number", "žalias prompt'as matuojamas visada");
  assert.equal("compiled_prompt_chars" in record, false, "nesantis matavimas yra NESANTIS, ne 0");
  assert.equal("ir_json_chars" in record, false);
  assert.equal("compiled_task_chars" in record, false);
});

test("context-size metrics: raw/compiled prompt fields round-trip and stay absent when unmeasured", async () => {
  const withPrompt = buildContextSizeMetrics({
    taskId: "0032-x",
    contextChars: 100,
    maxContextChars: 200,
    specFragmentCount: 0,
    codeContextItemCount: 0,
    canaryFeatures: [],
    canarySizeFallback: false,
    rawPromptChars: 500,
    compiledPromptChars: 300,
  });
  assert.equal(withPrompt.raw_prompt_chars, 500);
  assert.equal(withPrompt.compiled_prompt_chars, 300);

  const withoutCompiled = buildContextSizeMetrics({
    taskId: "0032-y",
    contextChars: 100,
    maxContextChars: 200,
    specFragmentCount: 0,
    codeContextItemCount: 0,
    canaryFeatures: [],
    canarySizeFallback: false,
    rawPromptChars: 500,
  });
  assert.equal(withoutCompiled.raw_prompt_chars, 500);
  assert.equal("compiled_prompt_chars" in withoutCompiled, false);

  const runtimeRoot = path.resolve("vq-test-root-metrics-0032");
  const fs = memoryFs();
  await appendContextSizeMetrics(fs, runtimeRoot, withPrompt);
  const reread = await readContextSizeMetrics(fs, runtimeRoot);
  assert.equal(reread.length, 1);
  assert.equal(reread[0]?.raw_prompt_chars, 500);
  assert.equal(reread[0]?.compiled_prompt_chars, 300);
});

test("context-size metrics: dispatch_tool_schema/compact_dsl shadow fields round-trip and stay absent when unmeasured", async () => {
  const withShadowPairs = buildContextSizeMetrics({
    taskId: "0036-x",
    contextChars: 100,
    maxContextChars: 200,
    specFragmentCount: 0,
    codeContextItemCount: 0,
    canaryFeatures: [],
    canarySizeFallback: false,
    toolSchemaFullChars: 4000,
    toolSchemaReducedChars: 1200,
    dslIrChars: 900,
    dslCompiledChars: 600,
  });
  assert.equal(withShadowPairs.tool_schema_full_chars, 4000);
  assert.equal(withShadowPairs.tool_schema_reduced_chars, 1200);
  assert.equal(withShadowPairs.dsl_ir_chars, 900);
  assert.equal(withShadowPairs.dsl_compiled_chars, 600);

  const withoutShadowPairs = buildContextSizeMetrics({
    taskId: "0036-y",
    contextChars: 100,
    maxContextChars: 200,
    specFragmentCount: 0,
    codeContextItemCount: 0,
    canaryFeatures: [],
    canarySizeFallback: false,
  });
  assert.equal("tool_schema_full_chars" in withoutShadowPairs, false, "nesantis matavimas yra NESANTIS, ne 0");
  assert.equal("tool_schema_reduced_chars" in withoutShadowPairs, false);
  assert.equal("dsl_ir_chars" in withoutShadowPairs, false);
  assert.equal("dsl_compiled_chars" in withoutShadowPairs, false);

  const runtimeRoot = path.resolve("vq-test-root-metrics-0036");
  const fs = memoryFs();
  await appendContextSizeMetrics(fs, runtimeRoot, withShadowPairs);
  const reread = await readContextSizeMetrics(fs, runtimeRoot);
  assert.equal(reread.length, 1);
  assert.equal(reread[0]?.tool_schema_full_chars, 4000);
  assert.equal(reread[0]?.tool_schema_reduced_chars, 1200);
  assert.equal(reread[0]?.dsl_ir_chars, 900);
  assert.equal(reread[0]?.dsl_compiled_chars, 600);
});
