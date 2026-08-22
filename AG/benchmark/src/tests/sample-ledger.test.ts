import assert from "node:assert/strict";
import test from "node:test";

import type { SampleStorePort } from "../application/ports/sample-store-port.js";
import {
  SampleLedgerIntegrityError,
  describeValidationProblem,
  readAuthoritativeSamples,
} from "../application/sample-ledger.js";
import type { BenchmarkSample } from "../domain/result.js";
import { validSample } from "./sample-fixtures.js";

/** A store that returns exactly what a test wants the ledger to have held. */
function storeHolding(
  samples: readonly BenchmarkSample[],
  corruptRecords: readonly string[] = [],
): SampleStorePort {
  return {
    append: async () => {
      throw new Error("this test never writes");
    },
    readAll: async () => ({ samples, corruptRecords }),
  };
}

test("a clean ledger yields every sample it holds", async () => {
  const samples = [validSample({ sampleId: "sample-0001" }), validSample({ sampleId: "sample-0002" })];
  assert.deepEqual(await readAuthoritativeSamples(storeHolding(samples)), samples);
});

test("one corrupt record refuses the whole ledger, readable records included", async () => {
  const store = storeHolding([validSample()], ["line 2: malformed JSON: Unexpected token"]);
  await assert.rejects(
    () => readAuthoritativeSamples(store),
    (error: unknown) => {
      // The readable sample must not come back on its own: a metric computed
      // from it would divide by a denominator the corrupt record belongs to.
      assert.ok(error instanceof SampleLedgerIntegrityError);
      assert.deepEqual(error.corruptRecords, ["line 2: malformed JSON: Unexpected token"]);
      assert.match(error.message, /1 unreadable record/);
      return true;
    },
  );
});

test("the failure names the records rather than only counting them", async () => {
  const corrupt = Array.from({ length: 8 }, (_, index) => `line ${index + 1}: blank`);
  const store = storeHolding([], corrupt);
  await assert.rejects(
    () => readAuthoritativeSamples(store),
    (error: unknown) => {
      assert.ok(error instanceof SampleLedgerIntegrityError);
      assert.equal(error.corruptRecords.length, 8, "every record stays on the error");
      assert.match(error.message, /line 1: blank/);
      assert.match(error.message, /\(\+3 more\)/, "the message summarises the tail rather than growing");
      return true;
    },
  );
});

test("a problem is described with its location first", () => {
  assert.equal(
    describeValidationProblem({ path: "telemetry.repairs", code: "inconsistent", message: "3 against 1" }),
    "telemetry.repairs: inconsistent: 3 against 1",
  );
  assert.equal(
    describeValidationProblem({ path: "", code: "wrong-type", message: "expected an object" }),
    "wrong-type: expected an object",
  );
});
