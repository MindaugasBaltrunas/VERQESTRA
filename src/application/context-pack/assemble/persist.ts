// Vienas rašytojas šviežiai surinktam IR cache-served pack'ui: telemetrija, kieta char
// riba, context-pack.json + iš to paties pack'o renderintas execution context su
// fingerprint antrašte. Behaviour etalon: AG_loop application/context-pack/assemble.ts
// (persist pusė; WBR VQ-302 skaidymas). Vienas rašytojas — tai, kas cache hit'ą daro
// byte-identišką jį pakeitusiam surinkimui.

import path from "node:path";
import { parseWithSchema } from "../../../shared/schema.js";
import {
  CONTEXT_COMPRESSION_CONFIG_VERSION,
  defaultContextCompressionCanary,
  defaultContextCompressionFeatures,
  type ContextCompressionConfig,
  type ContextCompressionFeature,
} from "../../../domain/policies/compression/features.js";
import { buildWorkerPrompt } from "../../task-execution/execution-context-gate.js";
import { renderCompactWorkerDsl } from "../compact-dsl/render.js";
import {
  contextPackSchema,
  SPEC_HEADING_MISS_WARNING,
  type ContextPack,
  type ExecutionContext,
} from "../context-pack-schema.js";
import { buildExecutionContextMarker } from "../execution-context-fingerprint.js";
import {
  appendContextSizeMetrics,
  buildContextSizeMetrics,
  estimateTokensFromChars,
  type AttemptIdentityPort,
  type ContextCacheStatus,
} from "../metrics.js";
import { renderExecutionContext } from "../render-execution-context.js";
import { measureSymbolTierChars } from "./tiers.js";
import { compileWorkerPromptTask } from "../worker-prompt-compilation.js";
import { compileWorkerTaskIr, workerTaskIrChars } from "../worker-task-ir.js";
import type { WorkerTaskIr } from "../worker-task-ir-schema.js";
import type { ContextPackFileSystemPort } from "../ports.js";

// Task 0032: shadow-measures the SAME representation `worker_task_ir` would send if that flag
// were on for this task, unconditional of live config — same reasoning as
// `shadowCompileWorkerTaskIr` below: an observed prompt size beats an estimate, and this config
// object never reaches a real dispatch (compact_dsl stays off; that renderer is a separate
// A/B axis and mixing it in here would blur which feature a size delta belongs to).
const SHADOW_COMPRESSED_PROMPT_CONFIG: ContextCompressionConfig = {
  version: CONTEXT_COMPRESSION_CONFIG_VERSION,
  features: { ...defaultContextCompressionFeatures(), worker_task_ir: true },
  canary: defaultContextCompressionCanary(),
};

/**
 * Where the context pack and the execution context derived from it are persisted (task
 * 1117a). Not injected -> istorinis globalus kelias (`vq/supervisor/*`), byte for byte.
 * Injected -> the global files are NOT written and the returned paths flow into the result.
 */
export type ContextPackArtifactSink = {
  /** Persists the encoded pack; returns its absolute path. */
  writeContextPack(encoded: string): Promise<string>;
  /** Persists the rendered execution context; returns its absolute path. */
  writeExecutionContext(markdown: string): Promise<string>;
};

export type ContextPackResult = {
  outputPath: string;
  pack: ContextPack;
  // Worker-facing render of the same pack (spec CTX-1): every source-change dispatch gets
  // a schema-valid context-pack.json AND the deterministic execution-context.md beside it.
  executionContextPath: string;
  executionContext: ExecutionContext;
  /**
   * Shadow compilation of the same task into its worker IR (task 0021). Absent when the
   * task cannot be compiled without loss.
   */
  workerTaskIr?: WorkerTaskIr;
};

