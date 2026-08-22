import { CANONICAL_DIGEST_PATTERN } from "../../domain/baseline/canonical-json.js";
import type {
  CompressionConfigCanary,
  CompressionConfigFeatureState,
  CompressionConfigView,
  CompressionFeatureFlagState,
} from "../../domain/compression/config-identity.js";
import {
  COMPRESSION_FEATURES,
  type CompressionFeature,
} from "../../domain/compression/features.js";
import {
  ValidationProblems,
  joinPath,
  readBoolean,
  readEnum,
  readInteger,
  readList,
  readNumber,
  readRecord,
  readString,
} from "../../domain/validation.js";
import {
  COMPRESSION_CONFIG_STATES,
  type RecordedCompressionConfig,
} from "../ports/compression-config-port.js";
import { RUN_IDENTITY_RECORD_SCHEMA_VERSION } from "../ports/run-identity-store-port.js";
import { readNested } from "./nested-record-reader.js";

/**
 * Reading back the compression configuration a run recorded (BENCH-8, task 1205;
 * tri-state projection, task 0039).
 *
 * Split out of `recorded-run-identity.ts`, which owns the record as a whole: this
 * is the one sub-document with a shape of its own — a registry of tri-state flags
 * and a canary rollout — and it is the one that changes when the compression
 * configuration's projection changes.
 *
 * Fail-closed like every other reader beside it: nothing is defaulted and nothing
 * is repaired. A record written under the previous projection is read under the
 * shape that version defined and lifted into the current one — it is a record of
 * another version, never a malformed current one — while a version this build
 * defines no shape for is refused outright.
 */

/** The record version whose view spelled a flag as a boolean `enabled`. */
const LEGACY_RECORD_SCHEMA_VERSION = 1;

/** A registry or projection version is a small non-negative integer, never a version string. */
const VERSION_NUMBER_BOUNDS = { min: 0, max: Number.MAX_SAFE_INTEGER } as const;

/** A percentage of a rollout, and nothing outside the range a percentage has. */
const PERCENT_BOUNDS = { min: 0, max: 100 } as const;

const COMPRESSION_CONFIG_KEYS = ["state", "source", "digest", "view"] as const;

const COMPRESSION_VIEW_KEYS = ["version", "features", "canary"] as const;

const COMPRESSION_FEATURE_KEYS = ["feature", "state"] as const;

const COMPRESSION_CANARY_KEYS = ["percent", "salt"] as const;

/** The shape a version-1 record carries: one boolean per feature, and a bare percentage. */
const LEGACY_COMPRESSION_VIEW_KEYS = ["version", "features", "canaryPercent"] as const;

const LEGACY_COMPRESSION_FEATURE_KEYS = ["feature", "enabled"] as const;

/**
 * One flag's recorded state.
 *
 * Read by hand rather than through {@link readEnum} because the value domain is
 * not a set of strings: `false`, `true` and `"canary"` are exactly what the
 * configuration file may author, and accepting the string `"false"` here would
 * let a producer that stringified its flags be read as agreeing with this build.
 */
function readFeatureFlagState(
  source: Record<string, unknown>,
  at: string,
  problems: ValidationProblems,
): CompressionFeatureFlagState | undefined {
  const path = joinPath(at, "state");
  if (!Object.hasOwn(source, "state")) {
    problems.add(path, "missing", "required field is missing");
    return undefined;
  }
  const value = source["state"];
  if (value === true || value === false || value === "canary") return value;
  problems.add(
    path,
    "wrong-type",
    `expected true, false or "canary", received ${JSON.stringify(value)}`,
  );
  return undefined;
}

/**
 * The compression flags as the run saw them.
 *
 * Every declared feature must be listed exactly once and in registry order: the
 * view is a statement about the whole registry, and one that named a subset
 * would let a flag disappear from a record without anybody being able to tell
 * whether it was off or unrecorded.
 *
 * The element's state is read by the caller's reader, because that is the one
 * thing the two readable schema versions spell differently.
 */
