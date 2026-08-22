import type { BenchmarkBaseline, ModelSettings } from "../baseline.js";
import type { ModeMetrics } from "../metrics.js";
import { aggregateSamplesByMode, toModeMetrics } from "../metrics/aggregate.js";
import { EXECUTION_MODES, type BenchmarkSample, type ExecutionMode } from "../result.js";
import { validateBenchmarkSample } from "../schema-validation.js";
import { MODEL_TEMPERATURE_BOUNDS } from "../suite-config.js";
import {
  ValidationProblems,
  joinPath,
  readInteger,
  readList,
  readMatching,
  readNumber,
  readRecord,
  readSchemaVersion,
  readString,
  toValidationResult,
  type ValidationResult,
} from "../validation.js";
import { CANONICAL_DIGEST_PATTERN, canonicalJson, canonicallyEqual } from "./canonical-json.js";
import {
  BASELINE_MANIFEST_SCHEMA_VERSION,
  computeBaselineManifestHash,
  freezeDeep,
  type BaselineManifest,
  type BaselineToolVersion,
} from "./manifest.js";

/**
 * The stored baseline document (BENCH-8).
 *
 * A baseline is a file that outlives the process that wrote it, so everything
 * about it is fail-closed on the way back in: it is read from `unknown`, every
 * field is recognised before it is admitted, and two integrity checks decide
 * whether the record still says what it said when it was sealed.
 *
 * **The manifest hash is recomputed**, not trusted. A hash stored beside the
 * thing it describes is only evidence if someone recomputes it; a hand-edited
 * model id under an untouched digest is exactly the corruption BENCH-5 refuses
 * to let through silently.
 *
 * **The aggregates are recomputed** from the stored samples and compared with
 * the stored ones. BENCH-8 requires a baseline to carry its aggregates, and
 * BENCH-7 makes them a pure fold of the samples — so a file whose two halves
 * disagree has had one of them edited, and neither may be published. Storing
 * both and checking them is what makes the file readable by a consumer that
 * cannot run the fold, without making it forgeable by one that can type.
 */

export const BASELINE_DOCUMENT_SCHEMA_VERSION = 1;

export interface BaselineDocument {
  readonly schemaVersion: number;
  /** {@link computeBaselineManifestHash} of `manifest`, recorded so a reader can recheck it. */
  readonly manifestHash: string;
  readonly manifest: BaselineManifest;
  /** Non-empty: a baseline with no sample measured nothing and can regress against nothing. */
  readonly samples: readonly BenchmarkSample[];
  /** Derived from `samples` (BENCH-7); stored so the file stands on its own (BENCH-8). */
  readonly aggregates: readonly ModeMetrics[];
}

/**
 * Builds the document a baseline is stored as: aggregates folded from the
 * samples, manifest hashed, everything sealed. It does not validate — the
 * application layer round-trips the result through {@link validateBaselineDocument}
 * so that a baseline is created only if it can be read back.
 */
export function sealBaselineDocument(
  manifest: BaselineManifest,
  samples: readonly BenchmarkSample[],
): BaselineDocument {
  return freezeDeep({
    schemaVersion: BASELINE_DOCUMENT_SCHEMA_VERSION,
    manifestHash: computeBaselineManifestHash(manifest),
    manifest,
    samples: [...samples],
    aggregates: toModeMetrics(aggregateSamplesByMode(samples)),
  });
}

/**
 * The bytes a baseline file holds: canonical JSON and a trailing newline, so the
 * same baseline written twice is the same file and a diff of two baselines is a
 * diff of what they measured.
 */
export function serializeBaselineDocument(document: BaselineDocument): string {
  return `${canonicalJson(document)}\n`;
}

