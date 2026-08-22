import type { CompressionConfigView } from "../../domain/compression/config-identity.js";

/**
 * Reading the compression configuration a run executes under (BENCH-8, task
 * 1205).
 *
 * `vq/config/context-compression.json` lives outside this package, in the tree
 * under measurement, so reading it is infrastructure work and what a run records
 * about it is application work. The port is that seam.
 *
 * The state is part of the record rather than a failure mode. A configuration
 * that could not be read is a fact about the run — "these numbers were produced
 * without knowing which compression features were on" — and it is worth
 * recording exactly because it weakens what may later be claimed from the
 * samples. Turning it into an exception would either abort a run over provenance
 * or, worse, invite a caller to substitute a default and record a configuration
 * nobody had.
 */

export const COMPRESSION_CONFIG_STATES = ["read", "absent", "unreadable"] as const;

/**
 * - `read`: the document was parsed and is digested below.
 * - `absent`: the file does not exist, which is a configuration state of its own
 *   — the orchestrator then runs on its built-in defaults.
 * - `unreadable`: the file exists and could not be turned into a document.
 */
export type CompressionConfigState = (typeof COMPRESSION_CONFIG_STATES)[number];

/** What a run records about the compression configuration it executed under. */
export interface RecordedCompressionConfig {
  readonly state: CompressionConfigState;
  /** Repo-relative, as `COMPRESSION_CONFIG_SOURCE` states it: a stored artefact never names a host path. */
  readonly source: string;
  /**
   * Canonical digest of the whole document, and `""` exactly when `state` is not
   * `read`. Empty is not a digest of nothing: it is the absence of one, and the
   * state beside it says why.
   */
  readonly digest: string;
  /** The flags this package knows, when there was a document to read them from. */
  readonly view?: CompressionConfigView;
}

export interface CompressionConfigPort {
  /**
   * Provenance only. Never throws: what it produces gates nothing, and every way
   * of failing is already expressible as a {@link CompressionConfigState}.
   */
  read(): Promise<RecordedCompressionConfig>;
}
