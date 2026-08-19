// Kompresijos features priklausomybių taisyklė: neveikianti privaloma pora išjungia
// priklausomą feature FAIL-CLOSED į kontrolinę ranką (ne į klaidą). AG_loop'e ši taisyklė
// gyveno application sluoksnyje; VERQESTRA ji yra grynas domain sprendimas (WBR
// patikslinimas — grynos taisyklės kėlimas žemyn yra leidžiama kryptis). Behaviour
// etalon: AG_loop application/context-pack/effective-compression-policy.ts grynoji pusė
// (pinned by compression-policy-verdicts.json notice tekstai).

import type { ContextCompressionConfig, ContextCompressionFeature, ContextCompressionFeatureValue } from "./features.js";
import { arrestedContextCompressionFeatures, isContextCompressionFeatureArrested, type ContextCompressionArrestView } from "./arrest.js";

/** One `feature -> requires` edge. The table is the extension point; the code is generic. */
export type CompressionFeatureDependency = {
  feature: ContextCompressionFeature;
  requires: ContextCompressionFeature;
  /** Why the dependency is structural — quoted in comments, never in a decision. */
  why: string;
};

/**
 * Declared dependencies, in resolution order (order is load-bearing for a future chain:
 * each entry resolves against features already narrowed by the entries above it).
 */
export const COMPRESSION_FEATURE_DEPENDENCIES: readonly CompressionFeatureDependency[] = [
  {
    feature: "compact_dsl",
    requires: "worker_task_ir",
    why: "the compact DSL renders a WorkerTaskIR; with no IR compiled there is nothing to render",
  },
];

/** The state an unsatisfied dependency puts a feature in — never a silent `false`. */
export const COMPRESSION_DEPENDENCY_INACTIVE = "inactive_due_to_dependency";

/** Why the required feature is not active. Both read as `false` in the effective config. */
export type CompressionDependencyCause = "disabled" | "arrested";

/**
 * One feature switched off because its dependency is not active — the provenance record.
 * `declared` yra reikšmė, kurios operatoriaus konfigas prašė ir kurios šis bėgimas
 * NEvykdys: „off because nobody turned it on" ir „off because the pair is broken" yra
 * skirtingos operatoriaus problemos.
 */
export type CompressionDependencyNotice = {
  feature: ContextCompressionFeature;
  requires: ContextCompressionFeature;
  declared: ContextCompressionFeatureValue;
  cause: CompressionDependencyCause;
  status: typeof COMPRESSION_DEPENDENCY_INACTIVE;
};

/** The loud operator line. The sentence up to the required feature name is a fixed contract. */
export function describeCompressionDependencyNotice(notice: CompressionDependencyNotice): string {
  return (
    `COMPRESSION CONFIG DEPENDENCY: ${notice.feature} inactive — requires ${notice.requires} ` +
    `(declared ${notice.feature}=${JSON.stringify(notice.declared)}, ${notice.requires} is ${notice.cause})`
  );
}

/**
 * Applies the dependency table to an already arrest-narrowed config. Pure and fail-CLOSED
 * into the control arm: an unsatisfied dependency forces the dependent feature to `false`.
 * A dependency satisfied by `"canary"` counts as satisfied (kohorta yra TASK'O savybė,
 * abu flag'ai matuojami ant tos pačios kohortos). Jau išjungta feature nieko neskelbia —
 * būtent tai neleidžia areštui, nukirtusiam ABI features, rašyti dar ir dependency eilutės.
 */
export function resolveCompressionFeatureDependencies(
  config: ContextCompressionConfig,
  arrestView?: ContextCompressionArrestView,
): { config: ContextCompressionConfig; notices: CompressionDependencyNotice[] } {
  const notices: CompressionDependencyNotice[] = [];
  const features = { ...config.features };

  for (const dependency of COMPRESSION_FEATURE_DEPENDENCIES) {
    const declared = features[dependency.feature];
    if (declared === false) continue;
    if (features[dependency.requires] !== false) continue;

    features[dependency.feature] = false;
    notices.push({
      feature: dependency.feature,
      requires: dependency.requires,
      declared,
      cause:
        arrestView !== undefined && isContextCompressionFeatureArrested(arrestView, dependency.requires)
          ? "arrested"
          : "disabled",
      status: COMPRESSION_DEPENDENCY_INACTIVE,
    });
  }

  return notices.length === 0 ? { config, notices } : { config: { ...config, features }, notices };
}

/**
 * Everything in an arrest view that can change the EFFECTIVE config, as one string;
 * `undefined` = niekas neareštuota (view konfigo nesiaurina). Cache raktų projekcija.
 */
export function contextCompressionArrestDecision(view: ContextCompressionArrestView): string | undefined {
  const arrested = arrestedContextCompressionFeatures(view);
  return !view.unreadable && arrested.length === 0 ? undefined : JSON.stringify({ unreadable: view.unreadable, arrested });
}
