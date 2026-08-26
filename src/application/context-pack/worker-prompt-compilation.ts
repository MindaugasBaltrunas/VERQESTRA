// Compiled worker prompt body (task 0025). Behaviour etalon: AG_loop application/
// context-pack/worker-prompt-compilation.ts (1:1; flags — domain/policies/compression).
//
// The dispatch prompt used to carry the SAME task twice: the raw task Markdown plus an
// execution context rendered from the same task. This module produces the third option —
// the task compiled once, in exactly one representation — and decides, from the compression
// feature flags alone, which representation a dispatch may use:
//
// Task 029 closed the OTHER half of that "same task twice", which this module never touched:
// compiling the body only ever replaced the body, while the execution context kept re-rendering
// goal, acceptance criteria, allowed paths, checks and out-of-scope from the same task file.
// Those blocks now fall out at prompt assembly time (`task-execution/execution-context-gate`,
// `taskDedupedExecutionContext`); `execution-context.md` on disk stays complete. Deviation from
// the etalon, operator's order 2026-08-26. Telemetry stays separated on purpose: `rawChars` /
// `compiledChars` and `guardCompiledWorkerPromptSize` below measure the BODY only, so a saving
// that belongs to the dedup can never be credited to compression.
//
//   worker_task_ir=false                   -> `disabled`: the caller keeps the raw task.
//   worker_task_ir=true, compact_dsl=false -> the WorkerTaskIR (task 0021) as JSON.
//   worker_task_ir=true, compact_dsl=true  -> the compact worker DSL (task 0024).
//
// The two flags stay independent on purpose: a measured token delta must be attributable to
// the IR or to the compact renderer. `"canary"` (task 0031) answers per TASK from the
// deterministic cohort; both flags read the SAME cohort.
//
// FAIL CLOSED, NEVER PARTIAL: everything here either yields a body that provably still
// carries the whole task, or yields `fallback` and the caller dispatches the unchanged raw
// task. AND IT MUST PAY (task 0001): a compiled body not smaller than the task it replaces is
// refused via `guardCompiledWorkerPromptSize` (`compression_fallback=size`).

import { isContextCompressionFeatureEnabledForTask } from "../../domain/policies/compression/canary.js";
import type {
  ContextCompressionConfig,
  ContextCompressionFeature,
} from "../../domain/policies/compression/features.js";
import type { WorkerTaskIr } from "./worker-task-ir-schema.js";
import { renderCompactWorkerDsl } from "./compact-dsl/render.js";
import type { CompactWorkerDslStats } from "./compact-dsl/model.js";
import {
  MARKER_ACCEPTANCE,
  MARKER_ALLOWED,
  MARKER_CHECK,
  MARKER_ELEMENT,
  MARKER_FORBIDDEN,
  MARKER_GOAL,
  MARKER_OMITTED,
  MARKER_OUT_OF_SCOPE,
  MARKER_SOURCE_HASH,
  MARKER_SPEC_REF,
  MARKER_STOP,
  MARKER_TASK_ID,
} from "./compact-dsl/model.js";
import { compileWorkerTaskIr, workerTaskIrChars } from "./worker-task-ir.js";

/**
 * Which representation of the task the worker prompt carries.
 *
 * `raw` is the pre-0025 behaviour and the fallback; the other two are the flagged paths and
 * are also the telemetry labels an A/B run groups by.
 */
export type WorkerPromptMode = "raw" | "worker_task_ir" | "compact_dsl";

// Task 0007: `CompiledWorkerPromptTask.dsl` keliauja į dispatch execution record'ą, tad record'o
// autoriui reikia TIPO. Re-eksportuojama ČIA, kad compact-dsl išlaikytų vienintelį produkcinį
// import'o call site'ą.
export type { CompactWorkerDslStats } from "./compact-dsl/model.js";

/**
 * Telemetry labels for the two ways a flagged dispatch still ends up on the raw task.
 *
 * `raw` — compilation refused: a compiler defect, a task the IR cannot carry losslessly, or an
 * unreadable config. Nothing was produced.
 * `size` — compilation succeeded but did not PAY (task 0001): the compiled body came out no
 * smaller than the raw task.
 */
export const COMPRESSION_FALLBACK_RAW = "raw";
export const COMPRESSION_FALLBACK_SIZE = "size";

export type CompressionFallbackLabel = typeof COMPRESSION_FALLBACK_RAW | typeof COMPRESSION_FALLBACK_SIZE;

export type CompiledWorkerPromptTask = {
  mode: Exclude<WorkerPromptMode, "raw">;
  /** The prompt body that replaces the raw task Markdown. Deterministic for a given task. */
  text: string;
  /** sha256 of the raw task bytes this body was compiled from — the evidence link to `task.md`. */
  taskSha256: string;
  /** Size of the raw task Markdown, for the A/B ratio. */
  rawChars: number;
  /** Size of the IR as JSON, independent of which body was rendered. */
  irChars: number;
  /** Size of `text`, i.e. what the prompt actually pays for. */
  compiledChars: number;
  /** Compact renderer measurements; absent in `worker_task_ir` mode. */
  dsl?: CompactWorkerDslStats;
};

