import type { BenchmarkEnvironment, BenchmarkIdentity, ModelSettings } from "../baseline.js";
// Type-only: `compression/variant.ts` reaches back here for `freezeDeep`, and a
// value import in this direction would make the two modules a runtime cycle.
import type { CompressionVariant } from "../compression/variant.js";
import { EXECUTION_MODES, type ExecutionMode } from "../result.js";
import type { BenchmarkSuiteConfig } from "../suite-config.js";
import { canonicalDigest, canonicalJson } from "./canonical-json.js";

/**
 * The baseline manifest (BENCH-8).
 *
 * A number is comparable only against a number measured the same way, so a
 * baseline states the way it was measured before it states anything it measured.
 * The manifest is that statement: the identity of the scenario suite, the run
 * configuration and the policy set; the AG commit under measurement; the model
 * settings; the host the numbers were produced on; and the versions of the
 * execution adapters and of the acceptance verifier, each of which can move
 * every metric in the report without a single scenario changing.
 *
 * Two properties make it usable as evidence rather than as decoration.
 *
 * **It is immutable.** {@link freezeDeep} seals a manifest when it is built, and
 * every consumer receives the sealed object. A comparison that could edit the
 * baseline it is being judged against is not a comparison.
 *
 * **Its hash is canonical.** {@link computeBaselineManifestHash} digests an
 * explicit projection of the declared fields — not the object as handed in — so
 * a stray own key from a hand-built record or from a schema version this build
 * does not know cannot reach the digest, and two machines that recorded the same
 * methodology produce the same sixty-four characters.
 *
 * The hash identifies the *document*; it is not what decides comparability. A
 * digest can only report "different", and a benchmark refusing a comparison owes
 * the reader the field that differed — that is `compatibility.ts`'s job.
 */

/**
 * Version 2 added `metricsVersion`. A manifest recorded under version 1 is refused rather than
 * read with the field defaulted: version 1 is exactly the set of baselines whose `tokens` metric
 * excluded cache creation, and defaulting the missing field would declare them comparable with
 * runs that measure a different quantity — the one failure the field exists to prevent.
 */
export const BASELINE_MANIFEST_SCHEMA_VERSION = 2;

/**
 * The methodology version of the independent acceptance verifier (BENCH-6).
 *
 * Acceptance is a judgement, and the rules behind it are as much part of the
 * measurement as the model is: a verifier that starts counting an empty change
 * as a rejection moves `acceptedRate` across the whole suite. Recorded here
 * rather than derived from a package version, because a patch release that does
 * not touch the acceptance rules must not invalidate every baseline, and a rule
 * change inside one release must — so the number is bumped by the author of the
 * rule change and by nothing else.
 */
export const ACCEPTANCE_VERIFIER_VERSION = "independent-acceptance/1";

/**
 * A tool whose version can move a measurement. Structurally the `ToolVersion`
 * that `application/run-environment.ts` captures; restated here because the
 * domain does not import the application layer, and a manifest that could not
 * name its own fields would not be a contract.
 */
export interface BaselineToolVersion {
  readonly tool: string;
  readonly version: string;
}

/**
 * Everything a comparison needs to know about how a run was produced.
 *
 * `identity` carries the hashes and the AG commit; the remaining fields are
 * either methodology the hashes summarise (and therefore restate by name, so a
 * refusal can point at one) or host provenance a comparison weighs rather than
 * requires.
 */
export interface BaselineManifest {
  readonly schemaVersion: number;
  /** Stable label a report and a file name refer to, e.g. `2026-08-07-opus-5`. */
  readonly baselineId: string;
  /** ISO-8601 UTC. A local-time stamp cannot be ordered against one from another machine. */
  readonly createdAt: string;
  readonly identity: BenchmarkIdentity;
  /** The `ScenarioSuite.version` the samples were taken under; `identity.suiteHash` covers it. */
  readonly suiteVersion: string;
  readonly modelSettings: ModelSettings;
  /** {@link ACCEPTANCE_VERIFIER_VERSION} as it stood when the samples were verified. */
  readonly verifierVersion: string;
  /**
   * `MODE_COST_KPI_VERSION` as it stood when the samples were aggregated — the version of the
   * quantity the cost metrics measure, not of the code that measured it.
   *
   * Recorded for the same reason `verifierVersion` is: acceptance and cost are both judgements,
   * and a comparison across two definitions of either is not a comparison. A digest cannot carry
   * this, because two runs can agree on every input and still fold them into different numbers.
   */
  readonly metricsVersion: string;
  readonly environment: BenchmarkEnvironment;
  /** Operating system type and release, e.g. `Windows_NT 10.0.26200`. Never the host name. */
  readonly osRelease: string;
  readonly toolVersions: readonly BaselineToolVersion[];
}

// ---------------------------------------------------------------------------
// Canonical projection
// ---------------------------------------------------------------------------

function projectModelSettings(settings: ModelSettings): Record<string, unknown> {
  // An absent temperature means "the provider default", which is not a value
  // this manifest may invent — it is omitted, and two runs that both omitted it
  // agree.
  return {
    model: settings.model,
    ...(settings.temperature === undefined ? {} : { temperature: settings.temperature }),
    ...(settings.maxOutputTokens === undefined
      ? {}
      : { maxOutputTokens: settings.maxOutputTokens }),
  };
}

/**
 * Adapter versions keyed by the declared modes and nothing else. A mode without
 * a version throws rather than serialising to an absent key: an omitted key
 * would hash identically to a manifest that never had that mode, which is the
 * one thing a comparability check must be able to tell apart.
 */
