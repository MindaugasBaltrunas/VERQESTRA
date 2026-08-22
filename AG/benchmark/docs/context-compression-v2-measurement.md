# Context Compression v2 — measurement design (task 0029)

Status: design only. No production flag, hook setting or config file changes.
Spec sources: `AG/project/token-optimization-2026-08-06.md`,
`AG/openspec/changes/ag-loop-benchmark-v1/spec.md` (BENCH-3, BENCH-5, BENCH-7,
BENCH-8, BENCH-9, BENCH-10).

The question this design makes answerable: **does a compression feature lower
`total tokens / verified-accepted task` without making acceptance, security or
forbidden-edit behaviour worse?** Prompt chars are diagnostics and may never
decide that question.

---

## 1. Decisions

### D1 — Compression is a second dimension, orthogonal to `ExecutionMode`

`ExecutionMode` answers *who did the work* (`ag-loop`, `agent-solo`,
`deterministic-control`). Compression answers *how much context the work was
given*. Folding one into the other would multiply `EXECUTION_MODES` by nine and
break every consumer that enumerates it (`aggregateSamplesByMode`,
`projectModeAdapterVersions`, `MODE_EXECUTION_PROFILES`, the report's mode
sections, the comparability gate). So: a new `CompressionVariant` concept,
recorded on each sample beside `mode`, never inside it.

### D2 — The feature registry is re-declared, not imported

`src/application/context-pack/effective-compression-policy.ts` is the single source of truth
for the flag names and is an orchestrator internal — the benchmark may not import
it (BENCH-1, enforced by `src/tests/architecture-boundaries.test.ts`). The five
canonical flags are therefore restated as literals in the benchmark domain, with
the registry version they were copied from, and drift is caught from the
orchestrator side by a test (see D10).

| Benchmark constant | Orchestrator flag | Landed by |
|---|---|---|
| `worker-task-ir` | `worker_task_ir` | 0021 / 0025 |
| `compact-dsl` | `compact_dsl` | 0024 / 0025 |
| `symbol-slices` | `symbol_slices` | 0022 / 0023 |
| `bash-output-digest` | `bash_output_digest` | 0026 / 0027 |
| `dispatch-tool-schema` | `dispatch_tool_schema` | 0028 |

Flag *values* stay snake_case, exactly as the config writes them; only the
variant ids are kebab-case, because stored ids are validated against the
package's `IDENTIFIER` pattern.

### D3 — "Compiled prompt" and "Bash digest handler" are not new flags

Acceptance criterion 1 names seven things; the repo has five flags. The two
extras are configurations of existing flags and are modelled as such:

- **compiled prompt** (0025) is gated by `worker_task_ir` at
  `application/context-pack/worker-prompt-compilation.ts:92`; `compact_dsl`
  only chooses the renderer (`:96`). It is therefore the *combination*
  `{worker_task_ir, compact_dsl}`, not a sixth flag.
- **Bash digest simulation vs handler** is one flag (`bash_output_digest`)
  gating two paths: the shadow observer (`hooks/post-hooks.ts:70`, cannot change
  a tool result) and the synchronous replacement path
  (`hooks/post-hooks.ts:128`), which only takes effect when a hook settings file
  points at it. Same flag set, different observable behaviour, so the wiring is
  part of the variant's identity as `hookProfile`.

`.claude/**` is forbidden to this task, so the `bash-digest-handler` variant is
*declarable but not executable here*; unexecuted means `not_measured` (D9), never
a substituted number.

### D4 — Frozen cohort (nine variants)

| id | features | hookProfile | covers criterion-1 item |
|---|---|---|---|
| `baseline` | — | `unwired` | baseline/current |
| `worker-task-ir` | `worker_task_ir` | `unwired` | WorkerTaskIR |
| `compact-dsl` | `compact_dsl` | `unwired` | compact DSL |
| `symbol-slices` | `symbol_slices` | `unwired` | REF/SIG/SRC |
| `compiled-prompt` | `worker_task_ir`, `compact_dsl` | `unwired` | compiled prompt |
| `bash-digest-shadow` | `bash_output_digest` | `unwired` | Bash digest simulation |
| `bash-digest-handler` | `bash_output_digest` | `bash-digest-handler` | Bash digest handler |
| `dispatch-tool-schema` | `dispatch_tool_schema` | `unwired` | dispatch tool-schema |
| `all-features` | all five | `bash-digest-handler` | full combination |

