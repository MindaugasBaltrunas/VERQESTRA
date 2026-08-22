import type { BenchmarkBaseline } from "../../domain/baseline.js";
import {
  sealBaselineDocument,
  serializeBaselineDocument,
  toBenchmarkBaseline,
  validateBaselineDocument,
} from "../../domain/baseline/document.js";
import type { ValidationResult } from "../../domain/validation.js";
import { createBaselineDocument, type BaselineCreationRequest } from "./create-baseline.js";

/**
 * Reading and writing a stored baseline (BENCH-8).
 *
 * The domain owns the document — its schema, its integrity checks, its canonical
 * bytes. What this module adds is the pair of operations a delivery layer needs
 * and the one property that pair has to hold: a baseline is written from, and
 * read back into, the same published {@link BenchmarkBaseline} value. Without
 * that, the object a comparison judges and the object a file holds are two
 * shapes that agree only as long as nobody edits either of them.
 */

/**
 * The bytes a baseline file holds.
 *
 * Re-sealed from the manifest and the samples rather than serialised from
 * whatever the caller is holding: the aggregates and the manifest hash are
 * derived values, and writing a caller's copy of them would let a file claim
 * numbers its own samples do not support.
 */
export function serializeBaseline(baseline: BenchmarkBaseline): string {
  return serializeBaselineDocument(sealBaselineDocument(baseline.manifest, baseline.samples));
}

/**
 * A new baseline, or every reason it may not exist.
 *
 * The document is built, sealed and read back through the validator before a
 * value is returned, so a baseline is created only if it can be read: an
 * unattributable AG commit, a sample the schema refuses or a timestamp in local
 * time are reported now rather than at a comparison months later.
 */
export function createBaseline(
  request: BaselineCreationRequest,
): ValidationResult<BenchmarkBaseline> {
  const document = createBaselineDocument(request);
  return document.ok ? { ok: true, value: toBenchmarkBaseline(document.value) } : document;
}

/**
 * A stored baseline, or every reason it may not be used. Fail-closed: a document
 * whose manifest hash or aggregates disagree with its own content is refused
 * here rather than compared against later.
 */
export function readBaseline(input: unknown): ValidationResult<BenchmarkBaseline> {
  const document = validateBaselineDocument(input);
  return document.ok ? { ok: true, value: toBenchmarkBaseline(document.value) } : document;
}