function projectModeAdapterVersions(
  versions: Readonly<Record<ExecutionMode, string>>,
): Record<string, string> {
  return Object.fromEntries(
    EXECUTION_MODES.map((mode) => {
      const version = versions[mode];
      if (typeof version !== "string" || version === "") {
        throw new TypeError(
          `No adapter version recorded for mode "${mode}"; a manifest names every declared mode.`,
        );
      }
      return [mode, version];
    }),
  );
}

function projectIdentity(identity: BenchmarkIdentity): Record<string, unknown> {
  return {
    suiteHash: identity.suiteHash,
    configHash: identity.configHash,
    policyHash: identity.policyHash,
    agCommit: identity.agCommit,
    modeAdapterVersions: projectModeAdapterVersions(identity.modeAdapterVersions),
  };
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Tool versions as a set keyed by tool name. The capture adapter already emits a
 * fixed order, but the manifest is also assembled by hand in tests and by a
 * future capture with another tool list, and a set that hashes by arrival order
 * is not a set.
 */
function projectToolVersions(versions: readonly BaselineToolVersion[]): unknown[] {
  return [...versions]
    .sort((left, right) => compareText(left.tool, right.tool) || compareText(left.version, right.version))
    .map((entry) => ({ tool: entry.tool, version: entry.version }));
}

/**
 * A declared compression cohort as a set of variants, each a set of flags.
 *
 * Both levels are sorted: the order variants are declared in is the order a
 * report presents them, and the order flags are listed in is an accident of how
 * the declaration was typed. Neither changes what was measured, so neither may
 * change the configuration's identity. The variant identity is projected too,
 * because it is the one field that carries the registry version — a flag list
 * that means something else under a new registry has to hash differently.
 */
function projectCompressionCohort(cohort: readonly CompressionVariant[]): unknown[] {
  return [...cohort]
    .sort((left, right) => compareText(left.id, right.id))
    .map((variant) => ({
      id: variant.id,
      features: [...variant.features].sort(compareText),
      hookProfile: variant.hookProfile,
      identity: variant.identity,
    }));
}

function projectEnvironment(environment: BenchmarkEnvironment): Record<string, unknown> {
  return {
    platform: environment.platform,
    arch: environment.arch,
    nodeVersion: environment.nodeVersion,
    cpuCount: environment.cpuCount,
  };
}

/** The exact value a manifest hash is taken over — every declared field, nothing else. */
function projectManifest(manifest: BaselineManifest): Record<string, unknown> {
  return {
    schemaVersion: manifest.schemaVersion,
    baselineId: manifest.baselineId,
    createdAt: manifest.createdAt,
    identity: projectIdentity(manifest.identity),
    suiteVersion: manifest.suiteVersion,
    modelSettings: projectModelSettings(manifest.modelSettings),
    verifierVersion: manifest.verifierVersion,
    metricsVersion: manifest.metricsVersion,
    environment: projectEnvironment(manifest.environment),
    osRelease: manifest.osRelease,
    toolVersions: projectToolVersions(manifest.toolVersions),
  };
}

/** The canonical bytes of a manifest, for diffing two manifests whose hashes disagree. */
export function canonicalizeBaselineManifest(manifest: BaselineManifest): string {
  return canonicalJson(projectManifest(manifest));
}

/** The manifest's content hash: `sha256:` followed by sixty-four hex characters. */
export function computeBaselineManifestHash(manifest: BaselineManifest): string {
  return canonicalDigest(projectManifest(manifest));
}

/**
 * The run configuration's identity (`BenchmarkIdentity.configHash`).
 *
 * Modes are sorted before hashing: the config declares them in the order a
 * report presents them, and presentation order does not change what was
 * measured. Everything else is hashed as declared, because everything else is
 * either a number that bounds the run or a version that decides how it executes.
 */
export function computeSuiteConfigHash(config: BenchmarkSuiteConfig): string {
  return canonicalDigest({
    schemaVersion: config.schemaVersion,
    suiteVersion: config.suiteVersion,
    modes: [...config.modes].sort(compareText),
    repetitions: config.repetitions,
    modelSettings: projectModelSettings(config.modelSettings),
    limits: { timeoutMs: config.limits.timeoutMs, tokenLimit: config.limits.tokenLimit },
    modeAdapterVersions: projectModeAdapterVersions(config.modeAdapterVersions),
    allowNetworkModels: config.allowNetworkModels,
    // Projected only when declared. `canonicalJson` omits an `undefined` value,
    // so a config that declares no cohort canonicalises to exactly the bytes it
    // did before this field existed and keeps its digest — which is what lets
    // every baseline recorded before the cohort stay comparable.
    ...(config.compressionCohort === undefined
      ? {}
      : { compressionCohort: projectCompressionCohort(config.compressionCohort) }),
  });
}

// ---------------------------------------------------------------------------
// Immutability
// ---------------------------------------------------------------------------

/**
 * Seals a value and everything reachable from it.
 *
 * `readonly` is a compile-time claim that a plain `JSON.parse` result does not
 * carry and that a consumer in another package can ignore; freezing makes the
 * claim hold at runtime. An already-frozen subtree is left alone, which also
 * bounds the recursion on a value that somehow refers to itself.
 */
export function freezeDeep<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const nested of Object.values(value as Record<string, unknown>)) freezeDeep(nested);
  return value;
}