`compact-dsl` alone is expected to be close to a no-op on the prompt path,
because the compiler is entered only under `worker_task_ir`. That is a fact about
the rollout, not a defect: the report must present a null contribution as a
measured null, and must not "fix" the cohort to hide it.

### D5 — Combination identity is a canonical hash

`variantIdentity = canonicalDigest({ registryVersion, features: sorted, hookProfile })`
using the existing `domain/baseline/canonical-json.ts` (`sha256:` + 64 hex,
`node:crypto` only — the one external module the domain may use). Sorted feature
list, so `{a,b}` and `{b,a}` are one variant. `hookProfile` is inside the digest,
which is what makes `bash-digest-shadow` and `bash-digest-handler` two variants.
The suite, the scenario and the model are deliberately *outside* the digest: the
same variant must stay recognisable across suites and across baselines.

### D6 — "Not measured" reuses `MetricValue` / `UnmeasuredReason`

No parallel vocabulary. `UNMEASURED_REASONS` gains exactly one member:

```
"no-captured-usage" — the population's real token usage was never captured, so a
                      token total may not be summed
```

Rule (fail-closed): the token total of a population is measured **only if every
conclusive sample in it carries `usage.captured === true`**. Partial capture
yields `no-captured-usage` with the counts in `detail`, because summing the
captured subset would understate the variant that failed to report — exactly the
variant a compression change is most likely to break. `measure()` is never called
with an unknown numerator; the unmeasured value is produced directly by
`unmeasured()`.

### D7 — Total tokens include cache tokens

`totalTokens = inputTokens + outputTokens + cacheReadInputTokens + cacheCreationInputTokens`.

A variant that merely moves tokens from `input` into `cache_read` has not made
the run cheaper in tokens, and this package has no price list with which to
weight them. `nonCachedTokens = input + output` is reported alongside as
diagnostics so a reader can see the shift; it never decides the verdict.

### D8 — Real telemetry arrives through the existing envelope, extended to v2

The benchmark already takes cost from a stdout envelope
(`TELEMETRY_ENVELOPE_KEY = "agBenchmarkTelemetry"`), not by scraping logs. That
stays the contract; it is extended, not replaced:

- accepted versions become `{1, 2}`;
- v2 may carry `usage` (cache tokens, `numTurns`, `turnsSource`, `captured`) and
  `compression` (variant + char diagnostics);
- a *present but malformed* field is `telemetry-invalid` (loud), an *absent*
  field is absent (`not_measured`). Same stance as `countField` today.

A second, equally valid producer is permitted and is recorded as such: an adapter
may derive the same `usage` block from the isolated worktree's **own**
`vq/logs/token-usage.jsonl` — a documented AG log contract whose shape is
re-declared in the benchmark domain, read only in `infrastructure`, never
imported from the orchestrator. Precedence is fixed and recorded on the sample:
`source: "envelope"` wins; `source: "run-log"` is used only when no envelope
`usage` block was printed. Two sources, one field, one recorded provenance — the
report can always say where a number came from.

### D9 — Honesty guard

Today the run pipeline is not wired into the CLI composition root (`run`,
`compare`, `report`, `verify` answer `BenchmarkCapabilityUnavailableError`) and
`results/samples.jsonl` is empty. In that state this design must, and does,
produce:

- every compression aggregate: `sampleCount 0`, every rate unmeasured with
  `no-samples`;
- every variant verdict: `not_measured`, reasons
  `["baseline-not-conclusive", "variant-not-conclusive"]`;
- JSON report: **no** `tokensPerAcceptedTask` key anywhere (unmeasured ⇒ absent
  key, per `benchmark-report-json.ts`);
- Markdown report: the `## Compression` section states that no compression sample
  has been recorded and that no compression claim may be made from this package;
- a limitation repeating the README's standing sentence: the run pipeline is not
  wired, so no benchmark number exists.

Nothing in this design can produce a number without a sample. That property is
asserted by a test, not promised (§6).

---

## 2. Component map

