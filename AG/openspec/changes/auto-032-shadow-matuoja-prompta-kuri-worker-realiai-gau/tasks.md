# Tasks

- [ ] readme-guard: confirm scope (`application/context-pack`, `interfaces/http/ui-compression-view.ts`, `ui-app`) against README/architecture doc boundaries; no `AG/**`, `vq/**`, or `.env` touches.
- [ ] architect: confirm the reuse-not-rerender approach in `persist.ts` (single `renderExecutionContext` call feeding both the artifact write and the new shadow chars) satisfies the task's Stop clause; confirm new field names (`rawPromptChars`/`compiledPromptChars`, NOT `workerPromptChars`) so `post-run-truth-join.ts`'s existing `worker_prompt_chars` reader contract is not touched.
- [ ] schedule-domain / coder: add `rawPromptChars`/`compiledPromptChars` to `ContextCompressionMetricsInput`, their `raw_prompt_chars`/`compiled_prompt_chars` record counterparts, and the single `COMPRESSION_METRIC_FIELDS` table entry, in `src/application/context-pack/metrics.ts`.
- [ ] coder: compute and pass the two new fields from `persist.ts`, reusing the existing `rendered` value (no new render call) and the existing `workerTaskIr`/`irJsonChars` shadow compile; preserve absent-when-unmeasured semantics.
- [ ] coder: extend `ContextSizeSample`, `summarizeContextSizeSamples` (per-sample pair fallback), in `src/interfaces/http/ui-compression-view.ts`. Do not change `decideCompression`'s thresholds or reason-code vocabulary.
- [ ] coder: update `ui-app/src/model/types.ts` and `ui-app/src/view/pages/CompressionPage.tsx` (+ translations) to surface which pair (prompt-level vs body-only) produced the shown delta.
- [ ] reviewer: verify no second execution-context render is introduced, no existing field's write behavior changed, and `worker_prompt_chars` is left untouched (still unwritten, still reserved for the true dispatch-time value).
- [ ] tester: cover Acceptance Criteria 1-10 in `src/tests/**` (persist.ts shadow pair, metrics read/write round-trip incl. legacy records, decideCompression per-sample fallback and mixed-set behavior) and `ui-app` component/test coverage for AC10.
- [ ] tester: run `pnpm typecheck`, `pnpm test`, `pnpm --dir ui-app test`; record results in the completion report.

## AG Queue Tasks

- 032-a: `metrics.ts` — add `rawPromptChars`/`compiledPromptChars` input fields, `raw_prompt_chars`/`compiled_prompt_chars` record fields, and the single `COMPRESSION_METRIC_FIELDS` table entry; unit tests for absent-when-unmeasured and legacy-record read-back. Files: `src/application/context-pack/metrics.ts`, `src/tests/context-pack-metrics-prompt-level-shadow.test.ts`.
- 032-b (depends on 032-a): `persist.ts` — compute the new pair from the already-rendered execution context and already-shadow-compiled IR; test proving no second render call. Files: `src/application/context-pack/assemble/persist.ts`, `src/tests/context-pack-persist-prompt-level-shadow.test.ts`.
- 032-c (depends on 032-a): `ui-compression-view.ts` — per-sample pair-selection fallback in `summarizeContextSizeSamples`; tests for new-pair-only, legacy-only, and mixed sample sets. Files: `src/interfaces/http/ui-compression-view.ts`, `src/tests/ui-compression-view-prompt-level-shadow.test.ts`.
- 032-d (depends on 032-c): `ui-app` — surface which pair produced the shown delta in `CompressionPage.tsx`, update `types.ts` and translations. Files: `ui-app/src/view/pages/CompressionPage.tsx`, `ui-app/src/view/pages/CompressionPage.test.tsx`, `ui-app/src/model/types.ts`.
