// Compact worker DSL parity — proves, by DECODING (not inspection), that the document still
// carries the IR: every scalar byte-identical, every list = IR list minus structural
// duplicates in the same order, every IR item still present under its own field's duplicate
// rule, so "deduplicated" can never quietly mean "dropped". Behaviour etalon: AG_loop
// application/context-pack/compact-worker-dsl.ts (parity pusė; WBR VQ-302 skaidymas).

import type { WorkerTaskIr } from "../worker-task-ir-schema.js";
import { deduplicateIrLists, duplicateKey, LIST_FIELDS, type CompactWorkerDsl } from "./model.js";
import { parseCompactWorkerDsl } from "./parse.js";

export type CompactWorkerDslFieldParity = {
  field: string;
  ir_items: number;
  dsl_items: number;
  duplicates_removed: number;
  lossless: boolean;
};

export type CompactWorkerDslParityReport = {
  ok: boolean;
  fields: CompactWorkerDslFieldParity[];
  /** Human-readable reasons; empty exactly when `ok`. */
  differences: string[];
};

export function compactWorkerDslParity(ir: WorkerTaskIr, dsl: CompactWorkerDsl): CompactWorkerDslParityReport {
  const report: CompactWorkerDslParityReport = { ok: true, fields: [], differences: [] };

  const parsed = parseCompactWorkerDsl(dsl.text);
  if (!parsed.ok) {
    report.ok = false;
    report.differences.push(`document does not decode (line ${parsed.error.line}): ${parsed.error.message}`);
    return report;
  }
  const decoded = parsed.value;
  const lists = deduplicateIrLists(ir);

  for (const [field, expected, actual] of [
    ["version", String(ir.version), String(decoded.ir_version)],
    ["task_id", ir.task_id, decoded.task_id],
    ["source_sha256", ir.source_sha256, decoded.source_sha256],
    ["goal", ir.goal, decoded.goal],
    ["stop", ir.stop ?? "", decoded.stop],
  ] as ReadonlyArray<readonly [string, string, string]>) {
    const lossless = expected === actual;
    report.fields.push({ field, ir_items: 1, dsl_items: 1, duplicates_removed: 0, lossless });
    if (!lossless) {
      report.differences.push(`${field}: IR ${JSON.stringify(expected)} != DSL ${JSON.stringify(actual)}`);
    }
  }

  for (const field of LIST_FIELDS) {
    const irItems = ir[field] ?? [];
    const kept = lists[field];
    const actual = decoded[field];
    let lossless = kept.length === actual.length && kept.every((item, at) => item === actual[at]);
    if (lossless) {
      const present = new Set(actual.map((item) => duplicateKey(item)));
      for (const item of irItems) {
        if (!present.has(duplicateKey(item))) {
          lossless = false;
          report.differences.push(`${field}: IR item ${JSON.stringify(item)} is missing from the DSL`);
        }
      }
    } else {
      report.differences.push(`${field}: ${JSON.stringify(kept)} != ${JSON.stringify(actual)}`);
    }
    report.fields.push({
      field,
      ir_items: irItems.length,
      dsl_items: actual.length,
      duplicates_removed: irItems.length - kept.length,
      lossless,
    });
  }

  const irElements = ir.elements ?? [];
  const elementsLossless =
    irElements.length === decoded.elements.length &&
    irElements.every((element, at) => {
      const other = decoded.elements[at];
      return other?.heading === element.heading && other.kind === element.kind && other.body === element.body;
    });
  report.fields.push({
    field: "elements",
    ir_items: irElements.length,
    dsl_items: decoded.elements.length,
    duplicates_removed: 0,
    lossless: elementsLossless,
  });
  if (!elementsLossless) {
    report.differences.push("elements: verbatim blocks did not survive the round trip");
  }

  report.ok = report.differences.length === 0;
  return report;
}
