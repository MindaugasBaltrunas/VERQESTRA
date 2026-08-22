import { canonicalDigest } from "../baseline/canonical-json.js";
import { COMPRESSION_FEATURES, type CompressionFeature } from "./features.js";

/**
 * The identity of the compression configuration a run was measured under
 * (BENCH-8, task 1205).
 *
 * `vq/config/context-compression.json` decides which context-compression
 * features the orchestrator applies while a benchmarked agent works, so it can
 * move token counts across a whole run without a scenario, a model or an adapter
 * changing. A run that recorded no statement about it can be read months later
 * and attributed to nothing.
 *
 * ## Recorded, not hashed into the run identity
 *
 * The digest computed here does *not* enter `BenchmarkIdentity.configHash` or
 * `policyHash`. The file is part of the tree under measurement, and the tree is
 * already identified by `BenchmarkIdentity.agCommit` — the same argument
 * `application/run/run-policy.ts` makes for AG's rule files. Folding it into a
 * comparability hash would additionally re-identify every configuration and make
 * every future run refuse the baselines already committed to this package with
 * `methodology-mismatch`, which is a cost paid for a fact the commit id already
 * carries.
 *
 * So the digest is provenance: it is stored beside a run and it gates nothing.
 * What consumes it is the compression reporting, which needs to say which
 * configuration the numbers were produced under.
 *
 * ## Whole document in, projection out
 *
 * The digest is taken over the *whole* parsed document rather than over the view
 * below. A projection would let a key this build does not know change the file
 * without changing the digest, and an unknown key in a feature-flag file is
 * precisely the case where the reader must be told something moved. The view is
 * the opposite job — a stable, readable summary of the flags this package knows
 * — and the two are deliberately not the same value.
 */

/** Bumped when the digest's projection changes shape, so an old digest is visibly not a new one. */
export const COMPRESSION_CONFIG_PROJECTION_VERSION = 2;

/**
 * Repository-relative location of the configuration, named in the digest and in
 * every stored record. A stored artefact never names a host path: it is
 * committed and shared, and an absolute path discloses the author's machine
 * while adding nothing a reader can check.
 */
export const COMPRESSION_CONFIG_SOURCE = "vq/config/context-compression.json";

/**
 * The three states a registry flag is authored in.
 *
 * `"canary"` is neither on nor off: the orchestrator applies the feature to the
 * share of work `canary.percent` selects and leaves the rest alone. Projecting it
 * as a boolean forces a choice between reporting a rollout as fully on and
 * reporting it as off, and both are statements the file never made.
 */
export type CompressionFeatureFlagState = false | "canary" | true;

/** One registry flag as the configuration leaves it, uninterpreted. */
export interface CompressionConfigFeatureState {
  readonly feature: CompressionFeature;
  readonly state: CompressionFeatureFlagState;
}

/**
 * The canary rollout the document declares.
 *
 * Both fields are `undefined` when the document does not state them: absent is
 * not zero and not the empty salt, and either value invented here would read as a
 * rollout somebody configured.
 */
export interface CompressionConfigCanary {
  /** The declared percentage of work the canary arm receives, or `undefined`. */
  readonly percent: number | undefined;
  /**
   * The declared bucketing salt, or `undefined`. It rides in the view because it
   * decides *which* work lands in the canary arm: two runs at the same percentage
   * and different salts measured different work.
   */
  readonly salt: string | undefined;
}

/**
 * The readable summary of a compression configuration.
 *
 * `version` is `undefined` when the document does not state it as a number, for
 * the same reason the canary fields are.
 */
export interface CompressionConfigView {
  /** The registry version the document declares, or `undefined` when it declares none. */
  readonly version: number | undefined;
  /** Every flag of {@link COMPRESSION_FEATURES}, in registry order. */
  readonly features: readonly CompressionConfigFeatureState[];
  /** The canary rollout the document declares, field by field. */
  readonly canary: CompressionConfigCanary;
}

/** Own-keyed plain object, or `undefined` for anything else a JSON document may hold. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/** A finite number, or `undefined`; a `NaN` or an `Infinity` is not a version or a percentage. */
function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** A string as authored, or `undefined` for anything that is not one. An empty salt is a salt somebody wrote. */
function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * One flag as the document authored it.
 *
 * The two known-good values pass through unchanged; everything else — missing, a
 * typo, a number — reads `false`. That is the fail-closed direction and it is the
 * only rule this projection applies: an unknown must never be filled in as `true`
 * or as `"canary"` and reported as a feature that was measured in use.
 */
function asFeatureFlagState(value: unknown): CompressionFeatureFlagState {
  return value === true || value === "canary" ? value : false;
}

/**
 * The digest of a compression configuration document.
 *
 * The projection version and the source ride inside the digested value, so two
 * digests can only be equal when the same file was read and read the same way.
 */
export function computeCompressionConfigDigest(document: unknown): string {
  return canonicalDigest({
    projectionVersion: COMPRESSION_CONFIG_PROJECTION_VERSION,
    source: COMPRESSION_CONFIG_SOURCE,
    document,
  });
}

/**
 * The flags this package knows, read out of an arbitrary document.
 *
 * Every declared feature is listed, in registry order, whether or not the
 * document mentions it — a flag missing from the view and a flag set to `false`
 * are the same statement to a reader, and enumerating the document's own keys
 * would make the view's shape depend on the file. A value that is missing or not
 * one of the states the registry defines reads `false`, which is what the
 * orchestrator does with it.
 *
 * What the view never does is *interpret* a value it recognises. A `"canary"`
 * flag is carried through as `"canary"`, beside the percentage and salt that say
 * how much work it covered; collapsing it into a boolean would make the sidecar
 * contradict the file it claims to describe.
 */
export function projectCompressionConfigView(document: unknown): CompressionConfigView {
  const root = asRecord(document);
  const features = asRecord(root?.["features"]);
  const canary = asRecord(root?.["canary"]);
  return {
    version: asFiniteNumber(root?.["version"]),
    features: COMPRESSION_FEATURES.map((feature) => ({
      feature,
      state: asFeatureFlagState(features?.[feature]),
    })),
    canary: {
      percent: asFiniteNumber(canary?.["percent"]),
      salt: asString(canary?.["salt"]),
    },
  };
}
