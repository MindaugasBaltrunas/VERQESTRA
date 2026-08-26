import type { BenchmarkBaseline, BenchmarkEnvironment, BenchmarkIdentity } from "../../domain/baseline.js";
import type { BenchmarkMetrics, CostMetrics, ModeMetrics } from "../../domain/metrics.js";
import {
  COST_BASIS_KEYS,
  COST_METRIC_KEYS,
  RATE_METRIC_KEYS,
  aggregateSamplesByMode,
  toModeMetrics,
  type CostBasisKey,
  type CostMetricKey,
  type RateMetricKey,
} from "../../domain/metrics/aggregate.js";
import { EXECUTION_MODES, type BenchmarkSample, type ExecutionMode } from "../../domain/result.js";
import type {
  BenchmarkComparison,
  ComparisonVerdict,
  DistributionStatistics,
} from "../../domain/verdict.js";
import type { BenchmarkRunSummary } from "../benchmark-api.js";
import { MODE_EXECUTION_PROFILES, type ModeDifference } from "../ports/execution-plan.js";
import { redactSecrets } from "../secret-redaction.js";
// Type-only, and deliberately so: `compression-report-section.ts` builds its
// rows with this module's `toMetricRow`, and a value import back would make the
// two a runtime cycle.
import type { ReportCompressionSection } from "./compression-report-section.js";

/**
 * The benchmark report model (BENCH-10).
 *
 * JSON and Markdown are two renderings of *this* value and of nothing else. That
 * is the whole design: a report layer that let each format assemble its own facts
 * would eventually publish two documents about one run that disagree, and a
 * reader has no way to tell which of them is the benchmark. So the model is built
 * once, the renderers only format it, and "the two formats say the same thing" is
 * a property of the structure rather than a promise in a comment.
 *
 * ## Deterministic by construction
 *
 * Two reports of the same inputs are byte-identical (BENCH-10). Three rules make
 * that true rather than likely:
 *
 * - **No clock and no host lookup.** The model carries no generation timestamp.
 *   A report is traced to its inputs by the hashes in {@link ReportSources}, and
 *   a stamp saying when it was printed would make every regeneration a diff while
 *   adding nothing a reader can verify.
 * - **Declared order everywhere.** Modes follow {@link EXECUTION_MODES}, metrics
 *   follow the key lists `domain/metrics/aggregate.ts` exports, and scenarios
 *   keep the order the comparison delivered them in — which is the suite's own
 *   declaration order, not the order samples arrived.
 * - **One canonical number format.** Every number is rounded once, here, by
 *   {@link canonicalReportNumber}. Rounding in the renderers instead would let
 *   the JSON say `0.3333333333333333` where the Markdown says `0.3333`, and the
 *   two documents would be reporting different numbers for the same metric.
 *
 * ## What the model may not carry
 *
 * No secret, and no path. Every string a caller supplies for the reproduction
 * command goes through {@link redactSecrets}, and a baseline is named by its
 * identity hashes rather than by the file it was read from: a report is committed
 * and shared, and an absolute path discloses the author's machine while adding
 * nothing a reader of the report can check.
 *
 * ## What it must carry
 *
 * The verdict and its reasons, both runs' identities and environments, the
 * per-mode metric comparison together with the declared differences between the
 * modes (BENCH-3), the per-scenario statistics (BENCH-9), the limitations, the
 * source hashes and the command that reproduces the report (BENCH-10).
 */

export const BENCHMARK_REPORT_SCHEMA_VERSION = 1;

/** Decimal places every non-integer number in a report is rounded to. */
export const REPORT_DECIMAL_PLACES = 4;

/** How an unmeasured value reads in a rendered report. */
export const UNMEASURED_TEXT = "n/a";

const REPORT_DECIMAL_SCALE = 10 ** REPORT_DECIMAL_PLACES;

/** Above this magnitude the scaling below would lose exactness, so the value is left as it is. */
const EXACT_ROUNDING_CEILING = Number.MAX_SAFE_INTEGER / REPORT_DECIMAL_SCALE;

