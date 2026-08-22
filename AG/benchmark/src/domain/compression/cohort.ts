import { freezeDeep } from "../baseline/manifest.js";
import { defineCompressionVariant, type CompressionVariant } from "./variant.js";

/**
 * The frozen compression cohort (task 0029).
 *
 * Nine variants: a baseline, one per compression path the rollout landed, the
 * two combinations that are configurations rather than flags, and the full
 * combination. Frozen because a cohort chosen after the numbers are in is not a
 * measurement — a variant added because it looked promising, or dropped because
 * it did not, turns the report into a selection of the results its author liked.
 *
 * `compact-dsl` alone is expected to be close to a no-op on the prompt path: the
 * compiler is entered only under `worker_task_ir`, so the renderer choice has
 * nothing to render. That is a fact about the rollout, not a defect in the
 * cohort, and the report must present a null contribution as a measured null
 * rather than quietly drop the variant.
 *
 * `bash-digest-handler` is declarable but not executable from this package,
 * because the hook settings file it needs is outside the write set of the task
 * that introduced the cohort. Unexecuted means `not_measured` — never a number
 * borrowed from the shadow variant that *was* executable.
 */

/** The variant every other one is judged against: nothing enabled, nothing wired. */
export const BASELINE_VARIANT_ID = "baseline";

/** The full combination, the only variant whose result belongs to no single feature. */
export const ALL_FEATURES_VARIANT_ID = "all-features";

export const COMPRESSION_COHORT: readonly CompressionVariant[] = freezeDeep([
  defineCompressionVariant({ id: BASELINE_VARIANT_ID, features: [], hookProfile: "unwired" }),
  defineCompressionVariant({
    id: "worker-task-ir",
    features: ["worker_task_ir"],
    hookProfile: "unwired",
  }),
  defineCompressionVariant({ id: "compact-dsl", features: ["compact_dsl"], hookProfile: "unwired" }),
  defineCompressionVariant({
    id: "symbol-slices",
    features: ["symbol_slices"],
    hookProfile: "unwired",
  }),
  // The compiled prompt of task 0025: gated by `worker_task_ir`, rendered by
  // `compact_dsl`. A combination, which is why it is not a sixth flag.
  defineCompressionVariant({
    id: "compiled-prompt",
    features: ["worker_task_ir", "compact_dsl"],
    hookProfile: "unwired",
  }),
  defineCompressionVariant({
    id: "bash-digest-shadow",
    features: ["bash_output_digest"],
    hookProfile: "unwired",
  }),
  defineCompressionVariant({
    id: "bash-digest-handler",
    features: ["bash_output_digest"],
    hookProfile: "bash-digest-handler",
  }),
  defineCompressionVariant({
    id: "dispatch-tool-schema",
    features: ["dispatch_tool_schema"],
    hookProfile: "unwired",
  }),
  defineCompressionVariant({
    id: ALL_FEATURES_VARIANT_ID,
    features: [
      "worker_task_ir",
      "compact_dsl",
      "symbol_slices",
      "bash_output_digest",
      "dispatch_tool_schema",
    ],
    hookProfile: "bash-digest-handler",
  }),
]);

/**
 * Two cohort entries sharing an id or an identity would make every sample keyed
 * by that value attributable to either of them, so the cohort refuses to load.
 * Checked at module scope rather than in a test: a duplicate reaching a run
 * would silently split or merge a population.
 */
function assertCohortIsDistinct(): void {
  for (const key of ["id", "identity"] as const) {
    const seen = new Set<string>();
    for (const variant of COMPRESSION_COHORT) {
      if (seen.has(variant[key])) {
        throw new TypeError(
          `The compression cohort declares two variants with the same ${key} "${variant[key]}".`,
        );
      }
      seen.add(variant[key]);
    }
  }
}

assertCohortIsDistinct();

/** The declared variant with this id, or `undefined` — an unknown id is never invented into a variant. */
export function variantById(id: string): CompressionVariant | undefined {
  return COMPRESSION_COHORT.find((variant) => variant.id === id);
}

/**
 * The declared variant a stored identity belongs to. Identity rather than id is
 * what a sample is attributed by: an id is a label, and two runs whose flags
 * differ must not share a population because someone reused a name.
 */
export function variantByIdentity(identity: string): CompressionVariant | undefined {
  return COMPRESSION_COHORT.find((variant) => variant.identity === identity);
}

/** The baseline variant. Present by construction; the cohort would not load without it. */
export function baselineVariant(): CompressionVariant {
  const variant = variantById(BASELINE_VARIANT_ID);
  if (variant === undefined) {
    throw new TypeError("The compression cohort declares no baseline variant.");
  }
  return variant;
}
