import { mkdir, open, readFile, type FileHandle } from "node:fs/promises";
import path from "node:path";

import type {
  SampleStorePort,
  UnmeasuredCellRecord,
} from "../application/ports/sample-store-port.js";
import {
  BenchmarkSampleRejectedError,
  SampleLedgerIntegrityError,
  describeValidationProblem,
} from "../application/sample-ledger.js";
import { redactSecretsDeep } from "../application/secret-redaction.js";
import type { BenchmarkSample } from "../domain/result.js";
import { validateBenchmarkSample } from "../domain/schema-validation.js";
import {
  BENCHMARK_PACKAGE_ROOT,
  resolveInsideBenchmarkWorkspace,
} from "./benchmark-workspace-paths.js";

/**
 * The canonical sample ledger: one JSON document per line, appended in the order
 * the runs finished (BENCH-5).
 *
 * JSON Lines is chosen for what it does when a run dies. A single JSON array
 * would have to be rewritten whole on every sample, so a crash during the
 * rewrite loses every earlier measurement; here a crash can damage at most the
 * record being written, and the records before it are already durable bytes.
 *
 * Three rules give the file its meaning:
 *
 * 1. **A record is validated before it is written.** The store refuses a sample
 *    its own reader would reject, so an unreadable line is evidence of a fault
 *    rather than of a writer that disagreed with the schema.
 * 2. **A record is written by one `write` call, followed by `fsync`, and rolled
 *    back if that call does not complete.** What is in the file is what was
 *    fully written — and a ledger that already ends mid-record is refused rather
 *    than appended to.
 * 3. **A line that is not a valid sample is reported, never skipped.** Including
 *    a final line with no terminating newline, which is precisely the shape an
 *    interrupted append leaves behind. The authoritative path
 *    (`readAuthoritativeSamples`) turns any such report into an error.
 *
 * The store assumes a single writing process per file, which the sequential
 * runner of this version guarantees (design §Priklausomybių tvarka). Appends and
 * reads issued against one instance are serialised internally, so concurrent
 * callers cannot interleave a record or read a file mid-rollback.
 */

/** Default ledger location, workspace-relative like every other path this package resolves. */
export const DEFAULT_SAMPLE_LEDGER_PATH = "results/samples.jsonl";

function isFileNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

/**
 * Redacts, validates and serialises one sample.
 *
 * Redaction runs first and validation second, so a redaction that damaged a
 * field fails the append loudly instead of storing a record that no longer means
 * what it says. `JSON.stringify` escapes every control character, which is what
 * makes "one record per line" a property of the format rather than a hope.
 */
function serializeSample(sample: BenchmarkSample): string {
  const result = validateBenchmarkSample(redactSecretsDeep(sample));
  if (!result.ok) throw new BenchmarkSampleRejectedError(result.problems);
  return JSON.stringify(result.value);
}

/**
 * Refuses to append onto a ledger whose last record has no terminating newline.
 *
 * That file state is what an interrupted append leaves behind, and appending
 * anyway would fuse the truncated record and the new one into a single
 * unreadable line — turning one lost sample into two. Failing here surfaces the
 * damage at the moment it can still be attributed to the run that caused it,
 * which is the same stance the read path takes.
 */
async function assertLastRecordTerminated(
  handle: FileHandle,
  size: number,
  filePath: string,
): Promise<void> {
  if (size === 0) return;
  const tail = Buffer.alloc(1);
  await handle.read(tail, 0, 1, size - 1);
  if (tail[0] === 0x0a) return;
  throw new SampleLedgerIntegrityError([
    `"${filePath}" ends mid-record at byte ${size}: an earlier append did not complete, and appending onto it would make both records unreadable`,
  ]);
}

export class JsonlSampleStore implements SampleStorePort {
  readonly #filePath: string;
  /** Tail of the serialised operation chain; see {@link JsonlSampleStore.#enqueue}. */
  #tail: Promise<unknown> = Promise.resolve();

  constructor(
    ledgerPath: string = DEFAULT_SAMPLE_LEDGER_PATH,
    root: string = BENCHMARK_PACKAGE_ROOT,
  ) {
    // The ledger path is data — a CLI flag or a config field — so it is resolved
    // against the workspace root before anything opens it.
    this.#filePath = resolveInsideBenchmarkWorkspace(ledgerPath, root);
  }

  /** Absolute path of the ledger this store writes, for reports and diagnostics. */
  get filePath(): string {
    return this.#filePath;
  }

  async append(sample: BenchmarkSample): Promise<void> {
    const line = serializeSample(sample);
    return this.#enqueue(() => this.#appendLine(line));
  }