/**
 * `disabled` — the flag is off; this is the normal, expected path and NOT a fallback.
 * `fallback` — the compiled body will not be dispatched; the caller must log
 * `compression_fallback=<fallback>` with this reason and dispatch the raw task.
 *
 * A fallback names the FEATURE it is attributable to (task 0008); `feature` is absent only
 * when no feature can be blamed.
 */
export type WorkerPromptCompilation =
  | { kind: "disabled" }
  | { kind: "compiled"; task: CompiledWorkerPromptTask }
  | {
      kind: "fallback";
      fallback: CompressionFallbackLabel;
      reason: string;
      feature?: ContextCompressionFeature;
    };

/** The flag that owns a compiled body's representation — i.e. what a fallback from it indicts. */
export function workerPromptModeFeature(mode: Exclude<WorkerPromptMode, "raw">): ContextCompressionFeature {
  return mode === "compact_dsl" ? "compact_dsl" : "worker_task_ir";
}

export type CompileWorkerPromptTaskInput = {
  config: ContextCompressionConfig;
  taskId: string;
  /** Canonical task Markdown, exactly as dispatched. */
  taskText: string;
};

/**
 * Compiles the prompt body for one dispatch.
 *
 * Pure: no clock, no I/O, no environment reads — the same task and the same flags always
 * produce the same bytes, which is what lets the Windows prompt-file path and the POSIX
 * stdin path be proven byte-identical.
 */
export function compileWorkerPromptTask(input: CompileWorkerPromptTaskInput): WorkerPromptCompilation {
  if (!isContextCompressionFeatureEnabledForTask(input.config, "worker_task_ir", input.taskId)) {
    return { kind: "disabled" };
  }

  const compact = isContextCompressionFeatureEnabledForTask(input.config, "compact_dsl", input.taskId);

  let compiled;
  try {
    compiled = compileWorkerTaskIr({ taskId: input.taskId, taskMarkdown: input.taskText });
  } catch (error: unknown) {
    // A defect in the compiler must degrade to the raw task, never to a partial prompt.
    return {
      kind: "fallback",
      fallback: COMPRESSION_FALLBACK_RAW,
      reason: `worker task IR compiler failed: ${messageOf(error)}`,
      feature: "worker_task_ir",
    };
  }
  if (!compiled.ok) {
    return {
      kind: "fallback",
      fallback: COMPRESSION_FALLBACK_RAW,
      reason: `worker task IR not compilable (${compiled.error.code}): ${compiled.error.message}`,
      feature: "worker_task_ir",
    };
  }
  const ir = compiled.value;

  if (!compact) {
    const text = renderWorkerTaskIrPrompt(ir);
    return {
      kind: "compiled",
      task: {
        mode: "worker_task_ir",
        text,
        taskSha256: ir.source_sha256,
        rawChars: input.taskText.length,
        irChars: workerTaskIrChars(ir),
        compiledChars: text.length,
      },
    };
  }

  try {
    // `renderCompactWorkerDsl` decodes its own output and throws unless it decodes back into
    // this exact IR, so reaching the next line already proves the document is lossless.
    const dsl = renderCompactWorkerDsl(ir);
    const text = renderCompactWorkerDslPrompt(dsl.text);
    return {
      kind: "compiled",
      task: {
        mode: "compact_dsl",
        text,
        taskSha256: ir.source_sha256,
        rawChars: input.taskText.length,
        irChars: workerTaskIrChars(ir),
        compiledChars: text.length,
        dsl: dsl.stats,
      },
    };
  } catch (error: unknown) {
    return {
      kind: "fallback",
      fallback: COMPRESSION_FALLBACK_RAW,
      reason: `compact worker DSL render failed: ${messageOf(error)}`,
      feature: "compact_dsl",
    };
  }
}

/**
 * The reason line a size fallback reports, in both the dispatch log and the execution record.
 *
 * One builder, so the log a cohort analysis greps for and the telemetry field it joins on can
 * never drift apart.
 */
export function compressionSizeFallbackReason(compiledChars: number, rawChars: number): string {
  return `compiled output not smaller than raw (${compiledChars}/${rawChars} chars)`;
}

/**
 * Refuses a compiled body that is not smaller than the task it replaces (task 0001).
 *
 * Both compiled bodies open with a fixed reading key, so on a small task that preamble can
 * cost more than the raw Markdown it replaces — measured on live dispatches, `compact_dsl`
 * sent 23–27% MORE than raw. `>=`, not `>`: an equal-sized compiled body buys nothing and
 * still costs a translation the worker has to perform, so the tie goes to the raw task.
 *
 * The refusal reuses the existing fallback path — a size fallback and a compiler refusal reach
 * the worker as the same, whole raw task; only the telemetry label differs.
 */
