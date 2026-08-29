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
import { joinPostRunTruth } from "../application/analytics/post-run-truth-join.js";

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

// Task 036-b-03: symbol_source_chars/symbol_signature_chars used to be computed in persist.ts
// ONLY when at least one symbol carried an explicit `tier` — i.e. only when `symbol_slices` was
// on for that pack. That left an operator running with the flag off unable to see, from the
// metrics log alone, whether turning it on would be worth the extra I/O.
test("persistContextPack: symbol_source_chars/symbol_signature_chars are written even without explicit tiers", async () => {
  const runtimeRoot = path.resolve("vq-test-root-036b03-no-tiers");
  const fs = memoryFs();
  const pack = {
    ...packFor("036b03-no-tiers", "Task be symbol tier'ų — symbol_slices išjungtas.", ["src/module/a.ts"], []),
    code_context: {
      symbol_fragments: [
        { id: "sym-a", file: "src/module/a.ts", name: "a", reason: "exported", signature: "function a(): void" },
        { id: "sym-b", file: "src/module/a.ts", name: "b", reason: "declared", signature: "function b(): void" },
      ],
    },
  };

  await persistContextPack({
    fs,
    runtimeRoot,
    taskText: "kažkoks task tekstas",
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

  const metricsRaw = await fs.readTextFileIfExists(contextSizeMetricsLogPath(runtimeRoot));
  const record = JSON.parse(metricsRaw?.trim().split("\n").at(-1) ?? "{}") as Record<string, unknown>;

  // No symbol carries a `tier`, so the pair is inferred from `signature`/`source` alone
  // (the same fallback `codeContextSymbolState` applies to un-tiered packs): every gathered
  // signature counts toward SIG, and SRC is a true zero — no source slice was ever read.
  assert.equal(record["symbol_signature_chars"], "function a(): void".length + "function b(): void".length);
  assert.equal(record["symbol_source_chars"], 0);
});

test("persistContextPack: symbol_source_chars/symbol_signature_chars sum only their own tier when tiers are explicit", async () => {
  const runtimeRoot = path.resolve("vq-test-root-036b03-tiered");
  const fs = memoryFs();
  const pack = {
    ...packFor("036b03-tiered", "Task su symbol tier'ais — symbol_slices įjungtas.", ["src/module/a.ts"], []),
    code_context: {
      symbol_fragments: [
        {
          id: "sym-src",
          file: "src/module/a.ts",
          name: "src-symbol",
          reason: "exported",
          tier: "SRC",
          // A SRC-tier symbol still carries its signature (only REF strips it); it must not
          // ALSO count toward symbol_signature_chars — the two totals stay mutually exclusive.
          signature: "function srcSymbol(): void",
          source: { text: "function srcSymbol() { return 1; }", hash: "0".repeat(64), line: 1, endLine: 1 },
        },
        { id: "sym-sig", file: "src/module/a.ts", name: "sig-symbol", reason: "exported", tier: "SIG", signature: "function sigSymbol(): void" },
        { id: "sym-ref", file: "src/module/a.ts", name: "ref-symbol", reason: "declared", tier: "REF" },
      ],
    },
  };

  await persistContextPack({
    fs,
    runtimeRoot,
    taskText: "kažkoks task tekstas",
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

  const metricsRaw = await fs.readTextFileIfExists(contextSizeMetricsLogPath(runtimeRoot));
  const record = JSON.parse(metricsRaw?.trim().split("\n").at(-1) ?? "{}") as Record<string, unknown>;

  assert.equal(record["symbol_source_chars"], "function srcSymbol() { return 1; }".length);
  assert.equal(record["symbol_signature_chars"], "function sigSymbol(): void".length);
});

test("persistContextPack: symbol_source_chars/symbol_signature_chars are 0 (present, not absent) with no code context", async () => {
  const runtimeRoot = path.resolve("vq-test-root-036b03-no-code-context");
  const fs = memoryFs();
  const pack = packFor("036b03-no-code-context", "Task be jokio code context'o.", ["src/module/a.ts"], []);

  await persistContextPack({
    fs,
    runtimeRoot,
    taskText: "kažkoks task tekstas",
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

  const metricsRaw = await fs.readTextFileIfExists(contextSizeMetricsLogPath(runtimeRoot));
  const record = JSON.parse(metricsRaw?.trim().split("\n").at(-1) ?? "{}") as Record<string, unknown>;

  assert.equal("symbol_source_chars" in record, true);
  assert.equal("symbol_signature_chars" in record, true);
  assert.equal(record["symbol_source_chars"], 0);
  assert.equal(record["symbol_signature_chars"], 0);
});

// Task 089-a-02: the overflow ladder strips `source` before encoding, so `measureSymbolTierChars`
// alone reads a true zero for demoted symbols even though gather-time read real SRC text for
// them. `code_context.symbol_hypothetical_src_chars` (task 089) carries that gap on the pack
// itself, so a cache HIT (same encoded pack, persisted twice below) must report the SAME total
// as the miss that produced it — no hit/miss branch in persist.ts.
test("persistContextPack: symbol_source_chars adds the pack's hypothetical SRC field, identically across repeated persists of the same pack", async () => {
  const pack = {
    ...packFor("089a02-hypothetical", "Task su SIG simboliais, demote'intais iš SRC.", ["src/module/a.ts"], []),
    code_context: {
      symbol_fragments: [
        { id: "sym-sig", file: "src/module/a.ts", name: "sig-symbol", reason: "exported", tier: "SIG", signature: "function sigSymbol(): void" },
      ],
      symbol_hypothetical_src_chars: 321,
    },
  };
  const encoded = JSON.stringify(pack);

  const readRecord = async (runtimeRoot: string): Promise<Record<string, unknown>> => {
    const fs = memoryFs();
    await persistContextPack({
      fs,
      runtimeRoot,
      taskText: "kažkoks task tekstas",
      encoded,
      maxContextChars: 20_000,
      cacheStatus: "bypass",
      droppedItemCount: 0,
      specDroppedCount: 0,
      codeContextDroppedCount: 0,
      codeContextRebuilt: false,
      canaryFeatures: [],
      canarySizeFallback: false,
    });
    const metricsRaw = await fs.readTextFileIfExists(contextSizeMetricsLogPath(runtimeRoot));
    return JSON.parse(metricsRaw?.trim().split("\n").at(-1) ?? "{}") as Record<string, unknown>;
  };

  // Two independent calls over the SAME encoded pack stand in for the miss that assembled it
  // and the hit that later serves it back unchanged from `lookup.entry.context_pack_json`.
  const missRecord = await readRecord(path.resolve("vq-test-root-089a02-miss"));
  const hitRecord = await readRecord(path.resolve("vq-test-root-089a02-hit"));

  assert.equal(missRecord["symbol_signature_chars"], "function sigSymbol(): void".length);
  assert.equal(missRecord["symbol_source_chars"], 321);
  assert.equal(hitRecord["symbol_source_chars"], missRecord["symbol_source_chars"]);
  assert.equal(hitRecord["symbol_signature_chars"], missRecord["symbol_signature_chars"]);
});

// Task 086-a-02: `worker_prompt_chars` now HAS a writer (dispatch finalize, task 0086) even
// though this module never sets it itself. Proves the shape that writer produces is exactly
// what `joinPostRunTruth` (task 0042) needs to stop dropping every context-size record.
test("buildContextSizeMetrics + joinPostRunTruth: dispatch-finalize-shaped record joins into a non-empty truth row", () => {
  const record = buildContextSizeMetrics({
    taskId: "086-a-02-task",
    attempt: 1,
    attempt_id: "086-a-02-task:dispatch:1",
    contextChars: 0,
    maxContextChars: 0,
    specFragmentCount: 0,
    codeContextItemCount: 0,
    workerPromptChars: 4200,
    rawTaskChars: 1800,
  });

  assert.equal(record.worker_prompt_chars, 4200);
  assert.equal(record.raw_task_chars, 1800);

  const rows = joinPostRunTruth(
    [record],
    [
      {
        task_id: "086-a-02-task",
        attempt: 1,
        attempt_id: "086-a-02-task:dispatch:1",
        input_tokens: 900,
        output_tokens: 150,
        cache_creation_input_tokens: 50,
      },
    ],
    [],
  );

  assert.equal(rows.length, 1, "atitinkantis token-usage įrašas -> nebe tuščias rezultatas");
  assert.equal(rows[0]?.compiled_chars, record.worker_prompt_chars);
  assert.equal(rows[0]?.raw_chars, 1800);
  assert.equal(rows[0]?.input_tokens, 900);
  assert.equal(rows[0]?.billable, 900 + 150 + 50);
  assert.equal(rows[0]?.accepted, null);
});
