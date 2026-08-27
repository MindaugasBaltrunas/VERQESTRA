# Proposal

## Why
`decideCompression` (src/interfaces/http/ui-compression-view.ts) can only ever return a real verdict for `worker_task_ir`: it is the only one of the five compression flags in `CONTEXT_COMPRESSION_FEATURES` with a shadow measurement feeding `context-size.jsonl`. The other four read as `unmeasured`/`no-shadow-measurement` today, for four different reasons that this change closes one by one:

- `bash_output_digest` — a shadow computation ALREADY runs (post-hooks.ts `digestBashOutput`), but it writes to its own log (`bash-digest-shadow.jsonl`), never reaches `context-size.jsonl`, and `metrics.ts:82-86` documents `toolRawChars`/`toolDigestChars` as "declared for schema/reader compatibility, no writer". The data exists; it is not wired to the verdict.
- `dispatch_tool_schema` — `resolveDispatchMcpCapabilities` fail-opens to zero I/O when the flag is off (`mcp-capability-registry.ts:147-148`); nothing measures what the full vs. reduced MCP schema would have cost.
- `symbol_slices` — `persist.ts:113-127` only measures `symbol_source_chars`/`symbol_signature_chars` from an ALREADY-tiered pack, i.e. only once the flag is on. With it off, `gather.ts:60-66` sets `readSourceSlices: false` and no source slice is ever read, so there is nothing to measure from.
- `compact_dsl` — the raw/compiled pair already exists inside `worker-prompt-compilation.ts` (`irChars`/`compiledChars` plus `CompactWorkerDslStats`), but `persist.ts`'s shadow compile (`SHADOW_COMPRESSED_PROMPT_CONFIG`) only exercises `worker_task_ir: true, compact_dsl: false` — the compact-DSL variant is never shadow-compiled, so its pair never reaches `context-size.jsonl`.

Without all five flags carrying a measured pair, the operator UI (`docs/audits/` 2026-08-26 compressor audit) cannot answer "is it worth turning this on" for four fifths of the levers it exposes — it can only ever recommend against the one flag that happens to be instrumented.

## Scope
- Add a shadow measurement for `bash_output_digest`, `symbol_slices`, `dispatch_tool_schema`, `compact_dsl`, following the same "absent, not zero" contract `worker_task_ir` already established in `COMPRESSION_METRIC_FIELDS`.
- Wire each new pair into `decideCompression` so it produces a real verdict (`enable`/`optional`/`hold`/`insufficient`) using the same threshold logic (`MIN_DECISION_SAMPLES`, pressure levels) already applied to `worker_task_ir`, generalized to iterate all five flags instead of special-casing one.
- Extend `ui-compression-view.ts` telemetry/decision shapes and `ui-app` translations for whatever new reason codes a generalized decision function needs.
- Where a flag's shadow pair cannot be measured without new I/O or a measurable slowdown on the live dispatch path (this is expected for `symbol_slices`, see Design), stop and report rather than silently accepting the cost.

## Out Of Scope
- Turning any of the five flags on by default or in canary.
- Benchmark-package cohorts.
- Prompt-level dedup / IR structure changes (closed by tasks 029/030).
- Changing what content is actually sent to a worker — every new measurement must be read-only telemetry.

## Architecture Boundaries
- **Module**: `application/context-pack` (metrics.ts, assemble/persist.ts, assemble/gather.ts, mcp-capability-registry.ts, worker-prompt-compilation.ts), `interfaces/hooks` (post-hooks.ts, bash digest shadow path), `interfaces/http/ui-compression-view.ts`, `ui-app/src` (verdict labels/translations only).
- **Reads**: `vq/logs/context-size.jsonl`, `vq/logs/bash-digest-shadow.jsonl`, `vq/config/context-compression.json`, MCP capability registry config (`vq/config` per mcp-capability-registry.ts), source files touched by a task (ONLY if `symbol_slices` shadow can reuse data already gathered for other purposes — see Design risk).
- **Writes**: `vq/logs/context-size.jsonl` (new optional fields per `COMPRESSION_METRIC_FIELDS`), no new files unless the `bash_output_digest` correlation design (see Design) requires reading a second existing log rather than writing a new one.
- **Job types**: nėra — pakeitimas veikia esamų assembly/dispatch/hook kelių viduje; naujo job tipo neįveda.
