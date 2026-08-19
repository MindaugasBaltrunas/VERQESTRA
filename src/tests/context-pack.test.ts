// VQ-302 (1 dalis): context-pack klasterio unit testai — fingerprint kontraktas, worker
// prompt kompiliacija su size guard, execution-context determinizmas, efektyvi kompresijos
// politika per fake portą, MCP registro pirmenybė, telemetrijos kanarėlės žymė.
// Characterization parity gyvena characterization-worker-task-ir/compact-dsl testuose.
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  buildExecutionContextMarker,
  contextArtifactSha256,
  parseExecutionContextMetadata,
} from "../application/context-pack/execution-context-fingerprint.js";
import {
  COMPRESSION_FALLBACK_SIZE,
  compileWorkerPromptTask,
  compileWorkerPromptTaskForDispatch,
  compressionSizeFallbackReason,
} from "../application/context-pack/worker-prompt-compilation.js";
import { renderExecutionContext } from "../application/context-pack/render-execution-context.js";
import { contextPackSchema } from "../application/context-pack/context-pack-schema.js";
import {
  contextCompressionArrestStatePath,
  contextCompressionConfigPath,
  loadEffectiveCompressionPolicy,
} from "../application/context-pack/effective-compression-policy.js";
import {
  loadMcpCapabilityRegistry,
  resolveDispatchMcpCapabilities,
  selectDispatchMcpCapabilities,
  unknownDispatchMcpCapabilities,
} from "../application/context-pack/mcp-capability-registry.js";
import {
  CANARY_SIZE_FALLBACK_MARKER,
  appendContextSizeMetrics,
  buildContextSizeMetrics,
  readContextSizeMetrics,
} from "../application/context-pack/metrics.js";
import { parseContextCompressionConfig } from "../domain/policies/compression/features.js";
import type { ContextPackFileSystemPort } from "../application/context-pack/ports.js";

function memoryFs(files: Record<string, string>): ContextPackFileSystemPort & { appended: Map<string, string> } {
  const normalized = new Map(Object.entries(files).map(([key, value]) => [path.resolve(key), value]));
  const appended = new Map<string, string>();
  return {
    appended,
    async readTextFileIfExists(absolutePath) {
      return normalized.get(path.resolve(absolutePath));
    },
    async readFileBytes(absolutePath) {
      const value = normalized.get(path.resolve(absolutePath));
      if (value === undefined) throw new Error(`ENOENT: ${absolutePath}`);
      return new TextEncoder().encode(value);
    },
    async exists(absolutePath) {
      return normalized.has(path.resolve(absolutePath));
    },
    async appendTextFile(absolutePath, text) {
      const key = path.resolve(absolutePath);
      appended.set(key, (appended.get(key) ?? "") + text);
    },
    async writeTextFile(absolutePath, content) {
      normalized.set(path.resolve(absolutePath), content);
    },
    async makeDirectory() {
      // in-memory — katalogų kurti nereikia
    },
  };
}

const CANONICAL_TASK = [
  "# Task",
  "",
  "## Spec source",
  "doc/spec.md",
  "",
  "## Tikslas",
  "Ilgas tikslas su pakankamai teksto, kad žalias task'as būtų didesnis už kompiliuotą kūną.",
  "",
  "## Agentai",
  "readme-guard -> coder",
  "",
  "## Dependencies",
  // Orkestratoriaus sekcija: IR ją IŠMETA (omitted_sections), tad būtent čia gulintis
  // balastas daro žalią task'ą didesnį už kompiliuotą kūną — size guard'as praleidžia.
  "- depends_on: labai ilgas priklausomybių aprašas, kurio vykdytojui skaityti nereikia. ".repeat(30),
  "",
  "## Failai",
  "Leidžiama:",
  "- `src/module/a.ts`",
  "Draudžiama:",
  "- `.env*`",
  "",
  "## Veiksmas",
  "- Pirmas žingsnis su ilgu paaiškinamuoju sakiniu, kuris kelia žalio teksto svorį.",
  "- Antras žingsnis su dar vienu ilgu paaiškinamuoju sakiniu dėl tos pačios priežasties.",
  "",
  "## Patikra",
  "- `pnpm typecheck`",
  "- `pnpm test`",
  "",
  "## Stop",
  "Kai patikros žalios, sustok.",
  "",
  "## Pastabos vykdytojui",
  "Šis blokas yra laisvos formos tekstas, kuris privalo išgyventi kompiliaciją pažodžiui.",
  "",
].join("\n");