// The delivery layer renders the model but may not import the domain, so the
// contracts it needs to name are re-exported here (`interfaces -> domain` is a
// forbidden dependency; see `AG/architecture/architecture-style.json`).
export type { BenchmarkBaseline, BenchmarkEnvironment, BenchmarkIdentity } from "../../domain/baseline.js";
export type { BenchmarkSample, ExecutionMode } from "../../domain/result.js";
export type {
  BenchmarkComparison,
  ComparisonVerdict,
  DistributionStatistics,
} from "../../domain/verdict.js";
export type { ModeDifference } from "../ports/execution-plan.js";
export type {
  ReportCompressionCombination,
  ReportCompressionFeatureContribution,
  ReportCompressionSection,
  ReportCompressionVariantRow,
} from "./compression-report-section.js";

// ---------------------------------------------------------------------------
// Canonical numbers
// ---------------------------------------------------------------------------

/**
 * The one rounding every reported number passes through.
 *
 * Integers are returned unchanged — a sample count is exact and must not acquire
 * a decimal point — and everything else is rounded to
 * {@link REPORT_DECIMAL_PLACES}. Negative zero is normalised to zero, because
 * `-0` and `0` are the same measurement and would otherwise render differently
 * in the two formats.
 *
 * A non-finite value throws rather than rendering as `null`, `NaN` or `Infinity`:
 * the metric layer already represents "not measured" as `undefined`, so a
 * non-finite number reaching here is a defect upstream, and printing it would
 * publish it as a measurement.
 */
export function canonicalReportNumber(value: number): number {
  if (!Number.isFinite(value)) {
    throw new TypeError(
      `A benchmark report may not carry the non-finite value ${String(value)}; an unmeasured metric is \`undefined\`, not a number.`,
    );
  }
  if (Number.isInteger(value)) return value === 0 ? 0 : value;
  if (Math.abs(value) >= EXACT_ROUNDING_CEILING) return value;
  const rounded = Math.round(value * REPORT_DECIMAL_SCALE) / REPORT_DECIMAL_SCALE;
  return rounded === 0 ? 0 : rounded;
}

/** {@link canonicalReportNumber} over a value that may be absent. */
function canonicalOptionalNumber(value: number | undefined): number | undefined {
  return value === undefined ? undefined : canonicalReportNumber(value);
}

/**
 * The text form of a canonical number, shared by both renderers.
 *
 * Non-integers are printed with a fixed number of decimals so a column of rates
 * lines up and so two reports of the same value produce the same characters.
 */
export function formatReportNumber(value: number | undefined): string {
  if (value === undefined) return UNMEASURED_TEXT;
  return Number.isInteger(value) ? String(value) : value.toFixed(REPORT_DECIMAL_PLACES);
}

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

/** Where the headline verdict came from. A report without a baseline has no comparison to draw one from. */
export const REPORT_VERDICT_BASES = ["comparison", "no-baseline"] as const;

export type ReportVerdictBasis = (typeof REPORT_VERDICT_BASES)[number];

/** Reason code a report states for itself when there was nothing to compare against. */
export const NO_BASELINE_REASON = "no-baseline-comparison";

/** One adapter version, as a list entry so the order is the report's rather than an object's. */
export interface ReportModeAdapterVersion {
  readonly mode: ExecutionMode;
  /** Empty when the run recorded none; an empty version is reported as a limitation, never filled in. */
  readonly version: string;
}

/** The BENCH-8 hashes a run is attributed by. */
export interface ReportIdentity {
  readonly suiteHash: string;
  readonly configHash: string;
  readonly policyHash: string;
  readonly agCommit: string;
  readonly modeAdapterVersions: readonly ReportModeAdapterVersion[];
}

/** One side of the report: what was measured, on what, and how much of it. */
export interface ReportRunFacts {
  readonly identity: ReportIdentity;
  readonly environment: BenchmarkEnvironment;
  readonly sampleCount: number;
  /** Modes this side actually recorded samples for, in {@link EXECUTION_MODES} order. */
  readonly modes: readonly ExecutionMode[];
}

export type ReportMetricKind = "rate" | "cost";

/**
 * One metric, both sides and the movement between them.
 *
 * `absoluteDelta` and `relativeDelta` are present only when both sides were
 * measured, and `relativeDelta` additionally only when the baseline is non-zero:
 * BENCH-7's zero-denominator rule applies to a delta exactly as it applies to
 * the metric it is computed from.
 */
