import { lstat, mkdir, open, readFile } from "node:fs/promises";
import path from "node:path";

import type {
  RunIdentityRecord,
  RunIdentityStorePort,
} from "../application/ports/run-identity-store-port.js";
import { RunIdentityIntegrityError } from "../application/run/recorded-run-identity.js";
import {
  BENCHMARK_PACKAGE_ROOT,
  resolveInsideBenchmarkWorkspace,
} from "./benchmark-workspace-paths.js";
import { runIdentityPath } from "./run-ledger-store.js";

/**
 * The identity sidecar of one run ledger, as a JSON document (task 1205).
 *
 * One file per run, written once, before the first sample. Three properties make
 * it usable as evidence rather than as a note beside the numbers.
 *
 * **It cannot be restated.** The file is created with `wx`, so a second write
 * for the same run fails instead of replacing the identity the stored samples
 * were measured under. A run that could re-state its provenance could re-label
 * measurements it had already taken.
 *
 * **It is durable before the run continues.** One write, then `fsync`. The
 * pipeline records the identity before the first cell precisely so that a host
 * that loses power leaves either nothing or an attributable ledger; a record
 * still sitting in the page cache would not deliver that.
 *
 * **What it refuses, it refuses loudly.** A missing file is a run from before
 * this record existed and reads as `undefined`. Anything else — a directory, a
 * symlink, a file too large to be this document, bytes that are not JSON — is
 * raised as {@link RunIdentityIntegrityError}, because the alternative is
 * treating damaged provenance as absent provenance and re-deriving the
 * methodology of the package as it stands today.
 */

/**
 * A ceiling on a document that holds one configuration, one host capture and
 * five hashes. It exists so a truncated disk, a log accidentally written to this
 * name or a hostile file cannot be read into memory whole before it is rejected.
 */
const MAX_RECORD_BYTES = 1024 * 1024;

function isFileNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function isAlreadyExists(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === "EEXIST"
  );
}

export class JsonRunIdentityStore implements RunIdentityStorePort {
  readonly #filePath: string;

  /**
   * `ledgerPath` is the run's sample ledger, not the sidecar: the two names are
   * derived from one path so a caller cannot pair one run's identity with
   * another run's samples. The path is data — a CLI flag or a computed run id —
   * so it is resolved against the workspace root before anything opens it.
   */
  constructor(ledgerPath: string, root: string = BENCHMARK_PACKAGE_ROOT) {
    this.#filePath = resolveInsideBenchmarkWorkspace(runIdentityPath(ledgerPath), root);
  }

  /** Absolute path of the sidecar this store writes, for reports and diagnostics. */
  get filePath(): string {
    return this.#filePath;
  }

  async record(record: RunIdentityRecord): Promise<void> {
    // Indented: this file is read by a person diagnosing a comparison that was
    // refused, and the run it describes is written once, so nothing is gained by
    // packing it.
    const payload = Buffer.from(`${JSON.stringify(record, null, 2)}\n`, "utf8");
    await mkdir(path.dirname(this.#filePath), { recursive: true });

    let handle;
    try {
      handle = await open(this.#filePath, "wx");
    } catch (error) {
      if (isAlreadyExists(error)) {
        throw new Error(
          `Run "${record.runId}" has already recorded its identity at "${this.#filePath}"; ` +
            "a run states what it measured once, and overwriting it would re-attribute the samples stored beside it.",
          { cause: error },
        );
      }
      throw error;
    }

    try {
      const { bytesWritten } = await handle.write(payload);
      if (bytesWritten !== payload.byteLength) {
        throw new Error(`wrote ${bytesWritten} of ${payload.byteLength} bytes`);
      }
      // Without this the record is only in the page cache, and a host that loses
      // power reports a ledger whose provenance was never written.
      await handle.sync();
    } catch (error) {
      throw new Error(
        `Recording the identity of run "${record.runId}" at "${this.#filePath}" failed; the run stored no sample.`,
        { cause: error },
      );
    } finally {
      await handle.close();
    }
  }

  async readDocument(): Promise<unknown> {
    let stats;
    try {
      // `lstat`, so a symlink is refused rather than followed: this path is
      // derived from a caller-supplied ledger name, and following a link would
      // read a document from outside the workspace the path was checked against.
      stats = await lstat(this.#filePath);
    } catch (error) {
      if (isFileNotFound(error)) return undefined;
      throw error;
    }
    if (!stats.isFile()) {
      throw new RunIdentityIntegrityError([
        `"${this.#filePath}" is not a regular file, so it is not the record this run wrote`,
      ]);
    }
    if (stats.size > MAX_RECORD_BYTES) {
      throw new RunIdentityIntegrityError([
        `"${this.#filePath}" is ${stats.size} bytes, past the ${MAX_RECORD_BYTES}-byte ceiling for a run identity record`,
      ]);
    }

    let text: string;
    try {
      text = await readFile(this.#filePath, "utf8");
    } catch (error) {
      // A file that vanished between the two calls is a run whose record is
      // gone, which is damage rather than the absence a legacy ledger has.
      if (isFileNotFound(error)) {
        throw new RunIdentityIntegrityError([
          `"${this.#filePath}" disappeared while it was being read`,
        ]);
      }
      throw error;
    }

    try {
      return JSON.parse(text) as unknown;
    } catch (error) {
      throw new RunIdentityIntegrityError([
        `"${this.#filePath}" is not a JSON document: ${(error as Error).message}`,
      ]);
    }
  }
}
