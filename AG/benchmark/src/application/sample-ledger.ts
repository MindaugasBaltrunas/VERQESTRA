import type { BenchmarkSample } from "../domain/result.js";
import type { ValidationProblem } from "../domain/validation.js";
import type { SampleStorePort } from "./ports/sample-store-port.js";

/**
 * The authoritative read path over stored samples (BENCH-5).
 *
 * `SampleStorePort.readAll` reports corrupt records beside the readable ones,
 * because a diagnostic tool wants to see both. Every path that a number is
 * computed from goes through {@link readAuthoritativeSamples} instead, which
 * refuses the whole ledger the moment one record is unreadable.
 *
 * The distinction matters more than it looks. A corrupt line is not a missing
 * measurement; it is a measurement whose value is unknown. Skipping it silently
 * would shrink the denominator of every rate BENCH-7 defines, and the resulting
 * accepted-rate would be higher precisely when the harness was least reliable —
 * a benchmark that flatters itself for crashing. BENCH-5 therefore states that a
 * corrupt or incomplete record yields an error or `inconclusive`, never a quiet
 * omission, and this module is where that is enforced.
 */

/** Formats one validation problem for a human reading a failure, path first. */
export function describeValidationProblem(problem: ValidationProblem): string {
  return problem.path === ""
    ? `${problem.code}: ${problem.message}`
    : `${problem.path}: ${problem.code}: ${problem.message}`;
}

/** How many corrupt records a message lists before summarising the rest. */
const LISTED_RECORD_LIMIT = 5;

function summarise(entries: readonly string[]): string {
  const listed = entries.slice(0, LISTED_RECORD_LIMIT).join("; ");
  const remaining = entries.length - LISTED_RECORD_LIMIT;
  return remaining > 0 ? `${listed}; (+${remaining} more)` : listed;
}

/**
 * A sample the store refused to write. Raised before anything reaches the file,
 * so a record the store's own reader would reject can never enter the ledger —
 * the writer and the reader are held to one schema.
 */
export class BenchmarkSampleRejectedError extends Error {
  constructor(readonly problems: readonly ValidationProblem[]) {
    super(
      `The sample is not schema-valid and was not stored: ${summarise(problems.map(describeValidationProblem))}`,
    );
    this.name = "BenchmarkSampleRejectedError";
  }
}

/** Raised when the ledger holds a record that is not a readable sample. */
export class SampleLedgerIntegrityError extends Error {
  constructor(readonly corruptRecords: readonly string[]) {
    super(
      `The sample ledger holds ${corruptRecords.length} unreadable record(s); ` +
        `metrics are refused until they are resolved: ${summarise(corruptRecords)}`,
    );
    this.name = "SampleLedgerIntegrityError";
  }
}

/**
 * Every stored sample, or an error. Nothing in between: a caller that receives a
 * list may treat it as the complete set of measurements the ledger holds.
 */
export async function readAuthoritativeSamples(
  store: SampleStorePort,
): Promise<readonly BenchmarkSample[]> {
  const { samples, corruptRecords } = await store.readAll();
  if (corruptRecords.length > 0) {
    throw new SampleLedgerIntegrityError(corruptRecords);
  }
  return samples;
}