/** The published {@link BenchmarkBaseline} view of a stored document. */
export function toBenchmarkBaseline(document: BaselineDocument): BenchmarkBaseline {
  return {
    schemaVersion: document.schemaVersion,
    createdAt: document.manifest.createdAt,
    identity: document.manifest.identity,
    modelSettings: document.manifest.modelSettings,
    environment: document.manifest.environment,
    samples: document.samples,
    aggregates: document.aggregates,
    manifest: document.manifest,
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** ISO-8601 in UTC. A local-time stamp cannot be ordered against one from another machine. */
const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

const SEMANTIC_VERSION = /^\d+\.\d+\.\d+$/;

/** A full Git object id, SHA-1 or SHA-256. Abbreviations are not stable identifiers. */
const COMMIT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** Lowercase kebab-case with digits, e.g. `2026-08-07-opus-5`. */
const IDENTIFIER = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** A version string an adapter, a verifier or a tool reported. Free-form but bounded and printable. */
const VERSION_LABEL = /^[\x20-\x7e]{1,120}$/;

const BASELINE_DOCUMENT_KEYS = [
  "schemaVersion",
  "manifestHash",
  "manifest",
  "samples",
  "aggregates",
] as const;

const MANIFEST_KEYS = [
  "schemaVersion",
  "baselineId",
  "createdAt",
  "identity",
  "suiteVersion",
  "modelSettings",
  "verifierVersion",
  "environment",
  "osRelease",
  "toolVersions",
] as const;

const IDENTITY_KEYS = [
  "suiteHash",
  "configHash",
  "policyHash",
  "agCommit",
  "modeAdapterVersions",
] as const;

const MODEL_SETTINGS_KEYS = ["model", "temperature", "maxOutputTokens"] as const;

const ENVIRONMENT_KEYS = ["platform", "arch", "nodeVersion", "cpuCount"] as const;

const TOOL_VERSION_KEYS = ["tool", "version"] as const;

/** A host reports at least one usable core; the ceiling only rejects a number that is not a core count. */
const CPU_COUNT_BOUNDS = { min: 1, max: 4096 } as const;

/**
 * Reads a required nested object and its allowed keys in one step, returning the
 * path so problems inside it are reported at their real location.
 */
function readNested(
  source: Record<string, unknown>,
  key: string,
  at: string,
  allowedKeys: readonly string[],
  problems: ValidationProblems,
): { readonly record: Record<string, unknown>; readonly path: string } | undefined {
  const path = joinPath(at, key);
  if (!Object.hasOwn(source, key)) {
    problems.add(path, "missing", "required field is missing");
    return undefined;
  }
  const record = readRecord(source[key], path, allowedKeys, problems);
  return record === undefined ? undefined : { record, path };
}

function readDigest(
  source: Record<string, unknown>,
  key: string,
  at: string,
  problems: ValidationProblems,
): string | undefined {
  return readMatching(
    source,
    key,
    at,
    problems,
    CANONICAL_DIGEST_PATTERN,
    "a canonical digest like sha256:<64 hex characters>",
  );
}

function readModeAdapterVersions(
  source: Record<string, unknown>,
  at: string,
  problems: ValidationProblems,
): Readonly<Record<ExecutionMode, string>> | undefined {
  const nested = readNested(source, "modeAdapterVersions", at, EXECUTION_MODES, problems);
  if (nested === undefined) return undefined;
  const entries: Array<readonly [ExecutionMode, string]> = [];
  for (const mode of EXECUTION_MODES) {
    const version = readMatching(
      nested.record,
      mode,
      nested.path,
      problems,
      VERSION_LABEL,
      "a printable version label",
    );
    if (version !== undefined) entries.push([mode, version]);
  }
  if (entries.length !== EXECUTION_MODES.length) return undefined;
  // Total by construction: the loop above visited every declared mode.
  return Object.fromEntries(entries) as Readonly<Record<ExecutionMode, string>>;
}

function readIdentity(
  source: Record<string, unknown>,
  at: string,
  problems: ValidationProblems,
): BaselineManifest["identity"] | undefined {
  const nested = readNested(source, "identity", at, IDENTITY_KEYS, problems);
  if (nested === undefined) return undefined;
  const suiteHash = readDigest(nested.record, "suiteHash", nested.path, problems);
  const configHash = readDigest(nested.record, "configHash", nested.path, problems);
  const policyHash = readDigest(nested.record, "policyHash", nested.path, problems);
  // An empty commit is refused at the schema, not only at the comparability
  // gate: a stored baseline that names no tree is evidence of nothing, and the
  // gate exists for the runs that were never stored.
  const agCommit = readMatching(
    nested.record,
    "agCommit",
    nested.path,
    problems,
    COMMIT_ID,
    "a full Git object id",
  );
  const modeAdapterVersions = readModeAdapterVersions(nested.record, nested.path, problems);
  if (
    suiteHash === undefined ||
    configHash === undefined ||
    policyHash === undefined ||
    agCommit === undefined ||
    modeAdapterVersions === undefined
  ) {
    return undefined;
  }
  return { suiteHash, configHash, policyHash, agCommit, modeAdapterVersions };
}

function readModelSettings(
  source: Record<string, unknown>,
  at: string,
  problems: ValidationProblems,
): ModelSettings | undefined {
  const nested = readNested(source, "modelSettings", at, MODEL_SETTINGS_KEYS, problems);
  if (nested === undefined) return undefined;
  const model = readString(nested.record, "model", nested.path, problems);
  // Both settings are optional and neither is defaulted: an absent temperature
  // means the provider's, which is not a number this schema may invent.
  const temperature = Object.hasOwn(nested.record, "temperature")
    ? readNumber(nested.record, "temperature", nested.path, problems, MODEL_TEMPERATURE_BOUNDS)
    : undefined;
  const maxOutputTokens = Object.hasOwn(nested.record, "maxOutputTokens")
    ? readInteger(nested.record, "maxOutputTokens", nested.path, problems, {
        min: 1,
        max: Number.MAX_SAFE_INTEGER,
      })
    : undefined;
  if (model === undefined) return undefined;
  return {
    model,
    ...(temperature === undefined ? {} : { temperature }),
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
  };
}

function readEnvironment(
  source: Record<string, unknown>,
  at: string,
  problems: ValidationProblems,
): BaselineManifest["environment"] | undefined {
  const nested = readNested(source, "environment", at, ENVIRONMENT_KEYS, problems);
  if (nested === undefined) return undefined;
  const platform = readString(nested.record, "platform", nested.path, problems);
  const arch = readString(nested.record, "arch", nested.path, problems);
  const nodeVersion = readString(nested.record, "nodeVersion", nested.path, problems);
  const cpuCount = readInteger(nested.record, "cpuCount", nested.path, problems, CPU_COUNT_BOUNDS);
  if (
    platform === undefined ||
    arch === undefined ||
    nodeVersion === undefined ||
    cpuCount === undefined
  ) {
    return undefined;
  }
  return { platform, arch, nodeVersion, cpuCount };
}

function readToolVersions(
  source: Record<string, unknown>,
  at: string,
  problems: ValidationProblems,
): readonly BaselineToolVersion[] | undefined {
  return readList(source, "toolVersions", at, problems, 0, (element, elementPath) => {
    const record = readRecord(element, elementPath, TOOL_VERSION_KEYS, problems);
    if (record === undefined) return undefined;
    const tool = readString(record, "tool", elementPath, problems);
    const version = readMatching(
      record,
      "version",
      elementPath,
      problems,
      VERSION_LABEL,
      "a printable version label",
    );
    return tool === undefined || version === undefined ? undefined : { tool, version };
  });
}

function readManifest(
  source: Record<string, unknown>,
  problems: ValidationProblems,
): BaselineManifest | undefined {
  const nested = readNested(source, "manifest", "", MANIFEST_KEYS, problems);
  if (nested === undefined) return undefined;
  const at = nested.path;
  const schemaVersion = readSchemaVersion(
    nested.record,
    at,
    problems,
    BASELINE_MANIFEST_SCHEMA_VERSION,
  );
  const baselineId = readMatching(
    nested.record,
    "baselineId",
    at,
    problems,
    IDENTIFIER,
    "a lowercase kebab-case identifier",
  );
  const createdAt = readMatching(
    nested.record,
    "createdAt",
    at,
    problems,
    UTC_TIMESTAMP,
    "an ISO-8601 UTC timestamp like 2026-08-07T09:00:00.000Z",
  );
  const identity = readIdentity(nested.record, at, problems);
  const suiteVersion = readMatching(
    nested.record,
    "suiteVersion",
    at,
    problems,
    SEMANTIC_VERSION,
    "a semantic version like 1.0.0",
  );
  const modelSettings = readModelSettings(nested.record, at, problems);
  const verifierVersion = readMatching(
    nested.record,
    "verifierVersion",
    at,
    problems,
    VERSION_LABEL,
    "a printable version label",
  );
  const environment = readEnvironment(nested.record, at, problems);
  const osRelease = readString(nested.record, "osRelease", at, problems);
  const toolVersions = readToolVersions(nested.record, at, problems);

  if (
    schemaVersion === undefined ||
    baselineId === undefined ||
    createdAt === undefined ||
    identity === undefined ||
    suiteVersion === undefined ||
    modelSettings === undefined ||
    verifierVersion === undefined ||
    environment === undefined ||
    osRelease === undefined ||
    toolVersions === undefined
  ) {
    return undefined;
  }

  return {
    schemaVersion,
    baselineId,
    createdAt,
    identity,
    suiteVersion,
    modelSettings,
    verifierVersion,
    environment,
    osRelease,
    toolVersions,
  };
}

function readSamples(
  source: Record<string, unknown>,
  problems: ValidationProblems,
): readonly BenchmarkSample[] | undefined {
  return readList(source, "samples", "", problems, 1, (element, elementPath) => {
    const result = validateBenchmarkSample(element);
    if (result.ok) return result.value;
    for (const problem of result.problems) {
      problems.add(
        problem.path === "" ? elementPath : `${elementPath}.${problem.path}`,
        problem.code,
        problem.message,
      );
    }
    return undefined;
  });
}

/**
 * Reads a stored baseline document, fail-closed.
 *
 * The returned document is sealed, and its `aggregates` are the recomputed ones
 * — identical to the stored list by the check above, and preferred over it so
 * that what a caller receives is what the samples say.
 */
export function validateBaselineDocument(input: unknown): ValidationResult<BaselineDocument> {
  const problems = new ValidationProblems();
  const record = readRecord(input, "", BASELINE_DOCUMENT_KEYS, problems);
  if (record === undefined) return toValidationResult<BaselineDocument>(undefined, problems);

  const schemaVersion = readSchemaVersion(record, "", problems, BASELINE_DOCUMENT_SCHEMA_VERSION);
  const manifestHash = readDigest(record, "manifestHash", "", problems);
  const manifest = readManifest(record, problems);
  const samples = readSamples(record, problems);

  if (manifest !== undefined && manifestHash !== undefined) {
    const recomputed = computeBaselineManifestHash(manifest);
    if (recomputed !== manifestHash) {
      problems.add(
        "manifestHash",
        "inconsistent",
        `the stored hash ${manifestHash} is not the hash of the stored manifest (${recomputed}); ` +
          "the record was edited after it was sealed",
      );
    }
  }

  // The aggregates are a fold of the samples, so a disagreement means one of the
  // two was edited. Compared canonically because an unmeasured metric is absent
  // in the file and `undefined` in the fold, which is the same statement.
  if (samples !== undefined) {
    const recomputed = toModeMetrics(aggregateSamplesByMode(samples));
    if (!Object.hasOwn(record, "aggregates")) {
      problems.add("aggregates", "missing", "required field is missing");
    } else if (!canonicallyEqual(record["aggregates"], recomputed)) {
      problems.add(
        "aggregates",
        "inconsistent",
        "the stored aggregates are not the aggregates of the stored samples; " +
          "one of the two was edited after the baseline was sealed",
      );
    }
  }

  if (
    schemaVersion === undefined ||
    manifestHash === undefined ||
    manifest === undefined ||
    samples === undefined
  ) {
    return toValidationResult<BaselineDocument>(undefined, problems);
  }

  return toValidationResult(
    freezeDeep({
      schemaVersion,
      manifestHash,
      manifest,
      samples,
      aggregates: toModeMetrics(aggregateSamplesByMode(samples)),
    }),
    problems,
  );
}