  async readAll(): Promise<{
    readonly samples: readonly BenchmarkSample[];
    readonly corruptRecords: readonly string[];
  }> {
    return this.#enqueue(() => this.#readAll());
  }

  async appendUnmeasured(record: UnmeasuredCellRecord): Promise<void> {
    const line = JSON.stringify(redactSecretsDeep(record));
    return this.#enqueue(() => this.#appendUnmeasuredLine(line));
  }

  /**
   * Sidecar beside the sample ledger, one JSON document per line like the ledger
   * itself. Named so it is never mistaken for one: `findLatestRunLedger` matches
   * only the bare `run-….jsonl` shape, and this file's name is never that shape.
   */
  get #unmeasuredFilePath(): string {
    return this.#filePath.endsWith(".jsonl")
      ? `${this.#filePath.slice(0, -".jsonl".length)}.unmeasured.jsonl`
      : `${this.#filePath}.unmeasured.jsonl`;
  }

  async #appendUnmeasuredLine(line: string): Promise<void> {
    const payload = Buffer.from(`${line}\n`, "utf8");
    const filePath = this.#unmeasuredFilePath;
    await mkdir(path.dirname(filePath), { recursive: true });
    const handle = await open(filePath, "a");
    try {
      await handle.write(payload);
      // Same reason as the sample ledger: without this the record only exists in
      // the page cache, and a host that loses power reports a timeout that left
      // no trace of having happened either.
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  /**
   * Runs `operation` after every operation already issued on this store. The
   * chain continues past a failure — one refused sample must not wedge the
   * ledger — while the caller still receives that failure.
   */
  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(operation, operation);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async #appendLine(line: string): Promise<void> {
    const payload = Buffer.from(`${line}\n`, "utf8");
    await mkdir(path.dirname(this.#filePath), { recursive: true });
    // `a+` rather than `a`: writes still always land at the end, and the handle
    // can also be read, which is how the terminator check below sees the file
    // exactly as it will be written to.
    const handle = await open(this.#filePath, "a+");
    try {
      const { size } = await handle.stat();
      await assertLastRecordTerminated(handle, size, this.#filePath);
      try {
        const { bytesWritten } = await handle.write(payload);
        if (bytesWritten !== payload.byteLength) {
          throw new Error(`wrote ${bytesWritten} of ${payload.byteLength} bytes`);
        }
        // Without this the record is only in the page cache, and a host that
        // loses power reports a run that left no trace of having happened.
        await handle.sync();
      } catch (error) {
        // Roll back to the last durable byte. A half-written record is worse
        // than a missing one: the missing sample is visibly absent, while the
        // half-written one would be read as corruption of the whole ledger.
        await handle.truncate(size).catch(() => undefined);
        throw new Error(
          `Appending a sample to "${this.#filePath}" failed; the ledger was rolled back to its previous ${size} bytes.`,
          { cause: error },
        );
      }
    } finally {
      await handle.close();
    }
  }

  async #readAll(): Promise<{
    readonly samples: readonly BenchmarkSample[];
    readonly corruptRecords: readonly string[];
  }> {
    let text: string;
    try {
      text = await readFile(this.#filePath, "utf8");
    } catch (error) {
      // A ledger that does not exist yet holds no samples. Any other read
      // failure is a real fault and is raised rather than reported as empty.
      if (isFileNotFound(error)) return { samples: [], corruptRecords: [] };
      throw error;
    }

    const samples: BenchmarkSample[] = [];
    const corruptRecords: string[] = [];
    if (text === "") return { samples, corruptRecords };

    const lines = text.split("\n");
    // Everything after the final newline. A complete ledger ends with one, so
    // anything here is a record whose write never finished.
    const unterminated = lines.pop() ?? "";
    if (unterminated !== "") {
      corruptRecords.push(
        `line ${lines.length + 1}: truncated: the record has no terminating newline, so the append that wrote it did not complete`,
      );
    }

    lines.forEach((line, index) => {
      const at = `line ${index + 1}`;
      if (line.trim() === "") {
        corruptRecords.push(`${at}: blank: the ledger holds exactly one record per line`);
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (error) {
        corruptRecords.push(`${at}: malformed JSON: ${(error as Error).message}`);
        return;
      }
      const validated = validateBenchmarkSample(parsed);
      if (!validated.ok) {
        corruptRecords.push(`${at}: ${validated.problems.map(describeValidationProblem).join("; ")}`);
        return;
      }
      samples.push(validated.value);
    });

    return { samples, corruptRecords };
  }
}
