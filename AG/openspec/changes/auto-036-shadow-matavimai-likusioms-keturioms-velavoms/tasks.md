# Tasks

- [ ] readme-guard: confirm module boundaries for `application/context-pack`, `interfaces/hooks`, `interfaces/http/ui-compression-view.ts`, `ui-app` before any edit.
- [ ] architect: decide the `bash_output_digest` correlation design (two-source `CompressionViewPorts` read vs. hook also appending to `context-size.jsonl`) and record the decision + reasoning inline; decide whether `symbol_slices` shadow measurement can be made free (byte-range estimate from already-gathered `TieredContextSymbol` metadata) or must be deferred/escalated per the Stop clause.
- [ ] schedule-domain/coder: add `compact_dsl` shadow compile in `src/application/context-pack/assemble/persist.ts`, new metric field(s) in `src/application/context-pack/metrics.ts` `COMPRESSION_METRIC_FIELDS`.
- [ ] schedule-domain/coder: add `dispatch_tool_schema` shadow full/reduced schema size measurement at the dispatch-preparation call site (`src/application/context-pack/mcp-capability-registry.ts` and/or its composition call site within allowed paths), new metric fields.
- [ ] schedule-domain/coder: implement `symbol_slices` shadow measurement per the architect's decision from step above — either a cheap estimate wired into `context-size.jsonl`, or an explicit `unmeasured`-stays-correct no-op with documented reasoning, in `src/application/context-pack/assemble/gather.ts` / `assemble/persist.ts`.
- [ ] coder: wire `bash_output_digest`'s existing shadow log (`bash-digest-shadow.jsonl`) into `src/interfaces/http/ui-compression-view.ts` via a new read port and dedicated aggregation function.
- [ ] coder: generalize `decideCompression`/`decidePressure` in `src/interfaces/http/ui-compression-view.ts` to iterate all five `CONTEXT_COMPRESSION_FEATURES`, each keyed to its own measured-pair source; keep `worker_task_ir` behavior byte-identical.
- [ ] i18n (jei reikia): add `ui-app/src` translations for any new verdict/reason codes.
- [ ] reviewer: verify no new field breaks the "absent, not zero" contract; verify no live (non-shadow) payload changed; verify `dispatch_tool_schema` I/O-when-off delta is small and documented.
- [ ] tester: characterization test that `worker_task_ir` verdicts are unchanged; new tests for each of the four flags' shadow pairs and their `decideCompression` verdicts (moka / nemoka / trūksta mėginių), including the `symbol_slices` `unmeasured`-stays-correct case if that path is taken.
- [ ] Run `pnpm typecheck && pnpm test && pnpm --dir ui-app test`; all green before commit.

## AG Queue Tasks

### 036-a — compact_dsl ir dispatch_tool_schema shadow poros
Failai: `src/application/context-pack/assemble/persist.ts`, `src/application/context-pack/metrics.ts`, `src/application/context-pack/mcp-capability-registry.ts`, `src/tests/context-pack.test.ts`, `src/tests/interfaces-http-compression.test.ts`.
Agentai: readme-guard -> architect -> schedule-domain -> coder -> reviewer -> tester.
Dependencies: depends_on 032-shadow-matuoja-prompta-kuri-worker-realiai-gauna.md.

### 036-b — bash_output_digest sujungimas su decideCompression
Failai: `src/interfaces/http/ui-compression-view.ts`, `src/interfaces/hooks/post-hooks.ts` (tik jei architect renkasi hook'o writer variantą), `src/tests/interfaces-http-compression.test.ts`.
Agentai: readme-guard -> architect -> coder -> reviewer -> tester.
Dependencies: depends_on 036-a (bendra `decideCompression` generalizacija).

### 036-c — symbol_slices shadow matavimas arba dokumentuotas atsisakymas
Failai: `src/application/context-pack/assemble/gather.ts`, `src/application/context-pack/assemble/persist.ts`, `src/tests/context-pack.test.ts`.
Agentai: readme-guard -> architect -> schedule-domain -> coder -> reviewer -> tester.
Dependencies: depends_on 036-a; STOP jei matavimas nėra nemokamas — eskaluoti, ne tyliai priimti.

### 036-d — decideCompression generalizacija ir UI vertimai
Failai: `src/interfaces/http/ui-compression-view.ts`, `ui-app/src/**` (tik verdikto laukai ir vertimai), `src/tests/interfaces-http-compression.test.ts`.
Agentai: readme-guard -> architect -> coder -> i18n -> reviewer -> tester.
Dependencies: depends_on 036-a, 036-b, 036-c.
