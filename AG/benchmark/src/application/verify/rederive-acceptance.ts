import { decideAcceptance, type ExecutedCheck } from "../../domain/verification/acceptance.js";
import type { BenchmarkSample } from "../../domain/result.js";
import type { BenchmarkScenario } from "../../domain/scenario.js";

/**
 * Re-deriving acceptance from a stored sample (BENCH-6, `verqestra benchmark verify`).
 *
 * The question this answers is narrow and worth stating exactly: *given the
 * evidence this sample recorded, does the current acceptance rule reach the
 * verdict the sample carries?* Nothing is executed — no agent, no check, no
 * checkout — so what it detects is a change in the rules or a sample whose
 * verdict does not follow from its own evidence. It cannot detect a check whose
 * result was wrong when it was recorded; that needs the run to happen again.
 *
 * ## Why the stored gate results are dropped
 *
 * A stored sample carries both the scenario's declared checks and the verifier's
 * own gates, and {@link decideAcceptance} produces the gates itself. Feeding them
 * back in would report a result for a check the scenario does not declare, which
 * the rules correctly treat as evidence that the verifier and the scenario
 * disagree about what was run. So only the declared checks are replayed, and the
 * gates are re-evaluated from the recorded scope.
 *
 * ## A sample the suite cannot explain
 *
 * A stored sample naming a scenario the current suite does not declare cannot be
 * re-derived at all: the allowed paths, the expected outcome and the declared
 * checks it would be judged against no longer exist. Such a sample is returned
 * `inconclusive` with `evidence-missing` rather than passed through unchanged —
 * a re-derivation that silently re-published the old verdict would be reporting
 * the previous suite's judgement as this one's.
 */

/** The reason code an unexplainable sample carries; `evidence-missing` is already the "could not look" code. */
const UNKNOWN_SCENARIO_REASON = "evidence-missing";

function declaredCheckResults(
  scenario: BenchmarkScenario,
  sample: BenchmarkSample,
): readonly ExecutedCheck[] {
  const declared = new Set(scenario.checks.map((check) => check.id));
  return sample.checks
    .filter((check) => declared.has(check.id))
    .map((check) => ({
      checkId: check.id,
      status: check.status,
      durationMs: check.durationMs,
      // The stored record keeps the status and the duration, not the output the
      // check printed; an invented problem string would read as evidence.
      problem: "",
    }));
}

/**
 * The sample as the current rules judge it. Every field except `checks` and
 * `acceptance` is carried through untouched: re-derivation re-judges a
 * measurement, it does not restate one.
 */
export function rederiveSampleAcceptance(
  sample: BenchmarkSample,
  scenario: BenchmarkScenario | undefined,
): BenchmarkSample {
  if (scenario === undefined) {
    return {
      ...sample,
      acceptance: {
        verdict: "inconclusive",
        reasons: [UNKNOWN_SCENARIO_REASON],
        agentClaimedDone: sample.acceptance.agentClaimedDone,
      },
    };
  }

  const outcome = decideAcceptance({
    scenario,
    changedFiles: sample.workspace.changedFiles,
    executedChecks: declaredCheckResults(scenario, sample),
    agentClaimedDone: sample.acceptance.agentClaimedDone,
    // The stored record exists, so the evidence arrived; whether it is *enough*
    // is what the rules below decide.
    evidenceProblem: "",
  });

  return {
    ...sample,
    checks: outcome.checks,
    workspace: { ...sample.workspace, outOfScopeFiles: outcome.outOfScopeFiles },
    acceptance: outcome.decision,
  };
}

/** Re-derives every sample against the suite it names. */
export function rederiveAcceptance(
  samples: readonly BenchmarkSample[],
  scenarios: readonly BenchmarkScenario[],
): readonly BenchmarkSample[] {
  const declared = new Map(scenarios.map((scenario) => [scenario.id, scenario]));
  return samples.map((sample) => rederiveSampleAcceptance(sample, declared.get(sample.scenarioId)));
}
