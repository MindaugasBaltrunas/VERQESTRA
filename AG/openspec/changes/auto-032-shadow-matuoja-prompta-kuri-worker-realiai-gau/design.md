# Design

## Approach

1. **Reuse, don't re-render.** `persist.ts` already calls `renderExecutionContext(pack, { maxChars: input.maxContextChars })` once (line 154) to produce `rendered.markdown`, which is what gets written to `execution-context.md` and is byte-identical to what a real dispatch attaches. The new shadow measurement adds `rendered.markdown.length` to both sides of the existing raw/compiled pair instead of invoking the renderer again. This directly satisfies the task's Stop condition: one render, one semantics, shared by the persisted artifact and the shadow metric.
2. **New field names, not `worker_prompt_chars`.** `metrics.ts` already declares `workerPromptChars` / `worker_prompt_chars` as "the true prompt handed to dispatch, no writer in this module" and `post-run-truth-join.ts` already reads it as `compiled_chars` ground truth. Writing an assembly-time estimate into that field would retroactively redefine an existing reader's contract. This change instead adds two new optional `ContextCompressionMetricsInput` fields — proposed names `rawPromptChars` (raw task body + rendered execution context) and `compiledPromptChars` (shadow-compiled IR chars + the SAME rendered execution context) — recorded as `raw_prompt_chars` / `compiled_prompt_chars` in the JSONL, following the exact optional-field pattern already used for `irJsonChars` etc. (present only when actually measured; absent, never `0`, when the pack has no execution context or the IR shadow compile failed).
3. **Symmetric execution-context inclusion.** Both `rawPromptChars` and `compiledPromptChars` add the identical `rendered.markdown.length` term. This isolates what the comparison is actually testing — body compression — while making the shared, non-compressible execution-context cost visible in both numbers, matching the audit's finding that the body-only comparison overstates the benefit of compression as a share of the real prompt.
4. **Absence semantics preserved.** If `workerTaskIr` shadow compilation fails (existing `shadowCompileWorkerTaskIr` fail-closed path) or the pack carries no `code_context`/execution content worth rendering, the new pair is omitted from the record entirely — same discipline as every other optional field in this table, and consistent with `selectCompressionMetrics`'s existing fail-fast validation (negative/non-finite throws, not silently coerced).
5. **Decision layer fallback.** `decideCompression` (`ui-compression-view.ts`) is extended to compute its `ir_compared_count`/`ir_smaller_count`/`avg_ir_delta_percent` triad from `raw_prompt_chars`/`compiled_prompt_chars` when both are present on a sample, and from the existing `raw_task_chars`/`compiled_task_chars` when they are not — per sample, not per whole log, so a log with a mix of old and new records degrades gracefully rather than dropping every pre-migration row. The verdict reason codes and thresholds (`MIN_DECISION_SAMPLES`, pressure levels) are unchanged; only the *source pair* feeding the comparison shifts.
6. **UI naming.** `ui-app` gains a small, explicit label distinguishing "prompt-level" vs "body-only" comparisons wherever the IR delta is shown (`CompressionPage.tsx` telemetry rows, `types.ts` field types, translation strings), so an operator reading the verdict knows which pair produced it — this was the audit's core complaint ("which two things are actually being compared").

## Data Flow

```text
persistContextPack (persist.ts)
  -> renderExecutionContext(pack)         [existing single render, reused]
  -> shadowCompileWorkerTaskIr(taskId, taskText)  [existing]
  -> rawPromptChars      = taskText.length + rendered.markdown.length
  -> compiledPromptChars = workerTaskIrChars(ir) + rendered.markdown.length   (only if ir present)
  -> buildContextSizeMetrics({ ...existing fields, rawPromptChars, compiledPromptChars })
  -> appendContextSizeMetrics -> vq/logs/context-size.jsonl

buildCompressionView (ui-compression-view.ts)
  -> parseContextSizeSamples(raw)
  -> summarizeContextSizeSamples: per-sample, prefer raw_prompt_chars/compiled_prompt_chars,
     fall back to raw_task_chars/compiled_task_chars
  -> decideCompression(telemetry) -> UiCompressionDecision (reason codes unchanged)

ui-app CompressionPage.tsx -> renders telemetry + verdict, now labels which pair was used
```

## Risks

- **Still an approximation, not the true dispatch prompt.** The DSL/alias compilation done in `worker-prompt-compilation.ts` and the mode-specific formatting in `resolveCanonicalWorkerPrompt`/`buildWorkerPrompt` are not visible to `persist.ts`. `compiledPromptChars` uses the raw WorkerTaskIR JSON size (already shadow-compiled here for `ir_json_chars`), not the DSL-compiled text size that a real dispatch with `worker_task_ir` + DSL enabled would send. This narrows the gap the audit found but does not close it fully within this task's file scope — documented as a known limitation in `metrics.ts` comments and the spec's Acceptance Criteria, not silently claimed as "the real prompt".
- **029 dedup not modeled.** The real dispatch prompt, when the task body already covers a section the execution context would repeat, trims that section (task 029). `rendered.markdown.length` here is the FULL, non-deduped execution context (same value written to `execution-context.md`), so `rawPromptChars`/`compiledPromptChars` are an upper bound on the true prompt size, not exact. This is directionally safe for the decision question ("is compression smaller") since the same non-deduped context length is added to both sides, but must be called out so nobody mistakes the JSONL field for ground truth.
- **`decideCompression` fallback correctness.** Mixing per-sample pair selection (new pair when present, old pair otherwise) inside one `average()`/`percent()` computation must not silently blend two different bases into one `avg_ir_delta_percent` in a way that misrepresents magnitude — pick ONE pair per sample (never partially mix numerator from one pair and denominator from another) and keep the two source counts distinguishable if the UI needs to show "how many prompt-level vs body-only" (nice-to-have, not required by this task's `## Veiksmas`).
- **JSONL backward compatibility.** Old records lack the new fields entirely; `readContextSizeMetrics` must treat their absence as "not measured" (existing `readCompressionMetrics` pattern already does this for every optional field) — no reader may crash or coerce to `0`.
- **`selectCompressionMetrics` validation is shared.** Adding two more fields to the same finite/non-negative check in `metrics.ts` means a defect in the new chars computation (e.g. negative length from a bad slice) throws inside `persistContextPack`'s telemetry try/catch (`appendContextSizeMetrics`'s best-effort wrapper) — confirm the throw stays caught there and does not propagate into pack assembly itself (it already goes through the same `try {} catch {}` as every other metric).

## Escalation note for the coder

If the coder finds that reproducing "what the worker actually receives" at prompt level, faithfully, is not achievable within `persist.ts`'s inputs without importing from `application/task-execution/execution-context-gate.ts` or re-deriving dedup logic, STOP per the task's own `## Stop` clause rather than re-rendering with different semantics or widening scope unilaterally — surface the `worker_prompt_chars` field's existing "no writer" contract and this design's fallback approach for a human decision before proceeding.