```
domain/compression/features.ts        COMPRESSION_FEATURES, COMPRESSION_HOOK_PROFILES,
                                      CONTEXT_COMPRESSION_REGISTRY_VERSION = 1
domain/compression/variant.ts         CompressionVariant, defineCompressionVariant(),
                                      computeCompressionVariantIdentity()
domain/compression/cohort.ts          COMPRESSION_COHORT (the nine frozen variants),
                                      BASELINE_VARIANT_ID, variantById()
domain/compression/aggregate.ts       aggregateCompressionSamples() -> CompressionAggregate
domain/compression/compression-verdict.ts
                                      judgeCompressionVariant(), judgeCompressionCohort()
domain/compression.ts                 façade re-export (mirrors domain/metrics.ts, domain/baseline.ts)

domain/result.ts                      + SampleCompressionRecord, SampleUsageRecord,
                                      schema version 2
domain/metrics/metric-value.ts        + "no-captured-usage"
domain/suite-config.ts                + compressionCohort?
domain/baseline/manifest.ts           computeSuiteConfigHash projects the cohort when present
domain/schema-validation.ts           validates the new optional blocks
domain/validation.ts                  + readSchemaVersionIn()

application/report/compression-report-section.ts
                                      summarizeCompressionCohort(samples, cohort) -> the
                                      model section the report renders
application/report/benchmark-report-model.ts
                                      + BenchmarkReportModel.compression?
application/report/benchmark-report-markdown.ts
                                      + "## Compression" section
infrastructure/adapters/execution-adapter-support.ts
                                      envelope v2 reader
interfaces/report/benchmark-report-entrypoint.ts
                                      wires summarizeCompressionCohort into the generator
```

Dependency direction is unchanged: `interfaces|infrastructure → application →
domain`; the new domain modules import only their own siblings and, transitively,
`node:crypto` through `canonical-json.ts`.

---

## 3. New and changed types (exact paths)

### `src/domain/compression/features.ts` (new)

```ts
export const CONTEXT_COMPRESSION_REGISTRY_VERSION = 1;   // vq/config/context-compression.json "version"
export const COMPRESSION_FEATURES = [
  "worker_task_ir", "compact_dsl", "symbol_slices",
  "bash_output_digest", "dispatch_tool_schema",
] as const;
export type CompressionFeature = (typeof COMPRESSION_FEATURES)[number];

export const COMPRESSION_HOOK_PROFILES = ["unwired", "bash-digest-handler"] as const;
export type CompressionHookProfile = (typeof COMPRESSION_HOOK_PROFILES)[number];
```

### `src/domain/compression/variant.ts` (new)

```ts
export interface CompressionVariant {
  readonly id: string;                              // kebab-case, matches IDENTIFIER
  readonly features: readonly CompressionFeature[]; // sorted, deduplicated
  readonly hookProfile: CompressionHookProfile;
  readonly identity: string;                        // sha256:<64 hex>
}
export function defineCompressionVariant(input: {
  id: string; features: readonly CompressionFeature[]; hookProfile: CompressionHookProfile;
}): CompressionVariant;                             // sorts, dedupes, digests, freezeDeep
export function computeCompressionVariantIdentity(
  features: readonly CompressionFeature[], hookProfile: CompressionHookProfile,
): string;
```

### `src/domain/result.ts` (changed)

```ts
export const BENCHMARK_SAMPLE_SCHEMA_VERSION = 2;
export const SUPPORTED_BENCHMARK_SAMPLE_SCHEMA_VERSIONS = [1, 2] as const;

export const USAGE_SOURCES = ["envelope", "run-log"] as const;
export const TURNS_SOURCES = ["recorded", "dispatch-attempts"] as const;

/** Cost detail `SampleTelemetry` does not carry. Absent ⇒ never measured. */
export interface SampleUsageRecord {
  readonly source: UsageSource;
  /** false ⇒ the model ran but accounting failed; every count below is absent. */
  readonly captured: boolean;
  readonly cacheReadInputTokens?: number;
  readonly cacheCreationInputTokens?: number;
  readonly numTurns?: number;
  readonly turnsSource?: TurnsSource;
}

/** Char counters. Diagnostics only — never an input to the KPI or the verdict. */
export interface SampleCompressionDiagnostics {
  readonly rawTaskChars?: number;
  readonly compiledTaskChars?: number;
  readonly workerPromptChars?: number;
  readonly symbolSourceChars?: number;
  readonly symbolSignatureChars?: number;
  readonly toolRawChars?: number;
  readonly toolDigestChars?: number;
}

export interface SampleCompressionRecord {
  readonly variantId: string;
  readonly variantIdentity: string;
  readonly features: readonly CompressionFeature[];
  readonly hookProfile: CompressionHookProfile;
  readonly diagnostics?: SampleCompressionDiagnostics;
}

export interface BenchmarkSample {
  /* …unchanged fields… */
  readonly usage?: SampleUsageRecord;
  readonly compression?: SampleCompressionRecord;
}
```

