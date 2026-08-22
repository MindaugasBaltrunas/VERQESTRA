import type { BenchmarkReportModel } from "./benchmark-report-model.js";

/**
 * The JSON rendering of a report (BENCH-10).
 *
 * It serialises {@link BenchmarkReportModel} and computes nothing. The two
 * properties it adds are the ones a machine-readable report needs:
 *
 * - **Sorted keys.** Insertion order is an accident of how the model was built,
 *   and a report that is diffed against the previous one has to differ only where
 *   the measurement differed. Same rule, and the same reason, as
 *   `domain/baseline/canonical-json.ts`.
 * - **Absent keys for unmeasured values.** BENCH-7 represents "not measured" as
 *   `undefined`, and JSON has no such value. Omission is the only encoding that
 *   survives a write/read round trip unchanged; `null` would come back as a value
 *   that was measured. The Markdown rendering spells the same fact `n/a`.
 *
 * Indented rather than compact: a report is read by people at least as often as
 * by programs, and the sorted keys make the indentation deterministic anyway.
 */

/** Indentation of the emitted document. Fixed, so two renderings of one model are byte-identical. */
const JSON_INDENT = 2;

/**
 * The model as a plain value with sorted keys and no `undefined`.
 *
 * Own keys only: a `__proto__` entry that reached the model from parsed input is
 * data, and following it to the prototype would serialise something the model
 * never said.
 */
function sortedPlainValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedPlainValue);
  if (value === null || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .filter((key) => record[key] !== undefined)
      .map((key) => [key, sortedPlainValue(record[key])]),
  );
}

/** The JSON report document. Ends with a newline, as a text file does. */
export function renderBenchmarkReportJson(model: BenchmarkReportModel): string {
  return `${JSON.stringify(sortedPlainValue(model), null, JSON_INDENT)}\n`;
}