export interface ReportMetricRow {
  /** `acceptedRate`, or `perVerifiedAcceptedChange.billableTokens` for a cost. */
  readonly metric: string;
  readonly kind: ReportMetricKind;
  readonly baseline: number | undefined;
  readonly current: number | undefined;
  readonly absoluteDelta: number | undefined;
  readonly relativeDelta: number | undefined;
}

export interface ReportModeSection {
  readonly mode: ExecutionMode;
  readonly baselineSampleCount: number | undefined;
  readonly currentSampleCount: number | undefined;
  readonly metrics: readonly ReportMetricRow[];
  /** BENCH-3: what this mode cannot hold equal to the others, declared before it ran. */
  readonly differences: readonly ModeDifference[];
}

export interface ReportScenarioSection {
  readonly scenarioId: string;
  readonly mode: ExecutionMode;
  readonly verdict: ComparisonVerdict;
  readonly reasons: readonly string[];
  readonly baseline: DistributionStatistics;
  readonly current: DistributionStatistics;
}

/** The command that regenerates this report, and the hashes it can be checked against. */
export interface ReportReproduction {
  readonly arguments: readonly string[];
  /** The arguments as one shell line, redacted. Never parsed; shown so a reader can copy it. */
  readonly command: string;
}

export interface BenchmarkReportModel {
  readonly schemaVersion: number;
  readonly verdict: ComparisonVerdict;
  readonly verdictBasis: ReportVerdictBasis;
  readonly reasons: readonly string[];
  readonly current: ReportRunFacts;
  readonly baseline: ReportRunFacts | undefined;
  readonly modes: readonly ReportModeSection[];
  readonly scenarios: readonly ReportScenarioSection[];
  /**
   * The compression cohort, when the caller summarised one (task 0029). Absent
   * when it did not: a report that never looked at compression says nothing
   * about it, which is not the same statement as a cohort that measured nothing.
   */
  readonly compression: ReportCompressionSection | undefined;
  /** What this report cannot claim. Never empty: the rounding note applies to every report. */
  readonly limitations: readonly string[];
  readonly reproduction: ReportReproduction;
}

/** Everything a report is built from. The baseline document is optional; without it there is no comparison. */
export interface BenchmarkReportInput {
  readonly summary: BenchmarkRunSummary;
  readonly baseline?: BenchmarkBaseline;
  readonly comparison?: BenchmarkComparison;
  /**
   * Caveats the caller already knows about — a suite that did not validate, a
   * ledger read under a flag. They stay in front of the report's own, in the
   * order given, so a reader meets the caller's context before the analysis.
   */
  readonly limitations?: readonly string[];
  /** Appended after the derived arguments, for a caller that reproduced the run differently. */
  readonly reproductionArguments?: readonly string[];
  /**
   * The compression cohort as `summarizeCompressionCohort` folded it. Supplied
   * rather than computed here, so the report keeps rendering a value it was
   * handed instead of deciding a verdict of its own (BENCH-11).
   */
  readonly compression?: ReportCompressionSection;
}

// ---------------------------------------------------------------------------
// Identity and run facts
// ---------------------------------------------------------------------------

/**
 * A baseline is named by what it is, never by where it was read from: the flag
 * value is a placeholder so a committed report cannot disclose a filesystem path.
 */
export const REPRODUCTION_BASELINE_PLACEHOLDER = "<baseline-document>";

// Binaro vardas yra reprodukcijos komandos DALIS: ataskaita, kviečianti `ag`, siunčia skaitytoją
// prie komandos, kurios šiame produkte nėra. Atskiri masyvo elementai, o ne viena eilutė —
// būtent todėl VQ-703 tekstinis pervadinimas šios vietos nepasiekė ir ją pagavo testas.
const REPRODUCTION_BASE_ARGUMENTS = ["verqestra", "benchmark", "report"] as const;

/** Identity fields whose absence makes a run unattributable (BENCH-8). */
const REQUIRED_IDENTITY_FIELDS = ["suiteHash", "configHash", "policyHash", "agCommit"] as const;

