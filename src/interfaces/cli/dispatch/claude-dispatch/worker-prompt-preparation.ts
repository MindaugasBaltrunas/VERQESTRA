// Worker task kūno paruošimas + canary apskaita + prompt audito metaduomenys (etalonas:
// interfaces/cli/claude-dispatch/worker-prompt-preparation.ts). Kompresijos politika ir
// kompiliavimas — application/context-pack (deep-import, ne barrel — barrel'is trauktų
// code-index/rag grafus į kiekvieną dispatch'ą); arrest stebėjimas — application
// compression-arrest-observer per tą patį fs portą; task-events skaitymą paduoda kvietėjas.

import {
  COMPRESSION_FALLBACK_RAW,
  compileWorkerPromptTaskForDispatch,
  workerPromptModeOf,
  type WorkerPromptCompilation,
} from "../../../../application/context-pack/worker-prompt-compilation.js";
import {
  loadEffectiveCompressionPolicy,
  type EffectiveCompressionPolicy,
} from "../../../../application/context-pack/effective-compression-policy.js";
import {
  CONTEXT_COMPRESSION_ARREST_RELATIVE_PATH,
  defaultContextCompressionArrestState,
  describeContextCompressionArrest,
  observeContextCompressionArrest,
  selectCanaryHumanReviewTaskIds,
  type ContextCompressionConfig,
} from "../../../../application/context-pack/compression-arrest-observer.js";
import { contextArtifactSha256 } from "../../../../application/context-pack/execution-context-fingerprint.js";
import type { ClockPort, ContextPackFileSystemPort } from "../../../../application/context-pack/ports.js";
import type { DispatchExecutionRecordInput } from "../../../../application/task-execution/dispatch-execution-record.js";

export type WorkerPromptPreparation = {
  compressionConfig?: ContextCompressionConfig;
  compiledTask?: string;
  workerPromptRecord: NonNullable<DispatchExecutionRecordInput["workerPrompt"]>;
};

export type PrepareWorkerPromptDeps = {
  fs: ContextPackFileSystemPort;
  clock: ClockPort;
  runtimeRoot: string;
  /** Tolerantiškas `vq/logs/task-events.jsonl` skaitymas — canary human-review kohortai. */
  readTaskEvents(): Promise<Array<{ task_id?: unknown; to_state?: unknown }>>;
  now?: () => Date;
};

/** Paruošia worker task kūną, canary apskaitą ir prompt'o audito metaduomenis. */
export async function prepareWorkerPromptTask(
  input: {
    taskId: string;
    rawTaskText: string;
    logDispatch(line: string): Promise<void>;
  },
  deps: PrepareWorkerPromptDeps,
): Promise<WorkerPromptPreparation> {
  let compression: WorkerPromptCompilation;
  // `policy` lieka undefined TIK kai KONFIGO krovimas metė — būtent tas atvejis palieka
  // arrestView default'ą ir compressionConfig neužpildytą; kompiliavimo throw palieka
  // realią politiką vietoje (etalono semantika 1:1).
  let policy: EffectiveCompressionPolicy | undefined;
  try {
    policy = await loadEffectiveCompressionPolicy({
      fs: deps.fs,
      clock: deps.clock,
      runtimeRoot: deps.runtimeRoot,
      taskId: input.taskId,
    });
    compression = compileWorkerPromptTaskForDispatch({
      config: policy.config,
      taskId: input.taskId,
      taskText: input.rawTaskText,
    });
  } catch (error: unknown) {
    compression = {
      kind: "fallback",
      fallback: COMPRESSION_FALLBACK_RAW,
      reason: `context compression config unreadable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const arrestView = policy?.arrestView ?? { state: defaultContextCompressionArrestState(), unreadable: false };
  const compressionConfig: ContextCompressionConfig | undefined = policy?.config;
  const canaryFeatures = policy?.canaryFeatures ?? [];

  if (arrestView.unreadable) {
    await input.logDispatch(
      `CANARY ARRESTED: feature=* reason=marker-unreadable: ${CONTEXT_COMPRESSION_ARREST_RELATIVE_PATH} ` +
        `(${arrestView.unreadableReason ?? "unreadable"}) — every compression feature is treated as off; ` +
        "repair or delete the marker to restore the configured behaviour",
    );
  }
  if (compression.kind === "fallback") {
    await input.logDispatch(
      `DISPATCH COMPRESSION FALLBACK: task=${input.taskId} ` +
        `compression_fallback=${compression.fallback} reason=${compression.reason}`,
    );
  } else if (compression.kind === "compiled") {
    const dslSuffix = compression.task.dsl
      ? ` dsl_alias_saved_chars=${compression.task.dsl.alias_saved_chars}` +
        ` dsl_duplicates_removed=${compression.task.dsl.duplicates_removed}` +
        ` dsl_chars_without_aliases=${compression.task.dsl.dsl_chars_without_aliases}`
      : "";
    await input.logDispatch(
      `DISPATCH COMPRESSION: task=${input.taskId} mode=${compression.task.mode} ` +
        `raw_chars=${compression.task.rawChars} compiled_chars=${compression.task.compiledChars} ` +
        `sent_prompt_chars=${compression.task.compiledChars} ir_chars=${compression.task.irChars}${dslSuffix}`,
    );
  }

  if (canaryFeatures.length > 0) {
    await input.logDispatch(`DISPATCH COMPRESSION CANARY: task=${input.taskId} canary=${canaryFeatures.join(",")}`);
  }
  if (canaryFeatures.length > 0 && compressionConfig) {
    const humanReviewTaskIds = selectCanaryHumanReviewTaskIds(compressionConfig, await deps.readTaskEvents());
    const newArrests = await observeContextCompressionArrest(deps.fs, deps.runtimeRoot, {
      taskId: input.taskId,
      canaryFeatures,
      ...(compression.kind === "fallback" && compression.feature !== undefined
        ? { fallbackFeature: compression.feature }
        : {}),
      humanReviewTaskIds,
      now: (deps.now ?? (() => new Date()))(),
    });
    for (const arrest of newArrests) {
      await input.logDispatch(describeContextCompressionArrest(arrest));
      await input.logDispatch(
        `CANARY ARREST RECORDED: feature=${arrest.feature} ` +
          `marker=${CONTEXT_COMPRESSION_ARREST_RELATIVE_PATH} — ` +
          "the feature is off from the next dispatch; an operator lifts it by deleting the marker",
      );
    }
  }

  return {
    ...(compressionConfig === undefined ? {} : { compressionConfig }),
    ...(compression.kind === "compiled" ? { compiledTask: compression.task.text } : {}),
    workerPromptRecord: {
      mode: workerPromptModeOf(compression),
      taskSha256: contextArtifactSha256(input.rawTaskText),
      rawChars: input.rawTaskText.length,
      ...(compression.kind === "fallback"
        ? { compressionFallback: compression.fallback, fallbackReason: compression.reason }
        : {}),
      ...(compression.kind === "compiled"
        ? {
            compiledChars: compression.task.compiledChars,
            irChars: compression.task.irChars,
            ...(compression.task.dsl === undefined ? {} : { dsl: compression.task.dsl }),
          }
        : {}),
    },
  };
}