export async function persistContextPack(input: {
  fs: ContextPackFileSystemPort;
  runtimeRoot: string;
  taskText: string;
  encoded: string;
  maxContextChars: number;
  cacheStatus: ContextCacheStatus;
  droppedItemCount: number;
  /** Retrieval stadijos praradimai — atskirai nuo budgeter'io, kad priskyrimas išliktų. */
  specDroppedCount: number;
  /** Code-context kopėčių visiškai numesti simboliai (pakopos nuleidimas neskaičiuojamas). */
  codeContextDroppedCount: number;
  codeContextRebuilt: boolean;
  // Canary cohort marker (task 0031). Passed by both call sites: a cache HIT is still a
  // real dispatch of this task, so leaving it unmarked would silently shrink the canary arm.
  canaryFeatures: readonly ContextCompressionFeature[];
  // Whether the size guard would refuse this task's compiled body (task 0007/0032).
  canarySizeFallback: boolean;
  attemptIdentity?: AttemptIdentityPort;
  // Injected by both call sites (cache hit and miss), so there stays exactly one writer.
  artifacts?: ContextPackArtifactSink;
}): Promise<ContextPackResult> {
  const { encoded } = input;
  const pack = parseWithSchema(contextPackSchema, JSON.parse(encoded), "context-pack");
  const codeContext = pack.code_context;
  const symbolFragments = codeContext?.symbol_fragments ?? [];
  const codeContextItemCount = codeContext
    ? codeContext.related_files.length +
      codeContext.impacted_tests.length +
      codeContext.architecture_nodes.length +
      symbolFragments.length
    : 0;

  // Shadow compilation (task 0021). Deterministic, side-effect free and NOT consumed by
  // anything downstream: its only job here is to make "raw task vs compiled IR" a measured
  // number instead of an estimate, on both the assembled and the cache-served path.
  const workerTaskIr = shadowCompileWorkerTaskIr(pack.task_id, input.taskText);
  const irJsonChars = workerTaskIr ? workerTaskIrChars(workerTaskIr) : undefined;

  // Task 036-d-05: shadow-renders the SAME IR into the compact worker DSL, unconditional of
  // the `compact_dsl` flag — same reasoning as the shadow compilations above. The renderer
  // fails closed (round-trip parity check, IR version guard), so a refusal here just means
  // no pair, not a broken pack.
  const compactDsl = shadowRenderCompactWorkerDsl(workerTaskIr);

  // REF/SIG/SRC tiers (task 0023), measured at gather time and always present (task
  // 036-b-03): `measureSymbolTierChars` falls back to the same tier inference
  // `codeContextSymbolState` uses, so a flag-off pack (no explicit `tier`) still reports its
  // real SIG weight (signature text was already read from the index, no extra I/O) and its
  // real — genuinely zero — SRC weight, instead of omitting the pair.
  const { symbolSourceChars: measuredSourceChars, symbolSignatureChars } = measureSymbolTierChars(symbolFragments);
  // Task 089: `code_context.symbol_hypothetical_src_chars` carries what the demoted symbols
  // (no `source` left after the overflow ladder) WOULD have cost as SRC, measured at gather
  // time and riding the pack itself — so a cache HIT reports the same total as the miss it
  // replaced, with no hit/miss branch here. Absent on an old or SRC-only pack (nothing was
  // demoted): falls back to exactly the pre-089 `measuredSourceChars` value.
  const symbolSourceChars = measuredSourceChars + (codeContext?.symbol_hypothetical_src_chars ?? 0);

  // The execution context is derived from the persisted pack only (no extra retrieval, no
  // clock, no randomness), so re-running assembly over an unchanged repository rewrites a
  // byte-identical execution-context.md with the same fingerprint.
  const rendered = renderExecutionContext(pack, { maxChars: input.maxContextChars });
  // Fingerprint antraštė dispatch gate'ui (CTX-2): task_sha256/context_pack_sha256
  // skaičiuojami nuo TŲ PAČIŲ artefaktų, kuriuos dispatch skaitys iš disko.
  const marker = buildExecutionContextMarker({
    taskId: pack.task_id,
    taskText: input.taskText,
    contextPackText: encoded,
  });
  const executionContextBody = `${marker}\n${rendered.markdown}`;

  // Task 0032: the pair a compression decision is actually made on — the SAME worker prompt
  // builder and the SAME execution context artifact real dispatch would attach, once with the
  // raw task body and once with the shadow-compiled one. Neither `rawTaskChars` nor
  // `irJsonChars`/`compiledTaskChars` above is this: they measure the task body alone, which is
  // never what the worker receives.
  const rawPromptChars = buildWorkerPrompt({ taskText: input.taskText, executionContext: executionContextBody }).length;
  const compiledPromptBody = shadowCompiledPromptBody(pack.task_id, input.taskText);
  const compiledPromptChars =
    compiledPromptBody === undefined
      ? undefined
      : buildWorkerPrompt({
          taskText: input.taskText,
          compiledTask: compiledPromptBody,
          executionContext: executionContextBody,
        }).length;

  await appendContextSizeMetrics(
    input.fs,
    input.runtimeRoot,
    buildContextSizeMetrics({
      taskId: pack.task_id,
      rawTaskChars: input.taskText.length,
      ...(irJsonChars === undefined ? {} : { compiledTaskChars: irJsonChars, irJsonChars }),
      ...(compactDsl === undefined
        ? {}
        : { dslIrChars: compactDsl.stats.ir_chars, dslCompiledChars: compactDsl.stats.dsl_chars }),
      symbolSourceChars,
      symbolSignatureChars,
      rawPromptChars,
      ...(compiledPromptChars === undefined ? {} : { compiledPromptChars }),
      contextChars: encoded.length,
      maxContextChars: input.maxContextChars,
      specFragmentCount: pack.spec_fragments.length,
      codeContextItemCount,
      // TIK antraščių nepataikymai: nuo A4 tame pačiame masyve guli ir paėmimo/biudžeto
      // praradimai, tad `length` čia išpūstų metriką ir sumaišytų dvi skirtingas klases.
      headingMissCount: pack.spec_fragment_warnings.filter((warning) =>
        warning.startsWith(SPEC_HEADING_MISS_WARNING),
      ).length,
      droppedItemCount: input.droppedItemCount,
      specDroppedCount: input.specDroppedCount,
      codeContextDroppedCount: input.codeContextDroppedCount,
      codeContextRebuilt: input.codeContextRebuilt,
      cacheStatus: input.cacheStatus,
      selectedChars: encoded.length,
      selectedTokenEstimate: estimateTokensFromChars(encoded.length),
      canaryFeatures: input.canaryFeatures,
      canarySizeFallback: input.canarySizeFallback,
    }),
    input.attemptIdentity,
  );

  if (encoded.length > input.maxContextChars) {
    throw new Error(`context pack exceeds max_context_chars ${encoded.length} > ${input.maxContextChars}`);
  }

  // Injected sink -> the attempt-scoped copy IS the artifact and the global files stay
  // untouched; no sink -> the historical global write, unchanged.
  const outputPath = input.artifacts
    ? await input.artifacts.writeContextPack(encoded)
    : await writeGlobalArtifact(input.fs, path.join(input.runtimeRoot, "supervisor", "context-pack.json"), encoded);

  const executionContextPath = input.artifacts
    ? await input.artifacts.writeExecutionContext(executionContextBody)
    : await writeGlobalArtifact(
        input.fs,
        path.join(input.runtimeRoot, "supervisor", "execution-context.md"),
        executionContextBody,
      );

  return {
    outputPath,
    pack,
    executionContextPath,
    executionContext: rendered.context,
    ...(workerTaskIr ? { workerTaskIr } : {}),
  };
}