function toReportIdentity(identity: BenchmarkIdentity): ReportIdentity {
  return {
    suiteHash: identity.suiteHash,
    configHash: identity.configHash,
    policyHash: identity.policyHash,
    agCommit: identity.agCommit,
    // Declared mode order rather than key order: a record's keys are an accident
    // of how it was built, and the report is compared line by line.
    modeAdapterVersions: EXECUTION_MODES.map((mode) => ({
      mode,
      version: identity.modeAdapterVersions[mode] ?? "",
    })),
  };
}

function metricsOf(aggregates: readonly ModeMetrics[], mode: ExecutionMode): BenchmarkMetrics | undefined {
  return aggregates.find((entry) => entry.mode === mode)?.metrics;
}

function modesWithSamples(aggregates: readonly ModeMetrics[]): readonly ExecutionMode[] {
  return EXECUTION_MODES.filter((mode) => metricsOf(aggregates, mode) !== undefined);
}

function toRunFacts(
  identity: BenchmarkIdentity,
  environment: BenchmarkEnvironment,
  aggregates: readonly ModeMetrics[],
  sampleCount: number,
): ReportRunFacts {
  return {
    identity: toReportIdentity(identity),
    environment,
    sampleCount,
    modes: modesWithSamples(aggregates),
  };
}

// ---------------------------------------------------------------------------
// Metric rows
// ---------------------------------------------------------------------------

function costOf(metrics: BenchmarkMetrics, basis: CostBasisKey): CostMetrics {
  return metrics[basis];
}

interface MetricSides {
  readonly baseline: number | undefined;
  readonly current: number | undefined;
}

/**
 * The movement between two sides.
 *
 * Both deltas are absent when either side was not measured — subtracting from an
 * unmeasured value produces a number, and that number would be read as a change
 * that was observed. The relative delta is additionally absent on a zero
 * baseline, which is the same rule `domain/comparison/scenario-comparison.ts`
 * applies before it refuses to call an unstatable change an increase.
 *
 * Exported so the compression section builds its rows here rather than beside
 * this file: a second implementation of "what moved" would eventually round or
 * refuse differently, and the two sets of rows sit in one document.
 */
export function toMetricRow(
  metric: string,
  kind: ReportMetricKind,
  sides: MetricSides,
): ReportMetricRow {
  const baseline = canonicalOptionalNumber(sides.baseline);
  const current = canonicalOptionalNumber(sides.current);
  if (baseline === undefined || current === undefined) {
    return { metric, kind, baseline, current, absoluteDelta: undefined, relativeDelta: undefined };
  }
  return {
    metric,
    kind,
    baseline,
    current,
    absoluteDelta: canonicalReportNumber(current - baseline),
    relativeDelta:
      baseline === 0 ? undefined : canonicalReportNumber((current - baseline) / Math.abs(baseline)),
  };
}

function rateRow(
  key: RateMetricKey,
  baseline: BenchmarkMetrics | undefined,
  current: BenchmarkMetrics | undefined,
): ReportMetricRow {
  return toMetricRow(key, "rate", { baseline: baseline?.[key], current: current?.[key] });
}

function costRow(
  basis: CostBasisKey,
  key: CostMetricKey,
  baseline: BenchmarkMetrics | undefined,
  current: BenchmarkMetrics | undefined,
): ReportMetricRow {
  return toMetricRow(`${basis}.${key}`, "cost", {
    baseline: baseline === undefined ? undefined : costOf(baseline, basis)[key],
    current: current === undefined ? undefined : costOf(current, basis)[key],
  });
}

function metricRows(
  baseline: BenchmarkMetrics | undefined,
  current: BenchmarkMetrics | undefined,
): readonly ReportMetricRow[] {
  return [
    ...RATE_METRIC_KEYS.map((key) => rateRow(key, baseline, current)),
    ...COST_BASIS_KEYS.flatMap((basis) =>
      COST_METRIC_KEYS.map((key) => costRow(basis, key, baseline, current)),
    ),
  ];
}

