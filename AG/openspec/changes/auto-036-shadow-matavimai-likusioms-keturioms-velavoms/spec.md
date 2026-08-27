# Spec Delta

## Added
- `COMPRESSION_METRIC_FIELDS` (metrics.ts) gains new optional input/record key pairs: one for the `compact_dsl` shadow prompt size (e.g. `compactPromptChars`/`compact_prompt_chars`), two for the `dispatch_tool_schema` shadow schema sizes (full/reduced), and — if the symbol_slices risk in Design resolves to "measurable" — the flag-off-path variants of `symbol_source_chars`/`symbol_signature_chars` (same field names, now written from BOTH the tiered-pack path and the new shadow path, never both in the same record).
- A second shadow compile call in `persist.ts` (compact_dsl variant of `compileWorkerPromptTask`), parallel to the existing `worker_task_ir` shadow compile, same fail-closed `try/catch` contract.
- A shadow resolve of dispatch MCP capabilities at dispatch-preparation time, unconditional of the live `dispatch_tool_schema` flag, producing full-vs-reduced char counts.
- A `bash-digest-shadow.jsonl` read port on `CompressionViewPorts` (ui-compression-view.ts), plus a dedicated aggregation function for that flag's raw/digest pair, separate from `summarizeContextSizeSamples`.
- Generalized `decideCompression` verdict logic covering all five `CONTEXT_COMPRESSION_FEATURES` via one shared per-flag decision routine (same reason-code vocabulary: `ir-larger-on-average` / `ir-smaller-under-pressure` / `ir-smaller-no-pressure` / `too-few-ir-comparisons` / `no-shadow-measurement`, generalized to non-`ir`-specific naming where it now applies to four more flags), with unavailable-source flags (only if the symbol_slices risk resolves to "cannot measure") staying on `no-shadow-measurement`.
- `ui-app` translations for whichever new reason codes/verdicts the generalized decision function introduces, if any go beyond the existing five.

## Changed
- `ui-compression-view.ts`'s `UiCompressionTelemetry`/`UiCompressionDecision`/`UiCompressionRecommendation` types extended to carry per-flag pair provenance (analogous to today's `ir_pair`) for each of the newly-measured flags, not just `worker_task_ir`.
- `metrics.ts` doc comments on `toolRawChars`/`toolDigestChars` ("no writer in this module") updated once a writer/reader path exists, or replaced with an explicit note that this flag's pair is intentionally sourced from `bash-digest-shadow.jsonl` instead.
- `persist.ts` comment block explaining `SHADOW_COMPRESSED_PROMPT_CONFIG` updated to describe the added `compact_dsl` shadow compile and why it stays a second, independent call rather than folding into the existing one.

## Acceptance Criteria
- Every field added to `COMPRESSION_METRIC_FIELDS` follows the existing "absent, not zero" contract: a run that never measured a value must not write a key for it, verified by tests asserting JSONL byte-identity when a new field's precondition is not met.
- All five entries in `CONTEXT_COMPRESSION_FEATURES` produce a `decideCompression` recommendation that is NOT `no-shadow-measurement`/`unmeasured` once at least `MIN_DECISION_SAMPLES` real shadow-paired samples exist for that flag — OR, for `symbol_slices` specifically, the change ships with an explicit, reviewed decision (recorded in the task's final ataskaita) that its shadow pair cannot be made free and therefore intentionally stays `unmeasured`, with the reasoning captured in code comments and the task's Stop report.
- Flipping any of the five flags ON or OFF continues to change ONLY what content is sent to the worker/dispatch; no new shadow measurement code path is reachable from, or alters, the actual (non-shadow) payload.
- The flag-off path's I/O profile for `dispatch_tool_schema` is measured before/after and reported in the task's ataskaita (small config read is acceptable; anything larger is not, per Design).
- `worker_task_ir`'s existing verdicts (all fixture cases in `compression-policy-verdicts.json` / existing `interfaces-http-compression.test.ts` cases) are byte-identical before and after the `decideCompression` generalization.
- `pnpm typecheck`, `pnpm test`, and `pnpm --dir ui-app test` all pass green.