`SampleTelemetry` is **not** changed: `inputTokens` / `outputTokens` stay its
required fields and stay the only place they are written. `usage` carries only
what `telemetry` lacks, so no number exists twice and no reconciliation rule is
needed.

### `src/domain/compression/aggregate.ts` (new)

```ts
export interface CompressionUsageTotals {
  readonly totalTokens: MetricValue;         // per conclusive sample
  readonly nonCachedTokens: MetricValue;
  readonly cacheReadTokens: MetricValue;
  readonly cacheCreationTokens: MetricValue;
  readonly turnsPerTask: MetricValue;
}
export interface CompressionDiagnosticTotals {
  readonly rawTaskChars: MetricValue;  readonly compiledTaskChars: MetricValue;
  readonly workerPromptChars: MetricValue;
  readonly symbolSourceChars: MetricValue; readonly symbolSignatureChars: MetricValue;
  readonly toolRawChars: MetricValue;  readonly toolDigestChars: MetricValue;
}
export interface CompressionAggregate {
  readonly variant: CompressionVariant;
  /** The BENCH-7 fold, unchanged and unduplicated: aggregateSamples(samples). */
  readonly quality: BenchmarkMetricsReport;
  /** THE economic KPI: total tokens over verified-accepted tasks. */
  readonly tokensPerAcceptedTask: MetricValue;
  readonly repairsPerTask: MetricValue;
  readonly humanReviewEventsPerTask: MetricValue;
  readonly usage: CompressionUsageTotals;
  readonly diagnostics: CompressionDiagnosticTotals;
  /** Conclusive samples whose usage was captured; the KPI's precondition. */
  readonly capturedUsageCount: number;
}
export function aggregateCompressionSamples(
  variant: CompressionVariant, samples: readonly BenchmarkSample[],
): CompressionAggregate;
```

`quality` is the existing `aggregateSamples()` result, not a copy of its logic.
`repairsPerTask` / `humanReviewEventsPerTask` are new because criterion 2 asks
for *per task* counts, while the existing `repairRate` / `humanReviewRate` are
share-of-samples-that-had-any; both are reported.

---

## 4. Acceptance criterion 2 → field map (1:1)

| Criterion 2 asks for | Sample field | Aggregate field |
|---|---|---|
| accepted / pass | `acceptance.verdict` | `quality.acceptedRate`, `quality.firstPassRate` |
| forbidden edits | `workspace.outOfScopeFiles` | `quality.outOfScopeRate` |
| security / refusal outcome | `checks[kind="security"]`, `acceptance.reasons` | `quality.securityFailureRate` |
| human review per task | `telemetry.humanReviewEvents` | `humanReviewEventsPerTask` (+ `quality.humanReviewRate`) |
| repair per task | `telemetry.repairs` | `repairsPerTask` (+ `quality.repairRate`) |
| input tokens | `telemetry.inputTokens` | `usage.nonCachedTokens`, `tokensPerAcceptedTask` |
| output tokens | `telemetry.outputTokens` | idem |
| cache-read tokens | `usage.cacheReadInputTokens` | `usage.cacheReadTokens` |
| cache-creation tokens | `usage.cacheCreationInputTokens` | `usage.cacheCreationTokens` |
| `num_turns` | `usage.numTurns` (+ `usage.turnsSource`) | `usage.turnsPerTask` |
| raw prompt chars | `compression.diagnostics.rawTaskChars` | `diagnostics.rawTaskChars` |
| compiled prompt chars | `compression.diagnostics.compiledTaskChars`, `workerPromptChars` | idem |
| symbol SRC / SIG chars | `compression.diagnostics.symbolSourceChars` / `symbolSignatureChars` | idem |
| Bash raw / digest chars | `compression.diagnostics.toolRawChars` / `toolDigestChars` | idem |
| combination identity | `compression.variantId`, `variantIdentity`, `features`, `hookProfile` | `variant` |

