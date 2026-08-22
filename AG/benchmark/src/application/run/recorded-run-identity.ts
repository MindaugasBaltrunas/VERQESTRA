import type { BenchmarkEnvironment, BenchmarkIdentity } from "../../domain/baseline.js";
import { CANONICAL_DIGEST_PATTERN } from "../../domain/baseline/canonical-json.js";
import { computeSuiteConfigHash, freezeDeep } from "../../domain/baseline/manifest.js";
import { EXECUTION_MODES, type ExecutionMode } from "../../domain/result.js";
import { validateSuiteConfig } from "../../domain/schema-validation.js";
import type { BenchmarkSuiteConfig } from "../../domain/suite-config.js";
import {
  IDENTIFIER_PATTERN,
  ValidationProblems,
  readInteger,
  readList,
  readMatching,
  readRecord,
  readSchemaVersionIn,
  readString,
  toValidationResult,
  type ValidationResult,
} from "../../domain/validation.js";
import {
  READABLE_RUN_IDENTITY_RECORD_SCHEMA_VERSIONS,
  type RunIdentityRecord,
  type RunIdentityStorePort,
} from "../ports/run-identity-store-port.js";
import type { RunEnvironmentRecord, ToolVersion } from "../run-environment.js";
import { describeValidationProblem } from "../sample-ledger.js";
import { readNested } from "./nested-record-reader.js";
import { readCompressionConfig } from "./recorded-compression-config.js";

/**
 * Reading back what a run recorded about itself (BENCH-8, task 1205).
 *
 * The write side is a single statement made once per run; this is the side that
 * decides whether that statement may be believed months later. It is fail-closed
 * in the same sense `sample-ledger.ts` is: a record that exists and cannot be
 * read is refused rather than skipped, because "this run's provenance is
 * unknown" and "this run recorded no provenance" call for different answers and
 * only the first one is evidence of damage.
 *
 * ## The three ways a record is judged
 *
 * 1. **Shape.** Every field is read from `unknown` and every unknown key is
 *    refused, exactly as the stored-sample and baseline schemas are read.
 * 2. **Self-consistency.** The stored configuration is re-hashed and checked
 *    against the stored `configHash`. A record whose hash does not describe its
 *    own configuration document has been edited or was written by a producer
 *    that disagreed with this build, and either way it may not identify a run.
 * 3. **Nothing invented.** No field is defaulted and no missing value is
 *    repaired. A repaired provenance record is worse than none: it reads as
 *    something somebody observed.
 *
 * The compression sub-document is read by `recorded-compression-config.ts`: it
 * has a schema of its own — a tri-state flag registry and a canary rollout — and
 * it is the part that moves when the compression projection changes.
 */

/**
 * ISO-8601 in UTC. A local-time stamp cannot be ordered against one from another
 * machine; `domain/baseline/document.ts` states the same rule for a stored
 * baseline, in the layer that owns that document's schema.
 */
const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

/** A host reports at least one usable core; the ceiling only rejects a number that is not a core count. */
const CPU_COUNT_BOUNDS = { min: 1, max: 4096 } as const;

const RECORD_KEYS = [
  "schemaVersion",
  "runId",
  "recordedAt",
  "identity",
  "config",
  "environment",
  "compressionConfig",
] as const;

const IDENTITY_KEYS = [
  "suiteHash",
  "configHash",
  "policyHash",
  "agCommit",
  "modeAdapterVersions",
] as const;

const ENVIRONMENT_RECORD_KEYS = ["environment", "osRelease", "agCommit", "toolVersions"] as const;

const ENVIRONMENT_KEYS = ["platform", "arch", "nodeVersion", "cpuCount"] as const;

const TOOL_VERSION_KEYS = ["tool", "version"] as const;

/** Raised when a run recorded an identity that cannot be trusted to describe it. */
export class RunIdentityIntegrityError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(
      `The run identity record is not readable, so the samples beside it cannot be attributed: ${problems.join(
        "; ",
      )}`,
    );
    this.name = "RunIdentityIntegrityError";
  }
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
    const version = readString(nested.record, mode, nested.path, problems);
    if (version !== undefined) entries.push([mode, version]);
  }
  if (entries.length !== EXECUTION_MODES.length) return undefined;
  // Total by construction: the loop above visited every declared mode.
  return Object.fromEntries(entries) as Readonly<Record<ExecutionMode, string>>;
}

/**
 * The recorded hashes.
 *
 * Every hash must be a canonical digest and the commit must be named: a run that
 * recorded no tree cannot be attributed to one, and the comparability gate would
 * refuse it anyway — refusing it here says so at the moment the record is read
 * rather than at a comparison that is missing half its evidence.
 */