function readCompressionFeatures(
  source: Record<string, unknown>,
  at: string,
  problems: ValidationProblems,
  elementKeys: readonly string[],
  readState: (
    record: Record<string, unknown>,
    elementPath: string,
  ) => CompressionFeatureFlagState | undefined,
): readonly CompressionConfigFeatureState[] | undefined {
  const states = readList(
    source,
    "features",
    at,
    problems,
    COMPRESSION_FEATURES.length,
    (element, elementPath) => {
      const record = readRecord(element, elementPath, elementKeys, problems);
      if (record === undefined) return undefined;
      const feature = readEnum(record, "feature", elementPath, problems, COMPRESSION_FEATURES);
      const state = readState(record, elementPath);
      return feature === undefined || state === undefined ? undefined : { feature, state };
    },
  );
  if (states === undefined) return undefined;
  const listed = states.map((state) => state.feature);
  if (!isRegistryOrder(listed)) {
    problems.add(
      joinPath(at, "features"),
      "inconsistent",
      `expected every compression feature once, in registry order (${COMPRESSION_FEATURES.join(", ")}), received ${listed.join(", ")}`,
    );
    return undefined;
  }
  return states;
}

function isRegistryOrder(listed: readonly CompressionFeature[]): boolean {
  return (
    listed.length === COMPRESSION_FEATURES.length &&
    listed.every((feature, index) => feature === COMPRESSION_FEATURES[index])
  );
}

/**
 * The recorded canary rollout.
 *
 * The object itself is required while both of its fields are absent-able: a
 * document that declared no rollout still produces the object, so a view missing
 * it was written by something other than this projection.
 */
function readCompressionCanary(
  source: Record<string, unknown>,
  at: string,
  problems: ValidationProblems,
): CompressionConfigCanary | undefined {
  const nested = readNested(source, "canary", at, COMPRESSION_CANARY_KEYS, problems);
  if (nested === undefined) return undefined;
  // Neither field is defaulted: a document that declared no canary percentage did
  // not declare zero, and recording zero would read as a rollout somebody switched
  // off.
  const percent = Object.hasOwn(nested.record, "percent")
    ? readNumber(nested.record, "percent", nested.path, problems, PERCENT_BOUNDS)
    : undefined;
  const salt = Object.hasOwn(nested.record, "salt")
    ? readAuthoredString(nested.record, "salt", nested.path, problems)
    : undefined;
  return { percent, salt };
}

/**
 * A string as the configuration authored it, blank included.
 *
 * Not {@link readString}, which refuses the empty string: a salt is bucketing
 * input, `""` is a value that buckets, and the projection carries authored values
 * through uninterpreted. A reader that refused it would make a record this
 * package itself wrote unreadable.
 */
function readAuthoredString(
  source: Record<string, unknown>,
  key: string,
  at: string,
  problems: ValidationProblems,
): string | undefined {
  const value = source[key];
  if (typeof value === "string") return value;
  problems.add(joinPath(at, key), "wrong-type", "expected a string");
  return undefined;
}

function readCompressionView(
  source: Record<string, unknown>,
  at: string,
  problems: ValidationProblems,
): CompressionConfigView | undefined {
  const nested = readNested(source, "view", at, COMPRESSION_VIEW_KEYS, problems);
  if (nested === undefined) return undefined;
  const version = readViewVersion(nested.record, nested.path, problems);
  const canary = readCompressionCanary(nested.record, nested.path, problems);
  const features = readCompressionFeatures(
    nested.record,
    nested.path,
    problems,
    COMPRESSION_FEATURE_KEYS,
    (record, elementPath) => readFeatureFlagState(record, elementPath, problems),
  );
  if (features === undefined || canary === undefined) return undefined;
  return { version, features, canary };
}

/**
 * The view a version-1 record carries, lifted into the current shape.
 *
 * Nothing is invented in the lift: version 1 stated one boolean per feature, so a
 * `true` becomes `true` and a `false` becomes `false` — which is exactly, and
 * only, what that record ever claimed. A run whose configuration said `"canary"`
 * was recorded as `false` by the build that wrote it, and no reader can recover
 * from the view what the view never held; the digest stored beside it is what
 * still identifies the document itself. The salt is `undefined` because that
 * shape had no field for one, which is the whole truth about it.
 */