Every orchestrator-side counter above already exists:
`src/application/context-pack/metrics.ts`
(`ContextCompressionMetricsInput`, all seven char fields) and
`src/infrastructure/state/token-usage-log.ts` (`ClaudeUsage` spread ⇒
`input_tokens`, `output_tokens`, `cache_read_input_tokens`,
`cache_creation_input_tokens`; plus `num_turns`, `usage_captured`,
`dispatch_tool_schema`, `disallowed_tools`, `tools_offered`).

---

## 5. The verdict algorithm

`src/domain/compression/compression-verdict.ts` — pure, total, no clock, no I/O.

```ts
export const COMPRESSION_VERDICTS = ["accepted", "rejected", "not_measured"] as const;

export interface CompressionVariantVerdict {
  readonly variantId: string;
  readonly variantIdentity: string;
  readonly verdict: CompressionVerdict;
  readonly reasons: readonly string[];         // kebab-case, deduped, sorted
  readonly evidence: CompressionVerdictEvidence; // both sides' KPI + the three predicates
}
```

```text
judgeCompressionVariant(baseline, variant):

  if variant.identity == baseline.identity:
      return not_measured ["variant-is-baseline"]

  # 1. population
  regressed  = false
  unmeasured = false
  if baseline.quality.conclusiveCount == 0: reasons += "baseline-not-conclusive"; unmeasured = true
  if variant.quality.conclusiveCount  == 0: reasons += "variant-not-conclusive";  unmeasured = true

  # 2. quality non-regression — three predicates, all fail-closed
  #    acceptedRate            higher is better, tolerance SUCCESS_RATE_MATERIAL_DELTA (0.1)
  #    securityFailureRate     lower is better,  tolerance 0
  #    outOfScopeRate          lower is better,  tolerance 0   (= forbidden edits)
  for (key, b, v, higherIsBetter, tolerance) in PREDICATES:
      if not isMeasured(b) or not isMeasured(v):
          reasons += key + "-not-measured"; unmeasured = true
      else:
          delta = higherIsBetter ? (b.value - v.value) : (v.value - b.value)   # >0 means worse
          if delta > tolerance: reasons += key + "-regressed"; regressed = true

  # 3. the economic KPI
  cheaper = false
  kb = baseline.tokensPerAcceptedTask ; kv = variant.tokensPerAcceptedTask
  if not isMeasured(kb) or not isMeasured(kv):
      reasons += "tokens-per-accepted-task-not-measured"
      reasons += "usage-" + (unmeasuredReasonOf(kb) or unmeasuredReasonOf(kv))   # e.g. usage-no-captured-usage
      unmeasured = true
  else if kv.value < kb.value * (1 - COST_MATERIAL_RELATIVE_DELTA):   # 0.1
      cheaper = true; reasons += "tokens-per-accepted-task-lower"
  else:
      reasons += "tokens-per-accepted-task-not-lower"

  # 4. rollup — priority rejected > not_measured > accepted
  if regressed:   return rejected     (evidence of harm is not weakened by other evidence being incomplete)
  if unmeasured:  return not_measured (never resolve "we could not tell" into a claim)
  if not cheaper: return rejected
  return accepted  [+ "quality-non-regressed"]
```

Rollup priority mirrors `domain/comparison/verdict-priority.ts` one level up:
there `regressed > inconclusive > improved > stable`; here `rejected >
not_measured > accepted`. One argument, one shape, two vocabularies — the
compression verdict is deliberately a *separate* enum because `accepted` is a
rollout decision, not a statement that a distribution moved.

**Threshold reuse.** `SUCCESS_RATE_MATERIAL_DELTA` and
`COST_MATERIAL_RELATIVE_DELTA` from `domain/comparison/thresholds.ts` are reused
verbatim: they are the package's stated noise floor, and inventing a second one
would let the same evidence produce two verdicts. Security and forbidden-edit
rates get tolerance `0` instead, matching BENCH-9's rule that a *new* security or
out-of-scope violation is always a regression regardless of cost movement.