function modeSections(
  baselineAggregates: readonly ModeMetrics[],
  currentAggregates: readonly ModeMetrics[],
): readonly ReportModeSection[] {
  return EXECUTION_MODES.map((mode) => ({
    mode,
    baseline: metricsOf(baselineAggregates, mode),
    current: metricsOf(currentAggregates, mode),
  }))
    // A mode neither run recorded is omitted rather than shown as an empty row:
    // a run configuration may declare a subset of the modes, and a row of `n/a`
    // against `n/a` states nothing the absence does not already state.
    .filter((entry) => entry.baseline !== undefined || entry.current !== undefined)
    .map((entry) => ({
      mode: entry.mode,
      baselineSampleCount: entry.baseline?.sampleCount,
      currentSampleCount: entry.current?.sampleCount,
      metrics: metricRows(entry.baseline, entry.current),
      differences: MODE_EXECUTION_PROFILES[entry.mode].differences,
    }));
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

function canonicalStatistics(statistics: DistributionStatistics): DistributionStatistics {
  return {
    count: statistics.count,
    median: canonicalReportNumber(statistics.median),
    mean: canonicalReportNumber(statistics.mean),
    min: canonicalReportNumber(statistics.min),
    max: canonicalReportNumber(statistics.max),
    standardDeviation: canonicalReportNumber(statistics.standardDeviation),
    successCount: statistics.successCount,
  };
}

function scenarioSections(comparison: BenchmarkComparison | undefined): readonly ReportScenarioSection[] {
  // Order is the comparison's, which walks the suite's declared scenarios and
  // then `EXECUTION_MODES`. Re-sorting here would replace a meaningful order with
  // an alphabetical one and would still have to be stable, so it buys nothing.
  return (comparison?.scenarios ?? []).map((scenario) => ({
    scenarioId: scenario.scenarioId,
    mode: scenario.mode,
    verdict: scenario.verdict,
    reasons: scenario.reasons,
    baseline: canonicalStatistics(scenario.baseline),
    current: canonicalStatistics(scenario.current),
  }));
}

// ---------------------------------------------------------------------------
// Limitations
// ---------------------------------------------------------------------------

function describeIdentityGaps(side: "current run" | "baseline", identity: ReportIdentity): readonly string[] {
  const gaps: string[] = [];
  for (const field of REQUIRED_IDENTITY_FIELDS) {
    if (identity[field] === "") {
      gaps.push(
        `the ${side} records no ${field}, so its numbers cannot be attributed to a measured ` +
          "configuration and BENCH-8 does not permit them to be compared as if they could",
      );
    }
  }
  for (const entry of identity.modeAdapterVersions) {
    if (entry.version === "") {
      gaps.push(
        `the ${side} records no adapter version for mode "${entry.mode}", and an adapter change ` +
          "alone can move every number in this report",
      );
    }
  }
  return gaps;
}

function describeEnvironmentDifference(
  baseline: BenchmarkEnvironment,
  current: BenchmarkEnvironment,
): readonly string[] {
  const describe = (environment: BenchmarkEnvironment): string =>
    `${environment.platform}/${environment.arch}, node ${environment.nodeVersion}, ${environment.cpuCount} core(s)`;
  const baselineText = describe(baseline);
  const currentText = describe(current);
  if (baselineText === currentText) return [];
  return [
    `the baseline was measured on ${baselineText} and the current run on ${currentText}; ` +
      "a duration measured on one host is not a duration measured on the other",
  ];
}

function describeInconclusiveSamples(
  side: "current run" | "baseline",
  aggregates: readonly ModeMetrics[],
): readonly string[] {
  return EXECUTION_MODES.flatMap((mode) => {
    const metrics = metricsOf(aggregates, mode);
    if (metrics === undefined || metrics.inconclusiveCount === 0) return [];
    return [
      `${side}, mode "${mode}": ${metrics.inconclusiveCount} of ${metrics.sampleCount} sample(s) were ` +
        "inconclusive and entered no rate and no cost total, so the reported cost is a lower bound",
    ];
  });
}

/**
 * Everything the report cannot claim, in a fixed order: what the comparison
 * already disclosed, then what the report layer itself can see.
 *
 * The rounding note is unconditional. Every number here has been through
 * {@link canonicalReportNumber}, and a reader comparing a report against the
 * stored samples has to know that the two are allowed to differ in the last
 * decimal without either being wrong.
 */
function limitationsOf(
  input: BenchmarkReportInput,
  current: ReportRunFacts,
  baseline: ReportRunFacts | undefined,
): readonly string[] {
  const limitations: string[] = [
    ...(input.comparison?.limitations ?? []),
    ...(input.limitations ?? []),
  ];

  if (input.comparison === undefined) {
    limitations.push(
      "no baseline comparison was supplied, so this report states the current run only and its " +
        "verdict is inconclusive by construction rather than by measurement",
    );
  }

  limitations.push(...describeIdentityGaps("current run", current.identity));
  if (baseline !== undefined) {
    limitations.push(...describeIdentityGaps("baseline", baseline.identity));
    limitations.push(...describeEnvironmentDifference(baseline.environment, current.environment));
  }

  limitations.push(...describeInconclusiveSamples("current run", input.summary.aggregates));
  if (input.baseline !== undefined) {
    limitations.push(...describeInconclusiveSamples("baseline", input.baseline.aggregates));
  }

  limitations.push(
    `every number in this report is rounded to ${REPORT_DECIMAL_PLACES} decimal place(s); the ` +
      "unrounded values are the stored samples and the comparison this report was rendered from",
  );
  return limitations;
}

// ---------------------------------------------------------------------------
// Reproduction
// ---------------------------------------------------------------------------

/**
 * The command that regenerates this report.
 *
 * Format-independent on purpose: the model is shared by both renderings, so a
 * `--format` argument here would be the one field in which the JSON and the
 * Markdown report legitimately disagreed — and the one a reader would use to
 * decide they cannot be trusted to agree elsewhere.
 */
function reproductionOf(input: BenchmarkReportInput): ReportReproduction {
  const args = [
    ...REPRODUCTION_BASE_ARGUMENTS,
    ...(input.comparison === undefined ? [] : ["--baseline", REPRODUCTION_BASELINE_PLACEHOLDER]),
    ...(input.reproductionArguments ?? []),
  ].map((argument) => redactSecrets(argument));
  return { arguments: args, command: args.join(" ") };
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

/**
 * The BENCH-7 aggregate of a set of stored samples, as a run summary.
 *
 * Exposed for the delivery layer, which holds the samples and the identity but
 * may not import the domain fold that turns them into metrics. The aggregates
 * are computed here once and are the report's only source of a rate — the report
 * never recomputes a number it was handed (BENCH-11).
 */
export function summarizeStoredSamples(input: {
  readonly identity: BenchmarkIdentity;
  readonly environment: BenchmarkEnvironment;
  readonly samples: readonly BenchmarkSample[];
}): BenchmarkRunSummary {
  return {
    identity: input.identity,
    environment: input.environment,
    samples: input.samples,
    aggregates: toModeMetrics(aggregateSamplesByMode(input.samples)),
  };
}

/**
 * The report, as one deterministic value.
 *
 * The verdict is the comparison's and is never recomputed here; without a
 * comparison it is `inconclusive`, which is what BENCH-9 requires of an answer
 * the evidence does not support rather than a `stable` nobody measured.
 */
export function buildBenchmarkReportModel(input: BenchmarkReportInput): BenchmarkReportModel {
  const currentFacts = toRunFacts(
    input.summary.identity,
    input.summary.environment,
    input.summary.aggregates,
    input.summary.samples.length,
  );
  const baselineFacts =
    input.baseline === undefined
      ? undefined
      : toRunFacts(
          input.baseline.identity,
          input.baseline.environment,
          input.baseline.aggregates,
          input.baseline.samples.length,
        );

  return {
    schemaVersion: BENCHMARK_REPORT_SCHEMA_VERSION,
    verdict: input.comparison?.verdict ?? "inconclusive",
    verdictBasis: input.comparison === undefined ? "no-baseline" : "comparison",
    reasons: input.comparison?.reasons ?? [NO_BASELINE_REASON],
    current: currentFacts,
    baseline: baselineFacts,
    modes: modeSections(input.baseline?.aggregates ?? [], input.summary.aggregates),
    scenarios: scenarioSections(input.comparison),
    compression: input.compression,
    limitations: limitationsOf(input, currentFacts, baselineFacts),
    reproduction: reproductionOf(input),
  };
}
