import { canonicalDigest } from "../baseline/canonical-json.js";
import { freezeDeep } from "../baseline/manifest.js";
import { IDENTIFIER_PATTERN } from "../validation.js";
import {
  CONTEXT_COMPRESSION_REGISTRY_VERSION,
  type CompressionFeature,
  type CompressionHookProfile,
} from "./features.js";

/**
 * A compression variant: which flags a run was given, and how the hook layer was
 * wired while it ran (task 0029).
 *
 * Compression is a second dimension beside `ExecutionMode`, never inside it. The
 * mode answers *who did the work*; a variant answers *how much context the work
 * was given*. Folding the two together would multiply `EXECUTION_MODES` by the
 * size of the cohort and break every consumer that enumerates it.
 *
 * ## Why the identity is a hash rather than the id
 *
 * The id is a label a human chose; the identity is what two runs are compared
 * on. It is the canonical digest of the registry version, the *sorted* feature
 * set and the hook profile, which gives three properties the comparison needs:
 *
 * - **Order-independence.** `{a, b}` and `{b, a}` are one variant, because a set
 *   of enabled flags has no order. Sorting lexicographically rather than by the
 *   registry's declaration order additionally means that reordering the registry
 *   — a purely cosmetic change — does not re-identify every past measurement.
 * - **The hook profile is inside the digest.** That is what makes
 *   `bash-digest-shadow` and `bash-digest-handler` two variants rather than one
 *   variant measured twice: they enable the same flag and behave differently.
 * - **The suite, the scenario and the model are outside it.** A variant has to
 *   stay recognisable across suites and across baselines; what a run was
 *   measured under is `configHash`'s job, and duplicating it here would make the
 *   same variant unrecognisable the moment a repetition count changed.
 */

export interface CompressionVariant {
  /** Lowercase kebab-case, so it can be stored on a sample and validated there. */
  readonly id: string;
  /** Sorted and deduplicated: the canonical spelling of the enabled flag set. */
  readonly features: readonly CompressionFeature[];
  readonly hookProfile: CompressionHookProfile;
  /** `sha256:` followed by sixty-four hex characters. */
  readonly identity: string;
}

/** The declaration a caller makes; the identity is computed, never supplied. */
export interface CompressionVariantDeclaration {
  readonly id: string;
  readonly features: readonly CompressionFeature[];
  readonly hookProfile: CompressionHookProfile;
}

/**
 * The canonical spelling of a feature set: sorted, without repeats.
 *
 * Exported because anything that hashes, stores or compares a feature list has
 * to use the same spelling; a second ordering somewhere would produce a second
 * identity for one variant.
 */
export function canonicalCompressionFeatures(
  features: readonly CompressionFeature[],
): readonly CompressionFeature[] {
  return [...new Set(features)].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

/**
 * The identity of a feature set under one hook profile.
 *
 * Total and pure: the same arguments always digest to the same sixty-four
 * characters, on any host and in any order.
 */
export function computeCompressionVariantIdentity(
  features: readonly CompressionFeature[],
  hookProfile: CompressionHookProfile,
): string {
  return canonicalDigest({
    registryVersion: CONTEXT_COMPRESSION_REGISTRY_VERSION,
    features: canonicalCompressionFeatures(features),
    hookProfile,
  });
}

/**
 * Builds a variant, sealing it against later edits.
 *
 * An id that could not be stored on a sample is refused here rather than at the
 * store: the cohort is declared at module load, so a bad id fails the build
 * instead of failing a run after the tokens have been spent.
 */
export function defineCompressionVariant(
  declaration: CompressionVariantDeclaration,
): CompressionVariant {
  if (!IDENTIFIER_PATTERN.test(declaration.id)) {
    throw new TypeError(
      `"${declaration.id}" is not a lowercase kebab-case compression variant id; ` +
        "a variant id is stored on every sample it produced and is validated there.",
    );
  }
  const features = canonicalCompressionFeatures(declaration.features);
  return freezeDeep({
    id: declaration.id,
    features,
    hookProfile: declaration.hookProfile,
    identity: computeCompressionVariantIdentity(features, declaration.hookProfile),
  });
}
