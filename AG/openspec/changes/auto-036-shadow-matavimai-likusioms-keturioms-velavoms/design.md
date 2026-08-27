# Design

## Approach
One rule governs all four additions: a new measurement is either (a) computed from data the live code path ALREADY produces regardless of the flag's value, or (b) explicitly flagged as a Stop candidate if it cannot be. Each field stays optional and flows through the existing single-writer table (`COMPRESSION_METRIC_FIELDS` in metrics.ts) — no second table, no ad hoc key.

**compact_dsl** (cheapest, do first): `persist.ts` already shadow-compiles `worker_task_ir` unconditionally via `SHADOW_COMPRESSED_PROMPT_CONFIG`. Add a second shadow compile with `compact_dsl: true` alongside it (same `compileWorkerPromptTask` call, same fail-closed `try/catch` reasoning as `shadowCompileWorkerTaskIr`). Its `compiledChars` becomes a new optional metric (e.g. `compactPromptChars`/`compact_prompt_chars`) alongside the existing `irChars`/`compiledPromptChars` pair, added as one new row in `COMPRESSION_METRIC_FIELDS`. No new I/O: this is pure in-memory rendering of data already in hand.

**dispatch_tool_schema**: at the same dispatch-preparation point that currently calls `resolveDispatchMcpCapabilities`/`loadMcpCapabilityRegistry` under the live flag, ALWAYS load the registry (this is one small JSON config read, not per-task fan-out) and compute both the full-schema char size and the `selectDispatchMcpCapabilities`-reduced size, mirroring the `worker_task_ir` raw/compiled shape. Feed both into `context-size.jsonl` for the task's attempt. This changes I/O from "none when off" to "one small config read when off" — call this out explicitly in the task's Patikra/ataskaita since it is a real (if small) behavior change to the flag-off path's I/O profile, not just its content.

**bash_output_digest**: the shadow computation already exists and is already free (`post-hooks.ts` computes `digestBashOutput` unconditionally-of-content, gated only on the flag being read, and writes one JSONL line per Bash call to `bash-digest-shadow.jsonl`). The gap is purely that this data never reaches `decideCompression`. Recommended fix: do NOT try to force a per-Bash-call event into `context-size.jsonl`, which is scoped per context-pack assembly, not per tool call — the two have no natural 1:1 join key. Instead, extend `CompressionViewPorts` (ui-compression-view.ts) with a second optional log-read port for `bash-digest-shadow.jsonl`, and give this one flag its own aggregation function (raw/digest char sums across recent records) parallel to, but separate from, `summarizeContextSizeSamples`. `decideCompression` then takes this flag's pair from a different source than the other four — document why in the same comment style as `selectIrPair`. This keeps `metrics.ts`'s `toolRawChars`/`toolDigestChars` fields exactly as they are today (declared, unused) rather than forcing a mismatched join; alternatively, if `readme-guard`/`architect` prefer a single source of truth, they may instead have the hook also append an attempt-scoped `context-size.jsonl`-shaped record when `attempt_id` is resolvable — either approach is acceptable, but the two-source design is the safer default because it needs no new correlation logic.

**symbol_slices**: this is the one flag where "free" is genuinely in tension with "real measurement". `gather.ts:60-66` deliberately sets `readSourceSlices: false` and `maxContractSymbols: 0` when the flag is off specifically so that NO source-slice disk read happens on the flag-off path. A faithful shadow char count for `symbol_source_chars`/`symbol_signature_chars` needs the actual slice bytes, which means reading them — there is no in-memory data already available (unlike the other three) that yields an accurate byte count. Two paths forward, in order of preference: (1) if the symbol declarations selected for `symbol_fragments` already carry a known byte range from the code index / graph selection (i.e. `TieredContextSymbol` metadata gathered regardless of the flag), estimate SRC/SIG sizes from that range arithmetic without opening the file a second time — cheaper, approximate; (2) if no such range data exists cheaply, this shadow measurement requires a real, extra read per symbol per task, which is precisely the case CLAUDE.md's task Stop clause anticipates ("shadow matavimas... pastebimai sulėtintų dispatch kelią"). The coder must measure the actual cost on a representative task before deciding; if it is not negligible, stop and report rather than shipping it silently gated "on" for shadow purposes.

## Data Flow
```text
assembly/dispatch time
  ├─ compact_dsl shadow compile (persist.ts)      -> compact_prompt_chars  -> context-size.jsonl
  ├─ dispatch_tool_schema shadow resolve (mcp-capability-registry.ts call site) -> tool_schema_full_chars / tool_schema_reduced_chars -> context-size.jsonl
  └─ symbol_slices shadow estimate/read (gather.ts / persist.ts)  -> symbol_source_chars / symbol_signature_chars (already-off-path variant) -> context-size.jsonl

PostToolUse hook (per Bash call)
  └─ bash_output_digest shadow (post-hooks.ts, EXISTING)  -> bash-digest-shadow.jsonl (unchanged)

ui-compression-view.ts
  ├─ reads context-size.jsonl  -> per-flag pairs for compact_dsl, dispatch_tool_schema, symbol_slices, worker_task_ir
  ├─ reads bash-digest-shadow.jsonl (NEW port)  -> pair for bash_output_digest
  └─ decideCompression() generalized to loop CONTEXT_COMPRESSION_FEATURES, each keyed to its own pair source, same MIN_DECISION_SAMPLES / pressure thresholds
```

## Risks
- **symbol_slices cost**: see Approach above — the dominant risk of this change. If shadow measurement cannot be made free, this flag must ship as an explicit exception (documented `unmeasured` stays correct) rather than silently degrading dispatch latency; escalate per CLAUDE.md "Kada stabdyti ir klausti".
- **dispatch_tool_schema I/O-when-off change**: loading the MCP registry unconditionally is a real (if small) behavior delta on the flag-off path; must be measured and reported, not assumed negligible.
- **decideCompression generalization**: today's function special-cases `worker_task_ir` inline; refactoring it to loop over all five flags risks changing the existing `worker_task_ir` verdict's reason codes or thresholds if not done carefully — must be covered by a characterization test asserting today's `worker_task_ir` verdicts are byte-identical before/after the refactor.
- **Two telemetry sources for one decision function**: `bash_output_digest` reading from a different log than the other four is an asymmetry that must be documented inline (same rigor as `selectIrPair`'s comment) so a future reader does not "fix" it into a broken join.
- **CONTEXT_CACHE_VERSION**: none of these are retrieval/ranking/budget changes — no cache version bump expected, but confirm during implementation per CLAUDE.md pack-cache rule.