export function guardCompiledWorkerPromptSize(compilation: WorkerPromptCompilation): WorkerPromptCompilation {
  if (compilation.kind !== "compiled") {
    return compilation;
  }
  const { compiledChars, rawChars } = compilation.task;
  if (compiledChars < rawChars) {
    return compilation;
  }
  return {
    kind: "fallback",
    fallback: COMPRESSION_FALLBACK_SIZE,
    reason: compressionSizeFallbackReason(compiledChars, rawChars),
    // The renderer that produced the oversized body is the one that failed to pay: blaming
    // `worker_task_ir` for a compact-DSL preamble would arrest the wrong canary.
    feature: workerPromptModeFeature(compilation.task.mode),
  };
}

/**
 * What a DISPATCH compiles with: `compileWorkerPromptTask` plus the size guard.
 *
 * Every surface that actually sends a prompt goes through this one function, so the guard
 * cannot be forgotten at a call site. `compileWorkerPromptTask` stays exported unguarded
 * because it answers a different question — which representation the FLAGS select for a task.
 */
export function compileWorkerPromptTaskForDispatch(input: CompileWorkerPromptTaskInput): WorkerPromptCompilation {
  return guardCompiledWorkerPromptSize(compileWorkerPromptTask(input));
}

/** Mode a caller must report when compilation is disabled or fell back. */
export function workerPromptModeOf(compilation: WorkerPromptCompilation): WorkerPromptMode {
  return compilation.kind === "compiled" ? compilation.task.mode : "raw";
}

// --- Rendering ---------------------------------------------------------------------------
//
// Both bodies open with a short, constant preamble. It is not decoration: the worker is being
// handed a machine format instead of the Markdown it normally reads, and a field-by-field
// reading key is what keeps "compressed" from meaning "ambiguous" — but the key must PAY too
// (task 0031): identity (`task_id`/`source_sha256`) is a field of the document one line below,
// so restating it in prose here would be the exact duplication task 0029 closed on the other
// side of this same prompt. The preamble's only job is the reading key.

export const WORKER_TASK_IR_PROMPT_HEADING = "# Task — compiled WorkerTaskIR";
export const COMPACT_DSL_PROMPT_HEADING = "# Task — compact worker DSL";

const WORKER_TASK_IR_FIELD_LEGEND =
  "Fields: allowed_paths=edit boundary; forbidden_paths=off-limits; " +
  "acceptance_criteria+checks=done, run checks verbatim; elements=verbatim instructions; " +
  "omitted_sections=orchestrator-owned, withheld.";

// Built from the SAME marker constants `render.ts` emits, so the legend cannot silently drift
// from what a document actually contains — a renamed or removed marker fails typecheck here.
const COMPACT_DSL_MARKER_LEGEND = [
  `${MARKER_TASK_ID}=id`,
  `${MARKER_SOURCE_HASH}=sha256`,
  `${MARKER_GOAL}=goal`,
  `${MARKER_ALLOWED}=allowed(edit)`,
  `${MARKER_FORBIDDEN}=forbidden`,
  `${MARKER_ACCEPTANCE}=accept`,
  `${MARKER_CHECK}=check(verbatim)`,
  `${MARKER_SPEC_REF}=spec`,
  `${MARKER_OUT_OF_SCOPE}=nongoal`,
  `${MARKER_STOP}=stop`,
  `${MARKER_OMITTED}=omitted`,
  `${MARKER_ELEMENT}#h.n=verbatim(h+n)`,
  "{F1}=alias({{=lit{)",
  "<M>#n=next n lines",
].join(" ");

function renderWorkerTaskIrPrompt(ir: WorkerTaskIr): string {
  // Compact JSON, not pretty-printed: indentation would spend the characters this path exists
  // to save, and the document has no newlines at all, so no fence can be broken from inside.
  const document = JSON.stringify(ir);
  return [`${WORKER_TASK_IR_PROMPT_HEADING} v${ir.version}`, "", WORKER_TASK_IR_FIELD_LEGEND, "", ...fenced(document, "json"), ""].join(
    "\n",
  );
}

function renderCompactWorkerDslPrompt(document: string): string {
  return [
    `${COMPACT_DSL_PROMPT_HEADING} ${firstLineOf(document)}`,
    "",
    `Marker-first lines: ${COMPACT_DSL_MARKER_LEGEND}`,
    "",
    ...fenced(document.replace(/\n$/, ""), "text"),
    "",
  ].join("\n");
}

function firstLineOf(document: string): string {
  return document.split("\n", 1)[0] ?? "";
}

/**
 * Wraps a document in a fence long enough that nothing inside can close it.
 *
 * Task bodies legitimately contain ``` fences, and those lines survive verbatim into `RAW`
 * blocks. A fixed three-backtick fence would let such a line terminate the block early and
 * silently truncate the compiled task — the exact partial dispatch this module refuses
 * elsewhere.
 */
function fenced(document: string, language: string): string[] {
  let longest = 0;
  for (const run of document.match(/`+/g) ?? []) {
    longest = Math.max(longest, run.length);
  }
  const fence = "`".repeat(Math.max(3, longest + 1));
  return [`${fence}${language}`, document, fence];
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
