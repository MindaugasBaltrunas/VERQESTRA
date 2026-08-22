// Under what methodology stored samples are published (BENCH-8).
//
// This file exists because `benchmark-cli-composition.ts` had none, and a defect sat in it: the
// CLI's `baseline create`, `compare` and interactive `report` re-derived each run's identity from
// the suite as it stood, the host as it was, and the shape of whichever samples survived. A run
// recorded under `sha256:03b86a…` was published as `sha256:fd238a…`, and a run planned as
// `ag-loop + agent-solo` whose loop cells were all lost read as an `agent-solo` run that had been
// planned that way. The separate `benchmark:report` generator read the record correctly all along,
// so the two official paths disagreed about the same ledger.
//
// A composition that builds its own dependencies has nowhere for a test to stand. The decision now
// lives behind an injected seam, and this is what stands on it.

import assert from "node:assert/strict";
import test from "node:test";

import type { RunIdentityRecord } from "../application/ports/run-identity-store-port.js";
import type { BenchmarkSample } from "../domain/result.js";
import {
  describeStoredRun,
  loadRecordedRunContext,
  loadRecordedSummary,
  type RunProvenanceDeps,
} from "../interfaces/cli/benchmark-run-provenance.js";
import { MODE_ADAPTER_VERSIONS } from "../interfaces/cli/benchmark-cli-composition.js";
import { validSample } from "./sample-fixtures.js";
import { RUN_IDENTITY_ENVIRONMENT, runIdentityRecord } from "./run-identity-fixtures.js";
import { scenario } from "./execution-fixtures.js";

const LEDGER = "results/runs/run-20260822t141440313z.jsonl";

class NotExecuted extends Error {}

interface Recorded {
  readonly warnings: string[];
  readonly suiteReads: number;
  readonly environmentReads: number;
}

function deps(
  overrides: {
    readonly record?: RunIdentityRecord | undefined;
    readonly samples?: readonly BenchmarkSample[];
    readonly ledger?: string | undefined;
  } = {},
): { deps: RunProvenanceDeps; recorded: Recorded } {
  const recorded = { warnings: [] as string[], suiteReads: 0, environmentReads: 0 };
  const value: RunProvenanceDeps = {
    findLedger: () => Promise.resolve("ledger" in overrides ? overrides.ledger : LEDGER),
    readRecord: () => Promise.resolve(overrides.record),
    readSamples: () => Promise.resolve(overrides.samples ?? [validSample()]),
    requireSuite: () => {
      recorded.suiteReads += 1;
      return Promise.resolve({
        suite: { schemaVersion: 1, version: "9.9.9", scenarios: [scenario()] },
        suiteHash: "sha256:live-suite",
      });
    },
    captureRunEnvironment: () => {
      recorded.environmentReads += 1;
      return Promise.resolve(RUN_IDENTITY_ENVIRONMENT);
    },
    modeAdapterVersions: MODE_ADAPTER_VERSIONS,
    warn: (message) => recorded.warnings.push(message),
    notExecuted: (action) => new NotExecuted(action),
  };
  return { deps: value, recorded: recorded as Recorded };
}

test("the recorded identity is published, and the live suite is never consulted", async () => {
  const record = runIdentityRecord();
  const { deps: value, recorded } = deps({ record });

  const summary = await loadRecordedSummary(value, "summarize");

  assert.deepEqual(summary.identity, record.identity, "a run is published under what it recorded");
  assert.deepEqual(summary.environment, record.environment.environment);
  // The strongest half of the assertion: nothing about the package as it stands now was read at
  // all, so no edit to the suite or move to another host can change how these samples are labelled.
  assert.equal(recorded.suiteReads, 0, "the live suite was consulted for a run that recorded its own");
  assert.equal(recorded.environmentReads, 0, "the live host was captured for a run that recorded its own");
  assert.deepEqual(recorded.warnings, []);
});

test("a legacy ledger is re-derived, and never silently", async () => {
  // `undefined` is the documented legacy answer: a ledger written before runs recorded an identity.
  // Refusing those would make every stored run unreadable at once, so re-derivation stays — but a
  // baseline sealed under assumptions must announce that it is one.
  const { deps: value, recorded } = deps({ record: undefined });

  const summary = await loadRecordedSummary(value, "baseline create");

  assert.equal(summary.identity.suiteHash, "sha256:live-suite");
  assert.equal(recorded.suiteReads, 1);
  assert.equal(recorded.warnings.length, 1, "a re-derived provenance must be said out loud");
  assert.match(recorded.warnings[0] ?? "", /carries no recorded run identity/);
  assert.match(recorded.warnings[0] ?? "", /comparison of assumptions/);
});

test("no ledger and an empty ledger are both refusals, not empty summaries", async () => {
  const { deps: missing } = deps({ ledger: undefined });
  await assert.rejects(() => loadRecordedSummary(missing, "compare"), NotExecuted);

  // A ledger that exists and holds nothing is a run that measured nothing; summarising it would
  // publish zeroes that read as results (BENCH-5).
  const { deps: empty } = deps({ record: runIdentityRecord(), samples: [] });
  await assert.rejects(() => loadRecordedSummary(empty, "compare"), NotExecuted);
});

test("the record is read BEFORE the samples, so damaged provenance stops the numbers", async () => {
  const order: string[] = [];
  const value: RunProvenanceDeps = {
    ...deps({ record: runIdentityRecord() }).deps,
    readRecord: () => {
      order.push("record");
      return Promise.resolve(runIdentityRecord());
    },
    readSamples: () => {
      order.push("samples");
      return Promise.resolve([validSample()]);
    },
  };

  await loadRecordedSummary(value, "summarize");

  assert.deepEqual(order, ["record", "samples"], "samples must never be held before they may be attributed");
});

test("compare builds the current manifest from the recorded configuration, not the present one", async () => {
  const record = runIdentityRecord();
  const { deps: value, recorded } = deps({ record });

  const context = await loadRecordedRunContext(value, "compare");

  assert.deepEqual(context.config, record.config, "the configuration a comparison judges under is the recorded one");
  assert.deepEqual(context.environment, record.environment);
  assert.equal(recorded.suiteReads, 0);
  assert.equal(recorded.environmentReads, 0);
});

test("describeStoredRun reconstructs from samples, and loses what the samples do not show", async () => {
  // The reconstruction is the legacy path only, and this is why. A run planned as two modes whose
  // loop cells were all lost reads here as a run that was planned with one — the missing half
  // disappears from the very field that says what was attempted. Pinned rather than fixed: it
  // cannot be fixed from samples alone, which is the whole argument for reading the record.
  const shape = describeStoredRun([
    validSample({ sampleId: "s-1", mode: "agent-solo" }),
    validSample({ sampleId: "s-2", mode: "agent-solo", repetition: 3 }),
  ]);

  assert.deepEqual(shape.modes, ["agent-solo"]);
  assert.equal(shape.repetitions, 3);
  assert.equal(shape.allowNetworkModels, true, "a networked mode occurred, so the run needed permission");
});
