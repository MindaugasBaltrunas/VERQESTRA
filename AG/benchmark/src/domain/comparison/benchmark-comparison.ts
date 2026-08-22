import type { BenchmarkSample, ExecutionMode } from "../result.js";
import { EXECUTION_MODES } from "../result.js";
import type { BenchmarkScenario } from "../scenario.js";
import {
  DEFAULT_SCENARIO_MEASURE,
  type ScenarioMeasureKey,
} from "../statistics/scenario-observations.js";
import type { BenchmarkComparison, ComparisonVerdict, ScenarioComparison } from "../verdict.js";
import { compareScenario, type ScenarioComparisonEvidence } from "./scenario-comparison.js";
import { strongestVerdict } from "./verdict-priority.js";

/**
 * The benchmark-wide verdict (BENCH-9).
 *
 * Pairs a baseline run with a current one scenario by scenario and mode by mode,
 * and rolls the per-scenario verdicts up into the single authoritative
 * {@link BenchmarkComparison} a CLI, a report and the UI all publish (BENCH-10,
 * BENCH-11).
 *
 * ## Deterministic by construction
 *
 * Scenarios are walked in the order the suite declares them and modes in the
 * order {@link EXECUTION_MODES} declares them, never in the order samples
 * arrived, so two comparisons of the same two runs produce byte-identical
 * output — the same rule `aggregateSamplesByMode` follows, and the reason a
 * report may be diffed at all.
 *
 * ## Fail-closed rollup
 *
 * The verdict is the strongest one seen, under the single ranking
 * `verdict-priority.ts` defines for the whole feature.
 *
 * Anything that leaves the comparison unable to speak — a scenario present on
 * one side only, a pair too thin to summarise, a scenario no run executed at
 * all, a sample naming a scenario or a mode the suite does not declare —
 * becomes a limitation and contributes an `inconclusive` to the rollup rather
 * than being dropped (BENCH-5).
 *
 * ## What is reported without changing the verdict
 *
 * A compared pair still carries evidence its statistics do not show: samples the
 * verifier could not decide and therefore excluded, and violations that were
 * already present in the baseline. Neither moves the verdict — the first is
 * excluded by design, the second is a standing problem this comparison did not
 * introduce — but both become limitations, because a `stable` published with
 * seven of ten samples silently discarded, or with a security failure on both
 * sides, tells the reader the opposite of what happened (BENCH-5, BENCH-10).
 */

/** Rollup reason codes, added to the codes the compared scenarios produced. */
export const BENCHMARK_COMPARISON_ROLLUP_REASONS = [
  "no-comparable-scenario",
  "scenario-pair-incomplete",
  "scenario-not-run",
  "unknown-scenario-samples",
  "unknown-mode-samples",
] as const;

export type BenchmarkComparisonRollupReason =
  (typeof BENCHMARK_COMPARISON_ROLLUP_REASONS)[number];

export interface BenchmarkComparisonInput {
  /** The suite being compared under. Sole authority on which scenarios exist, on their order and on determinism. */
  readonly scenarios: readonly BenchmarkScenario[];
  readonly baselineSamples: readonly BenchmarkSample[];
  readonly currentSamples: readonly BenchmarkSample[];
  readonly measure?: ScenarioMeasureKey;
  /** Advisory differences the comparability gate passed through; they stay in front of ours. */
  readonly limitations?: readonly string[];
}

function samplesOf(
  samples: readonly BenchmarkSample[],
  scenarioId: string,
  mode: ExecutionMode,
): readonly BenchmarkSample[] {
  return samples.filter((sample) => sample.scenarioId === scenarioId && sample.mode === mode);
}

/** Values the samples carry that `declared` does not contain, deduplicated and ordered so the report is stable. */
function undeclaredValues(
  declared: ReadonlySet<string>,
  read: (sample: BenchmarkSample) => string,
  ...populations: readonly (readonly BenchmarkSample[])[]
): readonly string[] {
  const undeclared = new Set(
    populations
      .flat()
      .map(read)
      .filter((value) => !declared.has(value)),
  );
  return [...undeclared].sort();
}

/** How a pair is named in a limitation, so a reader can find it among the scenarios. */
function label(scenarioId: string, mode: ExecutionMode): string {
  return `${scenarioId} (${mode})`;
}

/**
 * What a compared pair has to disclose beside its statistics.
 *
 * Excluded samples first, because they qualify every number in the pair; then a
 * violation standing on both sides, which the verdict rules deliberately do not
 * treat as new and which would otherwise appear nowhere at all.
 */