**Cohort rollup.** `judgeCompressionCohort(aggregates)` returns one verdict per
non-baseline variant in `COMPRESSION_COHORT` declaration order — deterministic,
never sample-arrival order. It publishes no single "winner": a cohort verdict
would hide which feature earned the number.

### Per-feature contribution

For each single-feature variant `v`:
`contributionTokens = baseline.KPI - v.KPI` (absolute) and its relative form,
both `undefined` when either side is unmeasured. For `all-features`:

```
sumOfSingleFeatureContributions = Σ measured single-feature contributions
observedCombinationContribution = baseline.KPI - allFeatures.KPI
interactionResidual             = observed - sum        (only when all terms are measured)
```

What the report may claim, stated in its own limitations:

- a contribution is attributable to a feature **only** from that feature's own
  single-feature variant;
- contributions are **not additive**; `interactionResidual` is a measured fact
  about the combination and is attributable to no individual feature;
- a feature never run individually is `not_measured` and is **never** derived by
  subtracting the others from the combination.

---

## 6. Schema versioning and hash freezing

**Sample schema 1 → 2.** `compression` and `usage` are optional in v2. Old lines
stay readable: `domain/validation.ts` gains

```ts
export function readSchemaVersionIn(source, at, problems, supported: readonly number[]): number | undefined
```