/**
 * Compiles the worker IR without ever being able to break context-pack assembly: a task the
 * compiler refuses (fail-closed) and an unexpected compiler defect are treated the same way
 * — no IR.
 */
function shadowCompileWorkerTaskIr(taskId: string, taskMarkdown: string): WorkerTaskIr | undefined {
  try {
    const compiled = compileWorkerTaskIr({ taskId, taskMarkdown });
    return compiled.ok ? compiled.value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Shadow-renders the compact worker DSL for an already shadow-compiled IR (task 036-d-05).
 * Absent when there is no IR to render, or when the renderer itself refuses (IR version
 * mismatch, lossy round-trip) — same fail-closed treatment as {@link shadowCompileWorkerTaskIr}.
 */
function shadowRenderCompactWorkerDsl(ir: WorkerTaskIr | undefined): ReturnType<typeof renderCompactWorkerDsl> | undefined {
  if (!ir) return undefined;
  try {
    return renderCompactWorkerDsl(ir);
  } catch {
    return undefined;
  }
}

/**
 * Shadow-compiles the worker prompt body `worker_task_ir` would send for this task, via the
 * SAME compiler the real dispatch chain uses (`compileWorkerPromptTask`), unconditional of live
 * config (task 0032). Never throws — `compileWorkerPromptTask` already fails closed to a
 * `fallback`/`disabled` kind on any compiler refusal or defect.
 */
function shadowCompiledPromptBody(taskId: string, taskText: string): string | undefined {
  const compilation = compileWorkerPromptTask({ config: SHADOW_COMPRESSED_PROMPT_CONFIG, taskId, taskText });
  return compilation.kind === "compiled" ? compilation.task.text : undefined;
}

// Historical persistence: the global supervisor file, created exactly as before (the
// directory is ensured once per write and both artifacts share it).
async function writeGlobalArtifact(fs: ContextPackFileSystemPort, target: string, body: string): Promise<string> {
  await fs.makeDirectory(path.dirname(target));
  await fs.writeTextFile(target, body);
  return target;
}
