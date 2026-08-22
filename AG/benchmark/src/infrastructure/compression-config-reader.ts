import { lstat, readFile } from "node:fs/promises";
import path from "node:path";

import type {
  CompressionConfigPort,
  RecordedCompressionConfig,
} from "../application/ports/compression-config-port.js";
import {
  COMPRESSION_CONFIG_SOURCE,
  computeCompressionConfigDigest,
  projectCompressionConfigView,
} from "../domain/compression/config-identity.js";
import { BENCHMARK_PACKAGE_ROOT } from "./benchmark-workspace-paths.js";

/**
 * Reads the compression configuration of the repository under measurement (task
 * 1205).
 *
 * The file is deliberately outside this package: it belongs to the tree the
 * benchmark measures, not to the benchmark. So it is not resolved through
 * `resolveInsideBenchmarkWorkspace` — that guard exists for paths that arrive as
 * data, and every segment used here is a module constant. The repository root
 * can be overridden for a test; nothing a scenario, a sample or a CLI flag says
 * ever reaches this path.
 *
 * ## It cannot fail a run
 *
 * What it produces is provenance, and provenance that aborted a run would cost a
 * measurement to learn nothing. Every failure — no file, a directory, a symlink,
 * a file too large, bytes that are not JSON — becomes a state on the record, and
 * the run continues with a record that honestly says the configuration was not
 * read. What it must never do is answer with a plausible default: a recorded
 * configuration nobody had is exactly the fabricated provenance BENCH-8 forbids.
 */

/**
 * Where the repository root sits relative to this package: `AG/benchmark` is two
 * directories below it. Resolved from the module rather than from
 * `process.cwd()`, for the reason `benchmark-workspace-paths.ts` states — the
 * runner is started from the repository root on CI and from anywhere else by a
 * developer.
 */
export const DEFAULT_REPOSITORY_ROOT = path.resolve(BENCHMARK_PACKAGE_ROOT, "..", "..");

/**
 * A flag registry file is a few hundred bytes. The ceiling only exists so a
 * mistake — a log rotated onto this name, a truncated download — is refused
 * instead of being parsed.
 */
const DEFAULT_MAX_BYTES = 64 * 1024;

export interface CompressionConfigReaderOptions {
  /** Directory `vq/config/context-compression.json` is resolved against. */
  readonly repositoryRoot?: string;
  /** Size ceiling; a larger file is recorded as unreadable rather than parsed. */
  readonly maxBytes?: number;
}

export class NodeCompressionConfigReader implements CompressionConfigPort {
  readonly #filePath: string;
  readonly #maxBytes: number;

  constructor(options: CompressionConfigReaderOptions = {}) {
    this.#filePath = path.resolve(
      options.repositoryRoot ?? DEFAULT_REPOSITORY_ROOT,
      ...COMPRESSION_CONFIG_SOURCE.split("/"),
    );
    this.#maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  }

  /** Absolute path this reader reads, for diagnostics; never stored in a record. */
  get filePath(): string {
    return this.#filePath;
  }

  async read(): Promise<RecordedCompressionConfig> {
    try {
      // `lstat`: a symlink is not the configuration file, and following one would
      // digest a document from somewhere the repository does not name.
      const stats = await lstat(this.#filePath);
      if (!stats.isFile() || stats.size > this.#maxBytes) return unreadable();
      const document = JSON.parse(await readFile(this.#filePath, "utf8")) as unknown;
      return {
        state: "read",
        source: COMPRESSION_CONFIG_SOURCE,
        digest: computeCompressionConfigDigest(document),
        view: projectCompressionConfigView(document),
      };
    } catch (error: unknown) {
      // A configuration that is not there is a state of the tree — the
      // orchestrator then runs on its built-in defaults — and is recorded as
      // such. Everything else is a file this reader could not turn into a
      // document, which is a different statement and is recorded as one.
      return isFileNotFound(error) ? absent() : unreadable();
    }
  }
}

function isFileNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

/** No digest, because there was no document: `""` is the absence of one, not a hash of nothing. */
function absent(): RecordedCompressionConfig {
  return { state: "absent", source: COMPRESSION_CONFIG_SOURCE, digest: "" };
}

function unreadable(): RecordedCompressionConfig {
  return { state: "unreadable", source: COMPRESSION_CONFIG_SOURCE, digest: "" };
}