(`readSchemaVersion` keeps its single-version contract for the suite and config
documents). `validateBenchmarkSample` accepts `{1, 2}`; a v1 record carrying
`compression` or `usage` is `inconsistent` (those keys did not exist under v1, so
their presence means the writer's version claim is false). The writer always
emits 2. Why bump at all: a reader that ignored `compression` would fold baseline
and variant samples into one population and publish the average as a comparison —
the version is the guard that makes that impossible.

**`suiteHash` — unchanged.** No scenario document is touched. `scenarios/**` and
`fixtures/**` are outside this task's write set.

**`configHash` — changes only when a cohort is declared.**
`BenchmarkSuiteConfig` gains an optional `compressionCohort`;
`computeSuiteConfigHash` projects it **only when present**, so a config without a
cohort canonicalises byte-identically to today and yields the identical digest.
Existing baselines therefore stay comparable, and a run that *does* execute a
cohort is visibly a different configuration — which is precisely what BENCH-8
comparability requires. `SUITE_CONFIG_SCHEMA_VERSION` stays `1` (an optional
field whose absence is a valid, meaning-preserving state).

**Baseline manifest — unchanged.** It already hashes `identity.configHash`, so
the cohort enters the manifest transitively. No new manifest field, no
`BASELINE_MANIFEST_SCHEMA_VERSION` bump.

**Variant identity is a third, independent hash** (D5) and enters neither
`suiteHash` nor `configHash` directly.

**Adapter versions.** `AG_LOOP_ADAPTER_VERSION` and
`AGENT_SOLO_ADAPTER_VERSION` move to `/2`: their telemetry-reading contract
changed, and an adapter change alone can move every number in a report.
`DETERMINISTIC_CONTROL_ADAPTER_VERSION` stays `/1` — it reports no usage and its
behaviour is untouched.

**Samples with no `compression` block** belong to no variant. They are excluded
from every compression aggregate and surface as an `unattributed-samples`
limitation — the same treatment `benchmark-comparison.ts` gives samples naming an
undeclared scenario. They are never folded into `baseline`.

---

## 7. Report

`BenchmarkReportModel` gains one optional section, built by
`application/report/compression-report-section.ts` and only *rendered* by the two
renderers (BENCH-11: the report never recomputes a number it was handed).

```ts
export interface ReportCompressionVariantRow {
  readonly variantId: string; readonly variantIdentity: string;
  readonly features: readonly string[]; readonly hookProfile: string;
  readonly sampleCount: number; readonly conclusiveCount: number;
  readonly capturedUsageCount: number;
  readonly verdict: CompressionVerdict; readonly reasons: readonly string[];
  readonly tokensPerAcceptedTask: number | undefined;
  readonly tokensPerAcceptedTaskDelta: number | undefined;      // vs baseline, absolute
  readonly tokensPerAcceptedTaskRelativeDelta: number | undefined;
  readonly acceptedRate / securityFailureRate / outOfScopeRate: number | undefined;
  readonly repairsPerTask / humanReviewEventsPerTask: number | undefined;
  readonly diagnostics: readonly ReportMetricRow[];              // char counters, kind "cost"
}
export interface ReportCompressionSection {
  readonly registryVersion: number;
  readonly baselineVariantId: string;
  readonly variants: readonly ReportCompressionVariantRow[];     // cohort declaration order
  readonly combination: ReportCompressionCombination | undefined; // sum / observed / residual
  readonly unattributedSampleCount: number;
}
```

Markdown: a new `## Compression` section inserted between `## Scenarios` and
`## Limitations`, added to `MARKDOWN_REPORT_SECTIONS`. Every number goes through
the existing `canonicalReportNumber` / `formatReportNumber`, so an unmeasured
value renders `n/a` in Markdown and is an absent key in JSON — no new "not
measured" spelling is introduced.

**Persistence.** No new store and no new file. Per-sample evidence lands in the
existing `results/samples.jsonl` through `JsonlSampleStore` (validated on write,
as today). The verdict document is a section of the existing
`reports/benchmark-report.json` / `.md`, produced only by
`pnpm --dir AG/benchmark benchmark:report`. Those two files are **never**
hand-edited; regenerating them is the only sanctioned way to change them, and
with an empty ledger the regenerated report must still say `not_measured`.

---

## 8. Test plan

| File | Asserts |
|---|---|
| `src/tests/compression-variant.test.ts` (new) | identity is stable and order-independent (`{a,b}` = `{b,a}`); `hookProfile` changes the identity (shadow ≠ handler); every cohort id matches the package `IDENTIFIER` pattern and is unique; every cohort identity is unique; every feature in the cohort is in `COMPRESSION_FEATURES`; the cohort contains exactly one variant per criterion-1 item plus `all-features`; variants are frozen. |
| `src/tests/compression-aggregate.test.ts` (new) | empty population ⇒ every metric unmeasured with `no-samples`; inconclusive samples enter no numerator or denominator; **partial usage capture ⇒ `tokensPerAcceptedTask` unmeasured with `no-captured-usage`**; `usage.captured === false` never yields a measured KPI; total tokens include cache read + cache creation; `repairsPerTask` / `humanReviewEventsPerTask` divide by conclusive samples; aggregation is order-independent; samples of another variant are excluded. |
| `src/tests/compression-verdict.test.ts` (new) | accepted only when all three quality predicates hold *and* the KPI is materially lower; a measured security-failure increase of any size ⇒ `rejected`; a forbidden-edit increase of any size ⇒ `rejected`; an accepted-rate drop within `SUCCESS_RATE_MATERIAL_DELTA` is not a regression, beyond it is; a KPI lower by less than `COST_MATERIAL_RELATIVE_DELTA` ⇒ `rejected` with `tokens-per-accepted-task-not-lower`; missing usage ⇒ `not_measured`, never `accepted`, never `0`; regression + unmeasured KPI ⇒ `rejected` (priority); **two aggregates differing only in char diagnostics produce the identical verdict** (chars can never declare a winner); reasons are deduped, sorted, kebab-case; the function is pure (same input, same output, twice). |
| `src/tests/compression-report.test.ts` (new) | empty ledger ⇒ every variant `not_measured` and the JSON contains no `tokensPerAcceptedTask` key; the Markdown `## Compression` section exists, is in `MARKDOWN_REPORT_SECTIONS`, and carries the "no compression sample has been recorded" sentence; single-feature contributions are shown per feature; the combination row shows sum / observed / residual and the "not additive" limitation; a feature not run individually is `n/a`, never derived by subtraction; JSON and Markdown state the same verdict for every variant. |
| `src/tests/schema-validation.test.ts` (extend) | a v2 sample without `compression`/`usage` validates; a v1 sample validates; a v1 sample carrying `compression` or `usage` is `inconsistent`; an unknown schema version is refused; a malformed diagnostics value (negative, non-integer) is refused; `usage.captured === false` together with a token count is `inconsistent`; unknown keys inside `compression` / `usage` are refused. |
| `src/tests/execution-mode-adapters.test.ts` (extend) | a v1 envelope still parses (unchanged behaviour); a v2 envelope's `usage` / `compression` blocks reach the outcome; a malformed v2 field ⇒ `telemetry-invalid`, not silent zeros; an absent `usage` block ⇒ absent, not zero; the bumped adapter versions. |
| `src/tests/baseline-manifest.test.ts` (extend) | a config **without** `compressionCohort` hashes exactly as before; adding a cohort changes `configHash`; reordering the cohort's features does not. |
| `src/tests/architecture-boundaries.test.ts` | unchanged — it must keep passing, including "the domain imports nothing but its own modules and `node:crypto`" and "no source file imports AG orchestrator or UI internals". |
| `src/tests/characterization-compression-policy.test.ts` (new) | orchestrator `CONTEXT_COMPRESSION_FEATURES` equals the literal five-flag list the benchmark declares, and `CONTEXT_COMPRESSION_CONFIG_VERSION` equals the registry version the benchmark copied — the drift guard, held from the side that *may* import the policy module. |

Commands: `pnpm --dir AG/benchmark test`, `pnpm --dir AG/orchestrator typecheck`,
`pnpm --dir AG/orchestrator test`.

---

## 9. Files the coder may touch

**Create**

```
AG/benchmark/src/domain/compression/features.ts
AG/benchmark/src/domain/compression/variant.ts
AG/benchmark/src/domain/compression/cohort.ts
AG/benchmark/src/domain/compression/aggregate.ts
AG/benchmark/src/domain/compression/compression-verdict.ts
AG/benchmark/src/domain/compression.ts
AG/benchmark/src/application/report/compression-report-section.ts
AG/benchmark/src/tests/compression-fixtures.ts
AG/benchmark/src/tests/compression-variant.test.ts
AG/benchmark/src/tests/compression-aggregate.test.ts
AG/benchmark/src/tests/compression-verdict.test.ts
AG/benchmark/src/tests/compression-report.test.ts
src/tests/characterization-compression-policy.test.ts
```

**Modify**

```
AG/benchmark/src/domain/result.ts
AG/benchmark/src/domain/validation.ts
AG/benchmark/src/domain/schema-validation.ts
AG/benchmark/src/domain/metrics/metric-value.ts
AG/benchmark/src/domain/suite-config.ts
AG/benchmark/src/domain/baseline/manifest.ts
AG/benchmark/src/application/report/benchmark-report-model.ts
AG/benchmark/src/application/report/benchmark-report-markdown.ts
AG/benchmark/src/application/run/isolated-run-record.ts        (carry the record through)
AG/benchmark/src/infrastructure/adapters/execution-adapter-support.ts
AG/benchmark/src/infrastructure/adapters/ag-loop-execution-adapter.ts
AG/benchmark/src/infrastructure/adapters/agent-solo-execution-adapter.ts
AG/benchmark/src/interfaces/report/benchmark-report-entrypoint.ts
AG/benchmark/src/index.ts                                       (export ./domain/compression.js)
AG/benchmark/src/tests/sample-fixtures.ts
AG/benchmark/src/tests/schema-validation.test.ts
AG/benchmark/src/tests/execution-mode-adapters.test.ts
AG/benchmark/src/tests/baseline-manifest.test.ts
AG/benchmark/README.md                                          (status + link to this doc)
AG/benchmark/reports/benchmark-report.{json,md}                 REGENERATED ONLY, never hand-edited
```

**Must not touch**

```
vq/config/context-compression.json         (flag registry — read-only for this task)
src/**                     (except src/tests/*)
AG/orchestrator/templates/**
.claude/**                                 (hook wiring stays as it is)
AG/benchmark/scenarios/**                  (the cohort is frozen; no scenario changes)
AG/benchmark/fixtures/**                   (no "fixing" a fixture to flatter compression)
AG/benchmark/scenarios/suite.lock.json, any baseline manifest
AG/state/**, AG/logs/**, dist/**, .env*, root README.md, AG/README.md
```

---

## 10. Out of scope, stated so it is not drifted into

- Wiring the run pipeline into the CLI composition root (BENCH-011). Without it
  no compression sample can be produced, and this design's answer in that state
  is `not_measured` end to end.
- Turning any production flag on, and any automatic rollout (tasks 0030 / 0031).
- Estimating tokens from chars. `estimateTokensFromChars` exists on the
  orchestrator side for context-size telemetry; it must never reach a benchmark
  KPI, and `compression-verdict.test.ts` asserts that chars cannot move a verdict.
- Weighting cache-read tokens by price. Total tokens is the KPI; a cost model
  needs a price list this package does not have.
