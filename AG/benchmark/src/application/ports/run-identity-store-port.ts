import type { BenchmarkIdentity } from "../../domain/baseline.js";
import type { BenchmarkSuiteConfig } from "../../domain/suite-config.js";
import type { RunEnvironmentRecord } from "../run-environment.js";
import type { RecordedCompressionConfig } from "./compression-config-port.js";

/**
 * What a run stores about its own identity, and where (BENCH-8, task 1205).
 *
 * A sample carries measurements; it does not carry the methodology those
 * measurements were taken under, and it cannot be made to — the stored-sample
 * schema is fixed and refuses a record with a field it does not define. So the
 * identity of a run is stored once, beside its ledger, before the first sample
 * is written.
 *
 * ## Why the record is self-verifying
 *
 * It carries the configuration document its `configHash` was taken over, not
 * only the hash. A reader recomputes the digest and refuses the record when the
 * two disagree, which turns "somebody edited the sidecar" from an
 * undetectable re-labelling of a run into a refusal. `environment` is stored for
 * the same reason: sealing a baseline re-captures the host otherwise, and a
 * baseline created on another day would then describe the machine that sealed it
 * rather than the machine that measured.
 *
 * ## Absence means legacy, invalid never does
 *
 * A ledger written before this record existed has none, and every consumer keeps
 * its previous behaviour for it. A record that exists and cannot be read is a
 * different thing entirely: it is evidence that the provenance of those samples
 * is unknown, and it is raised rather than degraded to the legacy path.
 */

/**
 * Version 2 (task 0039): `compressionConfig.view` carries a tri-state `state` per
 * feature and a `canary` object instead of a boolean `enabled` and a bare
 * `canaryPercent`. A record written under version 1 is a record of another
 * version — readable as history, never as a version-2 document.
 */
export const RUN_IDENTITY_RECORD_SCHEMA_VERSION = 2;

/**
 * Every version a stored record may still be read under, newest first in meaning
 * but ascending here so the list reads as a history.
 *
 * A sidecar is written once, beside a run, and is never rewritten: rewriting one
 * would re-attribute samples that are already stored. So a schema move cannot be
 * a migration, and a reader that knew only the current version would turn every
 * run measured before the move into "provenance unknown" — the loudest possible
 * report of nothing being wrong.
 *
 * Version 1's view stated a boolean per feature, so what it says about a flag is
 * "production-enabled or not"; a `"canary"` rollout is not distinguishable in it,
 * and the digest beside it stays the authority on what the file actually said.
 */
export const READABLE_RUN_IDENTITY_RECORD_SCHEMA_VERSIONS: readonly number[] = [
  1,
  RUN_IDENTITY_RECORD_SCHEMA_VERSION,
];

export interface RunIdentityRecord {
  readonly schemaVersion: number;
  /** The run whose ledger this record sits beside, as `createRunId` formed it. */
  readonly runId: string;
  /** ISO-8601 UTC, supplied by the caller: this layer reads no clock. */
  readonly recordedAt: string;
  readonly identity: BenchmarkIdentity;
  /** The exact document `identity.configHash` was taken over; the record is self-verifying. */
  readonly config: BenchmarkSuiteConfig;
  /** The host as it was captured for this run, not as it stands when the record is read. */
  readonly environment: RunEnvironmentRecord;
  /** Provenance of the compression configuration; it gates nothing. */
  readonly compressionConfig: RecordedCompressionConfig;
}

/**
 * Bound to one run's ledger, exactly as `SampleStorePort` is bound to one file.
 * A store that took a run id per call could be handed one run's identity and
 * another run's samples, which is the confusion the whole record exists to
 * prevent.
 */
export interface RunIdentityStorePort {
  /**
   * Writes this run's record. Refuses to overwrite one that already exists: a
   * run states its identity once, and a second statement would silently
   * re-attribute samples that are already stored.
   */
  record(record: RunIdentityRecord): Promise<void>;
  /**
   * The stored document exactly as it was written, or `undefined` when this run
   * recorded none. Unvalidated on purpose — validation is a rule, and a rule
   * belongs above the adapter that reads bytes.
   */
  readDocument(): Promise<unknown>;
}
