import { EXECUTION_MODES } from "../result.js";
import { canonicallyEqual } from "./canonical-json.js";
import { BASELINE_MANIFEST_SCHEMA_VERSION, type BaselineManifest } from "./manifest.js";

/**
 * The comparability gate (BENCH-8).
 *
 * Two runs may be compared only when they measured the same thing under the same
 * rules. This module decides that, fail-closed: a difference in any required
 * methodology field refuses the comparison outright, and the refusal names the
 * field. Reporting a difference the harness cannot attribute is worse than
 * reporting nothing — an unattributed regression sends someone looking for a
 * bug that is a model temperature, and an unattributed improvement gets
 * announced.
 *
 * ## What blocks and what only weakens
 *
 * **Required (a mismatch refuses the comparison).** The suite, config and policy
 * hashes; the suite version; the model settings; the per-mode adapter versions;
 * the verifier version. The hashes already cover most of the named fields — the
 * names exist so a refusal can be read without recomputing a digest, and so a
 * manifest whose hash disagrees with its own stated model is caught rather than
 * trusted.
 *
 * **Advisory (recorded, never blocking).** Platform, architecture, Node version,
 * core count, OS release and tool versions. A different host makes a duration
 * comparison weaker, not impossible, and refusing on it would make every
 * cross-machine baseline useless while telling the reader nothing they could not
 * be told in a limitation. `domain/baseline.ts` states this split; it is
 * implemented here.
 *
 * **The AG commit is deliberately not required.** It is the variable under
 * measurement: a comparison whose two sides share an AG commit is the one that
 * cannot attribute a difference to AG, so an equal commit raises a limitation
 * and a differing one raises none. An *empty* commit on either side is a
 * refusal, because a run that cannot be attributed to a tree is not a
 * before-and-after of anything.
 */

export const COMPARABILITY_REFUSAL_CODES = {
  /** A manifest was written under a schema version this build cannot interpret. */
  unsupportedManifestSchema: "unsupported-manifest-schema",
  /** A run carries no AG commit, so no difference can be attributed to a tree. */
  unattributableRun: "unattributable-run",
  /** A required methodology field differs; the two runs did not measure the same thing. */
  methodologyMismatch: "methodology-mismatch",
} as const;

export type ComparabilityRefusalCode =
  (typeof COMPARABILITY_REFUSAL_CODES)[keyof typeof COMPARABILITY_REFUSAL_CODES];

/** One reason a comparison was refused, with the field that raised it. */
export interface ComparabilityRefusal {
  readonly code: ComparabilityRefusalCode;
  /** The manifest field path, or `baseline` / `current` when it is about a whole record. */
  readonly subject: string;
  /** Human-readable explanation. Never parsed — the code is what a report groups on. */
  readonly detail: string;
}

export interface ComparabilityAssessment {
  /** True only when no refusal was raised. Fail-closed: nothing else grants comparability. */
  readonly comparable: boolean;
  readonly refusals: readonly ComparabilityRefusal[];
  /**
   * Differences that weaken the comparison without refusing it, and the notes a
   * report must show beside the verdict (BENCH-10).
   */
  readonly limitations: readonly string[];
}

/** Reported for an adapter version a manifest failed to carry; never equal to a real version. */
const ABSENT = "(absent)";

/** Reported for an optional model setting nobody set; two runs that both omitted it agree. */
const PROVIDER_DEFAULT = "(provider default)";

/** One manifest field, rendered as the text the gate compares. */
export interface ManifestField {
  readonly field: string;
  readonly read: (manifest: BaselineManifest) => string;
}

function optionalNumber(value: number | undefined): string {
  return value === undefined ? PROVIDER_DEFAULT : String(value);
}

/**
 * The fields that decide comparability, in the order a refusal reports them.
 * Exported so a report — or a test — can enumerate the contract rather than
 * restate it.
 */
export const REQUIRED_METHODOLOGY_FIELDS: readonly ManifestField[] = [
  { field: "identity.suiteHash", read: (manifest) => manifest.identity.suiteHash },
  { field: "suiteVersion", read: (manifest) => manifest.suiteVersion },
  { field: "identity.configHash", read: (manifest) => manifest.identity.configHash },
  { field: "identity.policyHash", read: (manifest) => manifest.identity.policyHash },
  { field: "modelSettings.model", read: (manifest) => manifest.modelSettings.model },
  {
    field: "modelSettings.temperature",
    read: (manifest) => optionalNumber(manifest.modelSettings.temperature),
  },
  {
    field: "modelSettings.maxOutputTokens",
    read: (manifest) => optionalNumber(manifest.modelSettings.maxOutputTokens),
  },
  { field: "verifierVersion", read: (manifest) => manifest.verifierVersion },
  ...EXECUTION_MODES.map((mode) => ({
    field: `identity.modeAdapterVersions.${mode}`,
    read: (manifest: BaselineManifest) => manifest.identity.modeAdapterVersions[mode] ?? ABSENT,
  })),
];

