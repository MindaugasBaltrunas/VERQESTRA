import { canonicalDigest } from "../../domain/baseline/canonical-json.js";
import { ACCEPTANCE_VERIFIER_VERSION } from "../../domain/baseline/manifest.js";
import { BENCHMARK_SAMPLE_SCHEMA_VERSION, EXECUTION_MODES } from "../../domain/result.js";
import { MODE_EXECUTION_PROFILES } from "../ports/execution-plan.js";
import { CHECK_TIMEOUT_MS_CEILING } from "../verify/independent-acceptance-verifier.js";

/**
 * The identity of the measurement policy a run executed under
 * (`BenchmarkIdentity.policyHash`, BENCH-8).
 *
 * The configuration hash says *what* was executed — which suite version, which
 * modes, how many repetitions, which model, which adapter versions. This digest
 * says *by which rules*: what each mode is allowed to hold unequal to the others
 * (BENCH-3), which version of the acceptance rules granted the verdicts
 * (BENCH-6), how long a single check may run before it is killed, and which
 * sample schema the records were written under. Every one of those can move
 * every number in a report without a scenario or a setting changing, and a
 * baseline compared across such a change would attribute the difference to AG.
 *
 * ## What it does not cover, and why that is not a gap
 *
 * It does not digest AG's own rule files — the supervisor instructions, the
 * agent chains, the hooks. Those are not inputs this package reads; they are
 * part of the tree under measurement, and the tree is identified by
 * `BenchmarkIdentity.agCommit`, which the comparability gate already refuses to
 * accept as empty. Hashing a copy of them here would state a second, weaker
 * claim about the same fact and would go stale the first time a rule file moved.
 */

/** Bumped when the projection below changes shape, so an old digest is visibly not a new one. */
const RUN_POLICY_PROJECTION_VERSION = 1;

/**
 * The exact value the policy digest is taken over.
 *
 * Projected field by field rather than digesting the profile objects as they
 * stand: a frozen constant is still an object this build happens to hold, and a
 * key added by a later version would silently re-identify every policy without
 * anybody deciding that it should.
 */
function projectRunPolicy(): Record<string, unknown> {
  return {
    projectionVersion: RUN_POLICY_PROJECTION_VERSION,
    verifierVersion: ACCEPTANCE_VERIFIER_VERSION,
    checkTimeoutMsCeiling: CHECK_TIMEOUT_MS_CEILING,
    sampleSchemaVersion: BENCHMARK_SAMPLE_SCHEMA_VERSION,
    modes: EXECUTION_MODES.map((mode) => {
      const profile = MODE_EXECUTION_PROFILES[mode];
      return {
        mode,
        usesModel: profile.usesModel,
        reachesNetwork: profile.reachesNetwork,
        // Sorted by code: the order differences are declared in is how the
        // report lists them, and presentation order is not policy.
        differences: [...profile.differences]
          .sort((left, right) => (left.code < right.code ? -1 : left.code > right.code ? 1 : 0))
          .map((difference) => ({
            aspect: difference.aspect,
            code: difference.code,
            detail: difference.detail,
          })),
      };
    }),
  };
}

/** `sha256:` followed by sixty-four hex characters, identical for identical policy. */
export function computeRunPolicyHash(): string {
  return canonicalDigest(projectRunPolicy());
}
