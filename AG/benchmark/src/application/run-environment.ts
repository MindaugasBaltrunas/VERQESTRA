import type { BenchmarkEnvironment } from "../domain/baseline.js";
import type { EnvironmentPort } from "./ports/environment-port.js";

/**
 * The host provenance a run is recorded under (BENCH-8).
 *
 * `BenchmarkEnvironment` carries the facts a comparison weighs — platform,
 * architecture, Node version, core count. This record adds the facts that say
 * *which code* produced the numbers: the Git commit of the working tree the run
 * executed against, the operating system release, and the versions of the tools
 * the scenario checks are executed with. A baseline without them can be compared
 * arithmetically and attributed to nothing.
 *
 * What is deliberately absent is as much of the contract as what is present. No
 * environment variables, no user or host name, no command line: an environment
 * capture is the most tempting place to dump everything the process can see, and
 * the one place where doing so would write a credential into a file that is
 * committed with the baseline.
 *
 * The port lives beside the record because it exists only to produce it.
 */

/** A tool whose version can move a measurement, and the version string it reported. */
export interface ToolVersion {
  readonly tool: string;
  /** Raw first line as the tool printed it, redacted and length-bounded. */
  readonly version: string;
}

/** Reported when a tool is not installed, not reachable, or refused to answer. */
export const UNAVAILABLE_TOOL_VERSION = "unavailable";

export interface RunEnvironmentRecord {
  readonly environment: BenchmarkEnvironment;
  /** Operating system type and release, e.g. `Windows_NT 10.0.26200`. Never the host name. */
  readonly osRelease: string;
  /**
   * Full Git object id of the tree under measurement, or `""` when the host
   * could not identify it. Empty is not "unchanged": it means the run cannot be
   * attributed to a commit, which BENCH-8 treats as an incomparable baseline
   * rather than a matching one.
   */
  readonly agCommit: string;
  /** In a fixed order, so two captures of the same host serialise identically. */
  readonly toolVersions: readonly ToolVersion[];
}

/** {@link EnvironmentPort} plus the provenance a baseline is recorded with. */
export interface RunEnvironmentPort extends EnvironmentPort {
  captureRunEnvironment(): Promise<RunEnvironmentRecord>;
}