function evidenceLimitations(
  scenarioId: string,
  mode: ExecutionMode,
  evidence: ScenarioComparisonEvidence,
): readonly string[] {
  const { baseline, current } = evidence;
  const limitations: string[] = [];
  if (baseline.inconclusiveCount > 0 || current.inconclusiveCount > 0) {
    limitations.push(
      `${label(scenarioId, mode)}: ${baseline.inconclusiveCount} of ${baseline.sampleCount} baseline ` +
        `and ${current.inconclusiveCount} of ${current.sampleCount} current sample(s) were inconclusive ` +
        "(inconclusiveCount) and entered neither distribution",
    );
  }
  if (baseline.securityFailureCount > 0 && current.securityFailureCount > 0) {
    limitations.push(
      `${label(scenarioId, mode)}: a failed security check is present on both sides ` +
        `(securityFailureCount ${baseline.securityFailureCount} baseline, ${current.securityFailureCount} current); ` +
        "it is a standing violation rather than a new one, so it did not decide the verdict",
    );
  }
  if (baseline.outOfScopeCount > 0 && current.outOfScopeCount > 0) {
    limitations.push(
      `${label(scenarioId, mode)}: changes outside the declared scope are present on both sides ` +
        `(outOfScopeCount ${baseline.outOfScopeCount} baseline, ${current.outOfScopeCount} current); ` +
        "it is a standing violation rather than a new one, so it did not decide the verdict",
    );
  }
  return limitations;
}

/**
 * Compares two runs of the same suite.
 *
 * The caller is expected to have passed the BENCH-8 comparability gate first:
 * this function judges the numbers, not whether the two runs were entitled to be
 * put side by side, and it forwards that gate's limitations untouched.
 */
export function compareBenchmark(input: BenchmarkComparisonInput): BenchmarkComparison {
  const measure = input.measure ?? DEFAULT_SCENARIO_MEASURE;
  const comparisons: ScenarioComparison[] = [];
  const verdicts: ComparisonVerdict[] = [];
  const reasons: string[] = [];
  const limitations: string[] = [...(input.limitations ?? [])];

  for (const scenario of input.scenarios) {
    let pairs = 0;
    for (const mode of EXECUTION_MODES) {
      const baselineSamples = samplesOf(input.baselineSamples, scenario.id, mode);
      const currentSamples = samplesOf(input.currentSamples, scenario.id, mode);
      // Neither side ran this scenario in this mode: a run configuration may
      // declare a subset of the modes, so a mode absent from both runs is not a
      // gap. Only a half-present pair is. A scenario absent from *every* mode is
      // caught after the loop — that one is an incomplete run, not a choice.
      if (baselineSamples.length === 0 && currentSamples.length === 0) continue;
      pairs += 1;

      const outcome = compareScenario({
        scenarioId: scenario.id,
        mode,
        deterministic: scenario.deterministic,
        baselineSamples,
        currentSamples,
        measure,
      });
      if (!outcome.ok) {
        verdicts.push("inconclusive");
        reasons.push("scenario-pair-incomplete");
        limitations.push(`${outcome.detail} (${outcome.reason})`);
        continue;
      }
      comparisons.push(outcome.comparison);
      verdicts.push(outcome.comparison.verdict);
      reasons.push(...outcome.comparison.reasons);
      limitations.push(...evidenceLimitations(scenario.id, mode, outcome.evidence));
    }

    if (pairs === 0) {
      // The suite declares this scenario and neither run has a single sample of
      // it in any mode. The runs are incomplete against the suite they claim to
      // measure, and a verdict drawn from the scenarios that did run would be
      // published as if the missing one had nothing to say.
      verdicts.push("inconclusive");
      reasons.push("scenario-not-run");
      limitations.push(
        `scenario "${scenario.id}" has no sample in any mode on either side, ` +
          "so the suite was not fully executed and nothing about it was compared",
      );
    }
  }

  const declaredScenarios = new Set(input.scenarios.map((scenario) => scenario.id));
  for (const scenarioId of undeclaredValues(
    declaredScenarios,
    (sample) => sample.scenarioId,
    input.baselineSamples,
    input.currentSamples,
  )) {
    // Samples the suite cannot explain mean the two populations are not the ones
    // the comparison claims to be about, so they are reported rather than
    // silently ignored — and they cost the run its right to a clean verdict.
    verdicts.push("inconclusive");
    reasons.push("unknown-scenario-samples");
    limitations.push(
      `samples reference scenario "${scenarioId}", which the suite does not declare; ` +
        "they were excluded from every comparison",
    );
  }

  const declaredModes: ReadonlySet<string> = new Set(EXECUTION_MODES);
  for (const mode of undeclaredValues(
    declaredModes,
    (sample) => sample.mode,
    input.baselineSamples,
    input.currentSamples,
  )) {
    // Unreachable for stored samples, which are validated against
    // `EXECUTION_MODES`, and reachable for records only ever held in memory.
    // Handled like an unknown scenario for the same reason: a sample the walk
    // above could never visit is cost that was spent and never compared, and
    // dropping it without a word is the one thing BENCH-5 forbids.
    verdicts.push("inconclusive");
    reasons.push("unknown-mode-samples");
    limitations.push(
      `samples were recorded under execution mode "${mode}", which is not one of the ` +
        "declared modes; they were excluded from every comparison",
    );
  }

  if (comparisons.length === 0) {
    verdicts.push("inconclusive");
    reasons.push("no-comparable-scenario");
    limitations.push("no scenario had statistics on both sides, so nothing was compared");
  }

  return {
    verdict: strongestVerdict(verdicts),
    // Deduplicated and sorted: codes are what a report groups on, and a rollup
    // that repeated a code once per scenario would report the size of the suite
    // instead of the reasons for the verdict.
    reasons: [...new Set(reasons)].sort(),
    scenarios: comparisons,
    limitations,
  };
}