test("fingerprint: marker round-trips and hashing normalizes CRLF + trailing whitespace", () => {
  const marker = buildExecutionContextMarker({ taskId: "0042-x", taskText: "task", contextPackText: "pack" });
  const parsed = parseExecutionContextMetadata(`${marker}\n# Execution context`);
  assert.equal(parsed?.taskId, "0042-x");
  assert.equal(parsed?.taskSha256, contextArtifactSha256("task"));
  assert.equal(parsed?.contextPackSha256, contextArtifactSha256("pack"));
  assert.equal(contextArtifactSha256("a\r\nb\n"), contextArtifactSha256("a\nb"));
  assert.equal(parseExecutionContextMetadata("be markerio"), undefined);
});

test("worker prompt compilation: disabled, IR mode, compact mode, size guard fallback", () => {
  const off = parseContextCompressionConfig({ version: 1 });
  assert.deepEqual(compileWorkerPromptTask({ config: off, taskId: "t", taskText: CANONICAL_TASK }), {
    kind: "disabled",
  });

  const irOnly = parseContextCompressionConfig({ version: 1, features: { worker_task_ir: true } });
  const compiledIr = compileWorkerPromptTaskForDispatch({ config: irOnly, taskId: "t", taskText: CANONICAL_TASK });
  assert.equal(compiledIr.kind, "compiled");
  assert.equal(compiledIr.kind === "compiled" ? compiledIr.task.mode : "", "worker_task_ir");
  assert.ok(compiledIr.kind === "compiled" && compiledIr.task.compiledChars < compiledIr.task.rawChars);

  const both = parseContextCompressionConfig({ version: 1, features: { worker_task_ir: true, compact_dsl: true } });
  const compiledDsl = compileWorkerPromptTask({ config: both, taskId: "t", taskText: CANONICAL_TASK });
  assert.equal(compiledDsl.kind === "compiled" ? compiledDsl.task.mode : "", "compact_dsl");

  const tinyTask = [
    "# Task",
    "## Tikslas",
    "Trumpas.",
    "## Failai",
    "Leidžiama:",
    "- `a.ts`",
    "## Patikra",
    "- `pnpm test`",
  ].join("\n");
  const guarded = compileWorkerPromptTaskForDispatch({ config: irOnly, taskId: "t", taskText: tinyTask });
  assert.equal(guarded.kind, "fallback");
  if (guarded.kind === "fallback") {
    assert.equal(guarded.fallback, COMPRESSION_FALLBACK_SIZE);
    assert.equal(guarded.feature, "worker_task_ir");
    assert.match(guarded.reason, /^compiled output not smaller than raw \(\d+\/\d+ chars\)$/);
    assert.equal(guarded.reason, compressionSizeFallbackReason(Number(/\((\d+)\//.exec(guarded.reason)?.[1]), tinyTask.length));
  }
});

test("execution context render is deterministic and carries the fingerprint contract", () => {
  const pack = contextPackSchema.parse({
    task_id: "0042-x",
    phase: "implementation",
    goal: "Tikslas.",
    allowed_paths: ["src/a.ts"],
    checks: ["pnpm test"],
    acceptance_criteria: ["Padaryti darbą."],
    out_of_scope: ["Nieko daugiau."],
  });
  const first = renderExecutionContext(pack);
  const second = renderExecutionContext(pack);
  assert.equal(first.markdown, second.markdown, "tas pats pack'as visada renderina tuos pačius baitus");
  assert.match(first.context.fingerprint, /^[0-9a-f]{16}$/);
  assert.equal(first.context.rendered_chars, first.markdown.length);
  assert.match(first.markdown, /## Goal/);
  assert.match(first.markdown, /## Out of scope/);
  assert.equal(first.context.dropped.length, 0);
});

test("effective compression policy: arrest narrows config, dependency notice announced once", async () => {
  const runtimeRoot = path.resolve("vq-test-root-effective");
  const fs = memoryFs({
    [contextCompressionConfigPath(runtimeRoot)]: JSON.stringify({
      version: 1,
      features: { worker_task_ir: true, compact_dsl: true },
    }),
    [contextCompressionArrestStatePath(runtimeRoot)]: JSON.stringify({
      version: 1,
      arrests: [
        {
          feature: "worker_task_ir",
          trigger: "fallback-streak",
          reason: "test",
          observed: 3,
          threshold: 3,
          arrested_at: "2026-01-01T00:00:00.000Z",
          last_task_id: "001",
        },
      ],
    }),
  });
  const clock = { timestamp: () => "2026-08-19T00:00:00.000Z" };
  const policy = await loadEffectiveCompressionPolicy({ fs, clock, runtimeRoot, taskId: "task-x" });
  assert.equal(policy.config.features.worker_task_ir, false, "arrestas nuleidžia feature į false");
  assert.equal(policy.config.features.compact_dsl, false, "priklausomybė nuo arestuoto — irgi false");
  assert.equal(policy.dependencyNotices[0]?.cause, "arrested");
  assert.deepEqual(policy.canaryFeatures, [], "efektyvus konfigas be gyvų canary feature'ų");

  await loadEffectiveCompressionPolicy({ fs, clock, runtimeRoot, taskId: "task-x" });
  const logged = [...fs.appended.values()].join("");
  const occurrences = logged.split("COMPRESSION CONFIG DEPENDENCY").length - 1;
  assert.equal(occurrences, 1, "ta pati eilutė skelbiama vieną kartą per procesą");
});

test("mcp capability registry: precedence registry > environment > fail-open; disabled does no IO", async () => {
  const root = path.resolve("vq-test-root-mcp");
  const valid = memoryFs({
    [path.join(root, "config", "mcp-capabilities.json")]: JSON.stringify({
      version: 1,
      servers: { browser: { tools: ["navigate", "click"] } },
    }),
  });
  const fromRegistry = await loadMcpCapabilityRegistry(valid, root);
  assert.equal(fromRegistry.known, true);
  assert.deepEqual(fromRegistry.tools, ["mcp__browser__click", "mcp__browser__navigate"]);

  const absent = await loadMcpCapabilityRegistry(memoryFs({}), root);
  assert.equal(absent.known, false);
  assert.match(absent.source, /^registry absent:/);

  const invalid = memoryFs({ [path.join(root, "config", "mcp-capabilities.json")]: "{\"version\": 2}" });
  const unreadable = await loadMcpCapabilityRegistry(invalid, root);
  assert.equal(unreadable.known, false);
  assert.match(unreadable.source, /^registry unreadable:/);

  const environment = { known: true, tools: ["mcp__x__y"], source: "session init" };
  assert.equal(selectDispatchMcpCapabilities({ registry: fromRegistry, environment }).source, fromRegistry.source);
  assert.equal(selectDispatchMcpCapabilities({ registry: absent, environment }).source, "session init");
  assert.equal(selectDispatchMcpCapabilities({}).known, false);
  assert.deepEqual(unknownDispatchMcpCapabilities("x"), { known: false, tools: [], source: "x" });

  const explodingFs: ContextPackFileSystemPort = {
    readTextFileIfExists: () => {
      throw new Error("disabled kelias NEDARO skaitymų");
    },
    readFileBytes: () => {
      throw new Error("no");
    },
    exists: () => {
      throw new Error("no");
    },
    appendTextFile: () => {
      throw new Error("no");
    },
    writeTextFile: () => {
      throw new Error("no");
    },
    makeDirectory: () => {
      throw new Error("no");
    },
  };
  const disabled = await resolveDispatchMcpCapabilities({ enabled: false, fs: explodingFs, configRootDir: root });
  assert.equal(disabled.source, "dispatch_tool_schema disabled");
});

test("context-size metrics: canary size-fallback marker, jsonl round-trip via port", async () => {
  const record = buildContextSizeMetrics(
    {
      taskId: "0042-x",
      contextChars: 100,
      maxContextChars: 200,
      specFragmentCount: 1,
      codeContextItemCount: 2,
      canaryFeatures: ["worker_task_ir"],
      canarySizeFallback: true,
    },
    new Date("2026-08-19T00:00:00.000Z"),
  );
  assert.deepEqual(record.canary_features, ["worker_task_ir", CANARY_SIZE_FALLBACK_MARKER]);
  assert.equal(record.exceeded, false);
  assert.equal(record.cache_status, "unknown");

  const runtimeRoot = path.resolve("vq-test-root-metrics");
  const fs = memoryFs({});
  await appendContextSizeMetrics(fs, runtimeRoot, record);
  const [logPath, content] = [...fs.appended.entries()][0] ?? ["", ""];
  assert.match(logPath, /context-size\.jsonl$/);
  const reread = await readContextSizeMetrics(memoryFs({ [logPath]: content }), runtimeRoot);
  assert.equal(reread.length, 1);
  assert.deepEqual(reread[0]?.canary_features, ["worker_task_ir", CANARY_SIZE_FALLBACK_MARKER]);
  assert.equal(reread[0]?.selected_chars, 100);
});