function readIdentity(
  source: Record<string, unknown>,
  at: string,
  problems: ValidationProblems,
): BenchmarkIdentity | undefined {
  const nested = readNested(source, "identity", at, IDENTITY_KEYS, problems);
  if (nested === undefined) return undefined;
  const suiteHash = readDigest(nested.record, "suiteHash", nested.path, problems);
  const configHash = readDigest(nested.record, "configHash", nested.path, problems);
  const policyHash = readDigest(nested.record, "policyHash", nested.path, problems);
  const agCommit = readString(nested.record, "agCommit", nested.path, problems);
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

function readEnvironment(
  source: Record<string, unknown>,
  at: string,
  problems: ValidationProblems,
): BenchmarkEnvironment | undefined {
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
): readonly ToolVersion[] | undefined {
  return readList(source, "toolVersions", at, problems, 0, (element, elementPath) => {
    const record = readRecord(element, elementPath, TOOL_VERSION_KEYS, problems);
    if (record === undefined) return undefined;
    const tool = readString(record, "tool", elementPath, problems);
    const version = readString(record, "version", elementPath, problems);
    return tool === undefined || version === undefined ? undefined : { tool, version };
  });
}

/** The host capture as the run stored it, not as the reading machine looks now. */
function readEnvironmentRecord(
  source: Record<string, unknown>,
  at: string,
  problems: ValidationProblems,
): RunEnvironmentRecord | undefined {
  const nested = readNested(source, "environment", at, ENVIRONMENT_RECORD_KEYS, problems);
  if (nested === undefined) return undefined;
  const environment = readEnvironment(nested.record, nested.path, problems);
  const osRelease = readString(nested.record, "osRelease", nested.path, problems);
  const agCommit = readString(nested.record, "agCommit", nested.path, problems);
  const toolVersions = readToolVersions(nested.record, nested.path, problems);
  if (
    environment === undefined ||
    osRelease === undefined ||
    agCommit === undefined ||
    toolVersions === undefined
  ) {
    return undefined;
  }
  return { environment, osRelease, agCommit, toolVersions };
}

/**
 * The stored configuration document, read through the same validator an authored
 * one goes through. Its problems are re-reported under `config.` so a reader is
 * told where in the record the fault is rather than where in the sub-document.
 */
function readConfig(
  source: Record<string, unknown>,
  problems: ValidationProblems,
): BenchmarkSuiteConfig | undefined {
  if (!Object.hasOwn(source, "config")) {
    problems.add("config", "missing", "required field is missing");
    return undefined;
  }
  const result = validateSuiteConfig(source["config"]);
  if (result.ok) return result.value;
  for (const problem of result.problems) {
    problems.add(
      problem.path === "" ? "config" : `config.${problem.path}`,
      problem.code,
      problem.message,
    );
  }
  return undefined;
}

/**
 * Reads a stored run identity record, fail-closed.
 *
 * The returned record is sealed: a provenance statement a consumer can edit is a
 * provenance statement nothing may be attributed to.
 */
export function validateRunIdentityRecord(input: unknown): ValidationResult<RunIdentityRecord> {
  const problems = new ValidationProblems();
  const record = readRecord(input, "", RECORD_KEYS, problems);
  if (record === undefined) return toValidationResult<RunIdentityRecord>(undefined, problems);

  // Every version this build genuinely understands, not only the one it writes: a
  // sidecar is never rewritten, so a schema move would otherwise turn every run
  // measured before it into "provenance unknown".
  const schemaVersion = readSchemaVersionIn(
    record,
    "",
    problems,
    READABLE_RUN_IDENTITY_RECORD_SCHEMA_VERSIONS,
  );
  const runId = readMatching(
    record,
    "runId",
    "",
    problems,
    IDENTIFIER_PATTERN,
    "a lowercase kebab-case identifier",
  );
  const recordedAt = readMatching(
    record,
    "recordedAt",
    "",
    problems,
    UTC_TIMESTAMP,
    "an ISO-8601 UTC timestamp like 2026-08-07T09:00:00.000Z",
  );
  const identity = readIdentity(record, "", problems);
  const config = readConfig(record, problems);
  const environment = readEnvironmentRecord(record, "", problems);
  // Read under the version the record states, or not at all: a shape guessed for a
  // record whose version could not be read would report field faults that are
  // artefacts of the guess.
  const compressionConfig =
    schemaVersion === undefined
      ? undefined
      : readCompressionConfig(record, "", problems, schemaVersion);

  // The record identifies a run only if it describes its own configuration. A
  // hash that does not match the document beside it is either an edit or a
  // producer that disagreed with this build's projection, and both re-label a
  // run as something it was not.
  if (config !== undefined && identity !== undefined) {
    const recomputed = computeSuiteConfigHash(config);
    if (recomputed !== identity.configHash) {
      problems.add(
        "identity.configHash",
        "inconsistent",
        `the recorded configuration hashes to ${recomputed}, and the record states ${identity.configHash}; the two describe different runs`,
      );
    }
  }

  if (
    schemaVersion === undefined ||
    runId === undefined ||
    recordedAt === undefined ||
    identity === undefined ||
    config === undefined ||
    environment === undefined ||
    compressionConfig === undefined
  ) {
    return toValidationResult<RunIdentityRecord>(undefined, problems);
  }

  return toValidationResult<RunIdentityRecord>(
    freezeDeep({
      schemaVersion,
      runId,
      recordedAt,
      identity,
      config,
      environment,
      compressionConfig,
    }),
    problems,
  );
}

/**
 * What a run recorded about itself, or `undefined` when it recorded nothing.
 *
 * `undefined` is the legacy answer and the only one a caller may treat as "carry
 * on as before": a ledger written before the run pipeline recorded its identity
 * has no record, and refusing it would make every stored run unreadable at once.
 * A record that exists and is not readable throws, because a caller that fell
 * back to re-deriving the identity would publish the methodology of the package
 * *now* as the methodology those samples were measured under — which is the one
 * substitution BENCH-8 exists to prevent.
 */
export async function readRecordedRunIdentity(
  store: RunIdentityStorePort,
): Promise<RunIdentityRecord | undefined> {
  const document = await store.readDocument();
  if (document === undefined) return undefined;
  const validated = validateRunIdentityRecord(document);
  if (!validated.ok) {
    throw new RunIdentityIntegrityError(validated.problems.map(describeValidationProblem));
  }
  return validated.value;
}
