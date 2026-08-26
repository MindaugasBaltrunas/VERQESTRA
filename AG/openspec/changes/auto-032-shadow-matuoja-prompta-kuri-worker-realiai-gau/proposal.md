# Proposal

## Why

`persist.ts:91-92,115-116` writes a shadow telemetry pair — `raw_task_chars` (task body) vs `ir_json_chars` (shadow-compiled WorkerTaskIR, no execution context) — into `context-size.jsonl`. The compression on/off decision in `ui-compression-view.ts` (`decideCompression`) is built entirely on that pair. Neither side of it is what the worker actually receives: the real dispatch prompt is task body (or its compiled/DSL form) **plus** the execution-context.md block, deduplicated against the task body since task 029 (`resolveCanonicalWorkerPrompt` / `taskDedupedExecutionContext`, `src/application/task-execution/execution-context-gate.ts`). The 2026-08-26 audit measured the real gap at the prompt level: +54% for the IR path vs +27% at the body-only level the current shadow reports — i.e. the existing measurement understates the cost of turning worker_task_ir on, systematically biasing the recommendation toward "enable".

## Scope

- Add a prompt-level shadow pair to `ContextSizeMetricsRecord` (`metrics.ts`): raw prompt size and compiled prompt size, each including the SAME execution-context render already produced during assembly (`renderExecutionContext(pack, ...)` in `persist.ts`, called once, result reused — not re-rendered a second time with different semantics).
- Write that pair from `persist.ts`, alongside the existing `raw_task_chars` / `ir_json_chars` fields (which keep being written unchanged — no reader is broken).
- Update `decideCompression` in `ui-compression-view.ts` to prefer the new prompt-level pair when present in a sample, falling back to the existing body-only pair when it is absent (older records, or a record where the new fields could not be computed).
- Update the `ui-app` verdict copy so the operator-facing sentence names what is actually being compared (prompt-level vs body-only), and update the telemetry table fields/translations that surface the comparison.

## Out Of Scope

- Task 029 dedup logic itself (already shipped; this change only *consumes* its output).
- Task 030/031 IR/preambule changes.
- `AG/benchmark` compression cohort tooling.
- Making assembly-time telemetry equal to the true dispatch-time prompt. The real compiled/DSL prompt text and the post-029 dedup decision are resolved later, in `application/task-execution/execution-context-gate.ts` and `interfaces/cli/dispatch/claude-dispatch/worker-prompt-preparation.ts` — outside this task's allowed files. The existing `worker_prompt_chars` field in `metrics.ts` (currently declared, unwritten — see `ContextCompressionMetricsInput.workerPromptChars`, "Assembly-time telemetry cannot measure it") is already reserved for that true, dispatch-time value and is consumed downstream by `src/application/analytics/post-run-truth-join.ts` as `compiled_chars` in the post-run truth join. This change MUST NOT write an assembly-time approximation into `worker_prompt_chars` / `worker_prompt_chars` — doing so would silently corrupt that join with an estimate instead of ground truth. New field names are required for the assembly-time shadow pair.

## Architecture Boundaries

- **Module**: `application/context-pack` (`persist.ts`, `metrics.ts`), `interfaces/http` (`ui-compression-view.ts`), `ui-app` (view-layer only: field consumption + i18n strings).
- **Reads**: `vq/logs/context-size.jsonl` (via existing `readContextSizeMetrics` / `ui-compression-view.ts` log parsing) — no new read source; the execution-context render consumed is the one already computed in-process during `persistContextPack`, not read from disk a second time.
- **Writes**: `vq/logs/context-size.jsonl` (two new optional fields appended per record, alongside all existing fields, unchanged).
- **Job types**: none (in-process telemetry append during context-pack assembly; no new job/worker type).