function readLegacyCompressionView(
  source: Record<string, unknown>,
  at: string,
  problems: ValidationProblems,
): CompressionConfigView | undefined {
  const nested = readNested(source, "view", at, LEGACY_COMPRESSION_VIEW_KEYS, problems);
  if (nested === undefined) return undefined;
  const version = readViewVersion(nested.record, nested.path, problems);
  const percent = Object.hasOwn(nested.record, "canaryPercent")
    ? readNumber(nested.record, "canaryPercent", nested.path, problems, PERCENT_BOUNDS)
    : undefined;
  const features = readCompressionFeatures(
    nested.record,
    nested.path,
    problems,
    LEGACY_COMPRESSION_FEATURE_KEYS,
    (record, elementPath) => readBoolean(record, "enabled", elementPath, problems),
  );
  if (features === undefined) return undefined;
  return { version, features, canary: { percent, salt: undefined } };
}

type ViewReader = (
  source: Record<string, unknown>,
  at: string,
  problems: ValidationProblems,
) => CompressionConfigView | undefined;

/**
 * The shape one record version defines for its view, or `undefined` for a version
 * that defines none. Enumerated rather than defaulted to the current shape: a
 * version added to the readable list without a reader here must fail loudly, not
 * be read as whatever this build happens to write today.
 */
function viewReaderFor(schemaVersion: number): ViewReader | undefined {
  if (schemaVersion === RUN_IDENTITY_RECORD_SCHEMA_VERSION) return readCompressionView;
  if (schemaVersion === LEGACY_RECORD_SCHEMA_VERSION) return readLegacyCompressionView;
  return undefined;
}

/** The registry version the view declares; absent stays absent, as it does in the projection. */
function readViewVersion(
  source: Record<string, unknown>,
  at: string,
  problems: ValidationProblems,
): number | undefined {
  return Object.hasOwn(source, "version")
    ? readInteger(source, "version", at, problems, VERSION_NUMBER_BOUNDS)
    : undefined;
}

/**
 * The recorded compression configuration.
 *
 * The digest is read by hand rather than through the shared digest reader because
 * its one legal non-digest value carries meaning: `""` states that there was
 * nothing to digest, and it is accepted exactly when the state says so. Accepting
 * it under `read` would let a record claim it read a configuration it never
 * identified.
 */
export function readCompressionConfig(
  source: Record<string, unknown>,
  at: string,
  problems: ValidationProblems,
  schemaVersion: number,
): RecordedCompressionConfig | undefined {
  const nested = readNested(source, "compressionConfig", at, COMPRESSION_CONFIG_KEYS, problems);
  if (nested === undefined) return undefined;
  const state = readEnum(nested.record, "state", nested.path, problems, COMPRESSION_CONFIG_STATES);
  const configSource = readString(nested.record, "source", nested.path, problems);
  // The version the record states decides which shape is read, and nothing else
  // does: sniffing the fields would let a record be read under whichever shape
  // happened to fit, which is how a v1 `false` could be mistaken for a v2 one.
  const readView = viewReaderFor(schemaVersion);
  if (readView === undefined) {
    problems.add(
      nested.path,
      "unsupported-schema-version",
      `no view shape is defined for record schema version ${schemaVersion}`,
    );
    return undefined;
  }
  const view = Object.hasOwn(nested.record, "view")
    ? readView(nested.record, nested.path, problems)
    : undefined;

  const digest = readRecordedDigest(nested.record, nested.path, state, problems);

  if (state === undefined || configSource === undefined || digest === undefined) return undefined;
  if (Object.hasOwn(nested.record, "view") && view === undefined) return undefined;
  return { state, source: configSource, digest, ...(view === undefined ? {} : { view }) };
}

function readRecordedDigest(
  source: Record<string, unknown>,
  at: string,
  state: RecordedCompressionConfig["state"] | undefined,
  problems: ValidationProblems,
): string | undefined {
  const path = joinPath(at, "digest");
  const raw = source["digest"];
  if (!Object.hasOwn(source, "digest")) {
    problems.add(path, "missing", "required field is missing");
    return undefined;
  }
  if (typeof raw !== "string") {
    problems.add(path, "wrong-type", "expected a string");
    return undefined;
  }
  if (state === "read") {
    if (CANONICAL_DIGEST_PATTERN.test(raw)) return raw;
    problems.add(
      path,
      "malformed",
      `a configuration that was read is digested; expected sha256:<64 hex characters>, received ${JSON.stringify(raw)}`,
    );
    return undefined;
  }
  if (raw === "") return raw;
  problems.add(
    path,
    "inconsistent",
    `state "${String(state)}" read no document, so it can carry no digest, yet ${JSON.stringify(raw)} is recorded`,
  );
  return undefined;
}
