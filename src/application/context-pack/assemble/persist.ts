// Vienas rašytojas šviežiai surinktam IR cache-served pack'ui: telemetrija, kieta char
// riba, context-pack.json + iš to paties pack'o renderintas execution context su
// fingerprint antrašte. Behaviour etalon: AG_loop application/context-pack/assemble.ts
// (persist pusė; WBR VQ-302 skaidymas). Vienas rašytojas — tai, kas cache hit'ą daro
// byte-identišką jį pakeitusiam surinkimui.

import path from "node:path";
import { parseWithSchema } from "../../../shared/schema.js";
import type { ContextCompressionFeature } from "../../../domain/policies/compression/features.js";
import { contextPackSchema, type ContextPack, type ExecutionContext } from "../context-pack-schema.js";
import { buildExecutionContextMarker } from "../execution-context-fingerprint.js";
import {
  appendContextSizeMetrics,
  buildContextSizeMetrics,
  estimateTokensFromChars,
  type AttemptIdentityPort,
  type ContextCacheStatus,
} from "../metrics.js";
import { renderExecutionContext } from "../render-execution-context.js";
import { compileWorkerTaskIr, workerTaskIrChars } from "../worker-task-ir.js";
import type { WorkerTaskIr } from "../worker-task-ir-schema.js";
import type { ContextPackFileSystemPort } from "../ports.js";

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

  // REF/SIG/SRC tiers (task 0023) measured back out of the FINALIZED pack, not re-derived
  // from the tiering decision: these stay absent (not zero) on a flag-off pack.
  let symbolSourceChars: number | undefined;
  let symbolSignatureChars: number | undefined;
  if (symbolFragments.some((symbol) => symbol.tier !== undefined)) {
    symbolSourceChars = 0;
    symbolSignatureChars = 0;
    for (const symbol of symbolFragments) {
      if (symbol.tier === "SRC" && symbol.source) {
        symbolSourceChars += symbol.source.text.length;
      } else if (symbol.tier === "SIG" && symbol.signature) {
        symbolSignatureChars += symbol.signature.length;
      }
    }
  }

  await appendContextSizeMetrics(
    input.fs,
    input.runtimeRoot,
    buildContextSizeMetrics({
      taskId: pack.task_id,
      rawTaskChars: input.taskText.length,
      ...(irJsonChars === undefined ? {} : { compiledTaskChars: irJsonChars, irJsonChars }),
      ...(symbolSourceChars === undefined ? {} : { symbolSourceChars }),
      ...(symbolSignatureChars === undefined ? {} : { symbolSignatureChars }),
      contextChars: encoded.length,
      maxContextChars: input.maxContextChars,
      specFragmentCount: pack.spec_fragments.length,
      codeContextItemCount,
      headingMissCount: pack.spec_fragment_warnings.length,
      droppedItemCount: input.droppedItemCount,
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

// Historical persistence: the global supervisor file, created exactly as before (the
// directory is ensured once per write and both artifacts share it).
async function writeGlobalArtifact(fs: ContextPackFileSystemPort, target: string, body: string): Promise<string> {
  await fs.makeDirectory(path.dirname(target));
  await fs.writeTextFile(target, body);
  return target;
}