/** The fields reported beside the verdict. A difference here is a limitation, never a refusal. */
export const ADVISORY_ENVIRONMENT_FIELDS: readonly ManifestField[] = [
  { field: "environment.platform", read: (manifest) => manifest.environment.platform },
  { field: "environment.arch", read: (manifest) => manifest.environment.arch },
  { field: "environment.nodeVersion", read: (manifest) => manifest.environment.nodeVersion },
  { field: "environment.cpuCount", read: (manifest) => String(manifest.environment.cpuCount) },
  { field: "osRelease", read: (manifest) => manifest.osRelease },
];

function assessSchema(
  manifest: BaselineManifest,
  side: string,
  refusals: ComparabilityRefusal[],
): void {
  if (manifest.schemaVersion === BASELINE_MANIFEST_SCHEMA_VERSION) return;
  refusals.push({
    code: COMPARABILITY_REFUSAL_CODES.unsupportedManifestSchema,
    subject: side,
    detail:
      `the ${side} manifest declares schema version ${manifest.schemaVersion}, ` +
      `and this build reads version ${BASELINE_MANIFEST_SCHEMA_VERSION}; ` +
      "a version it does not know may redefine the fields it does",
  });
}

function assessAttribution(
  manifest: BaselineManifest,
  side: string,
  refusals: ComparabilityRefusal[],
): void {
  if (manifest.identity.agCommit !== "") return;
  refusals.push({
    code: COMPARABILITY_REFUSAL_CODES.unattributableRun,
    subject: side,
    detail:
      `the ${side} run records no AG commit, so whatever the numbers show ` +
      "cannot be attributed to a state of the tree",
  });
}

/**
 * Whether `current` may be compared against `baseline`.
 *
 * Total and pure: it reads two manifests and returns a decision. Every required
 * field is examined even after one has already failed, because an operator
 * fixing a comparison needs the whole list rather than one round trip per field.
 */
export function assessComparability(
  baseline: BaselineManifest,
  current: BaselineManifest,
): ComparabilityAssessment {
  const refusals: ComparabilityRefusal[] = [];
  const limitations: string[] = [];

  assessSchema(baseline, "baseline", refusals);
  assessSchema(current, "current", refusals);
  assessAttribution(baseline, "baseline", refusals);
  assessAttribution(current, "current", refusals);

  for (const { field, read } of REQUIRED_METHODOLOGY_FIELDS) {
    const left = read(baseline);
    const right = read(current);
    if (left === right && left !== ABSENT) continue;
    refusals.push({
      code: COMPARABILITY_REFUSAL_CODES.methodologyMismatch,
      subject: field,
      detail:
        `${field} differs: the baseline records ${JSON.stringify(left)} and ` +
        `the current run ${JSON.stringify(right)}; the two runs did not measure the same thing`,
    });
  }

  for (const { field, read } of ADVISORY_ENVIRONMENT_FIELDS) {
    const left = read(baseline);
    const right = read(current);
    if (left === right) continue;
    limitations.push(
      `${field} differs (baseline ${JSON.stringify(left)}, current ${JSON.stringify(right)}): ` +
        "durations and check timings are weaker evidence across hosts",
    );
  }

  if (!canonicallyEqual(baseline.toolVersions, current.toolVersions)) {
    limitations.push(
      "the two runs used different tool versions " +
        `(baseline ${describeTools(baseline)}, current ${describeTools(current)}): ` +
        "a check executed by another toolchain can pass or fail for its own reasons",
    );
  }

  if (baseline.identity.agCommit === current.identity.agCommit) {
    limitations.push(
      `both runs record AG commit ${baseline.identity.agCommit}: a difference between them ` +
        "is run-to-run variance, not an effect of a change to AG",
    );
  }

  return { comparable: refusals.length === 0, refusals, limitations };
}

function describeTools(manifest: BaselineManifest): string {
  const listed = [...manifest.toolVersions]
    .map((entry) => `${entry.tool} ${entry.version}`)
    .sort();
  return listed.length === 0 ? "none recorded" : listed.join(", ");
}

/** The distinct refusal codes, in the order they were raised — what a comparison publishes as its reasons. */
export function comparabilityRefusalCodes(
  assessment: ComparabilityAssessment,
): readonly ComparabilityRefusalCode[] {
  return [...new Set(assessment.refusals.map((refusal) => refusal.code))];
}
