// Vienas rašytojas šviežiai surinktam IR cache-served pack'ui: telemetrija, kieta char
// riba, context-pack.json + iš to paties pack'o renderintas execution context su
// fingerprint antrašte. Behaviour etalon: AG_loop application/context-pack/assemble.ts
// (persist pusė; WBR VQ-302 skaidymas). Vienas rašytojas — tai, kas cache hit'ą daro
// byte-identišką jį pakeitusiam surinkimui.

import path from "node:path";
import { parseWithSchema } from "../../../shared/schema.js";
import type { ContextCompressionFeature } from "../../../domain/policies/compression/features.js";
import { buildWorkerPrompt } from "../../task-execution/execution-context-gate.js";
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
import type { ContextPackFileSystemPort } from "../ports.js";

// Task 155: the `worker_task_ir`/`compact_dsl` shadow compilations that used to run here on
// EVERY dispatch (tasks 0021/0032/036-d-05) are gone. They existed to answer one question with
// measurements instead of estimates — "is the compiled prompt smaller than the raw one?" — and
// `docs/audits/compression-audit-2026-09-03.md` §1 closed it: across 204 of 204 shadow pairs the
// compiled prompt came out BIGGER (+3.4%…+15.4%), and both features are off. Re-compiling the
// task twice per assembly to re-derive a known answer is pure CPU. The record type still carries
// the fields (`readContextSizeMetrics` parses the 204 historical rows the UI reads); only the
// writer is gone.

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

  // Task 0032: what the worker actually receives — the SAME prompt builder and the SAME
  // execution context artifact a real dispatch attaches, around the raw task body. `rawTaskChars`
  // is NOT this: it measures the task body alone, which is never what the worker gets. The
  // compiled counterpart is no longer measured (task 155); this half is the live baseline.
  const rawPromptChars = buildWorkerPrompt({ taskText: input.taskText, executionContext: executionContextBody }).length;

  await appendContextSizeMetrics(
    input.fs,
    input.runtimeRoot,
    buildContextSizeMetrics({
      taskId: pack.task_id,
      rawTaskChars: input.taskText.length,
      symbolSourceChars,
      symbolSignatureChars,
      rawPromptChars,
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
  };
}

// Historical persistence: the global supervisor file, created exactly as before (the
// directory is ensured once per write and both artifacts share it).
async function writeGlobalArtifact(fs: ContextPackFileSystemPort, target: string, body: string): Promise<string> {
  await fs.makeDirectory(path.dirname(target));
  await fs.writeTextFile(target, body);
  return target;
}
