import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import type { RunIdentityRecord } from "../application/ports/run-identity-store-port.js";
import { RunIdentityIntegrityError } from "../application/run/recorded-run-identity.js";
import type { BenchmarkSample } from "../domain/result.js";
import { runIdentityPath, runLedgerPath } from "../infrastructure/run-ledger-store.js";
import {
  REPORT_LIMITATIONS,
  generateBenchmarkReport,
} from "../interfaces/report/benchmark-report-entrypoint.js";
import { runIdentityRecord } from "./run-identity-fixtures.js";
import { validSample } from "./sample-fixtures.js";

/**
 * What the generated report says a run was (BENCH-8, task 1205).
 *
 * The rule under test is that the report *reads* the run's identity instead of
 * re-deriving it from the package as it stands now. Every case here is driven
 * against a temporary package root holding a hand-written ledger and sidecar,
 * because that is the only way to state "this ledger was written by a run whose
 * suite, configuration and host are not this machine's" — which is precisely the
 * situation a report published months after a run is in.
 *
 * Assertions bind to {@link REPORT_LIMITATIONS} rather than to the sentences, so
 * a reworded limitation is not a failing test and a dropped rule is.
 */

/**
 * A temporary package root, removed with the test that made it.
 *
 * Removal retries: a report that fails part-way leaves the host capture's child
 * process holding the directory for a moment, and on Windows that is an `EBUSY`
 * the test would otherwise report as a failure of the rule under test.
 */
async function packageRoot(t: TestContext): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "ag-benchmark-identity-report-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 });
  });
  return root;
}

/**
 * One run on disk: the ledger, and beside it whatever the run stated about
 * itself. A `sidecar` of `undefined` writes none, which is a ledger from before
 * runs recorded their identity.
 */
async function writeRun(
  root: string,
  runId: string,
  samples: readonly BenchmarkSample[],
  sidecar: RunIdentityRecord | Record<string, unknown> | undefined,
): Promise<void> {
  const ledgerPath = runLedgerPath(runId);
  const absoluteLedger = path.join(root, ...ledgerPath.split("/"));
  await mkdir(path.dirname(absoluteLedger), { recursive: true });
  await writeFile(
    absoluteLedger,
    `${samples.map((sample) => JSON.stringify(sample)).join("\n")}\n`,
    "utf8",
  );
  if (sidecar === undefined) return;
  await writeFile(
    path.join(root, ...runIdentityPath(ledgerPath).split("/")),
    `${JSON.stringify(sidecar, null, 2)}\n`,
    "utf8",
  );
}

test("a report of a run that recorded its identity states that identity, not this build's", async (t) => {
  const root = await packageRoot(t);
  const record = runIdentityRecord();
  await writeRun(root, "run-20260811t090000000z", [validSample()], record);

  const model = (await generateBenchmarkReport({ packageRoot: root, out: () => undefined }))
    .rendered.model;

  assert.deepEqual(model.current.identity.suiteHash, record.identity.suiteHash);
  assert.deepEqual(model.current.identity.configHash, record.identity.configHash);
  assert.deepEqual(model.current.identity.policyHash, record.identity.policyHash);
  assert.deepEqual(model.current.identity.agCommit, record.identity.agCommit);
  assert.deepEqual(
    model.current.identity.modeAdapterVersions.map((entry) => entry.version),
    ["ag-loop/1", "agent-solo/1", "deterministic-control/1"],
    "the adapter versions are the run's, not the ones this build happens to ship",
  );
  // The host is the one the run was measured on, not the one rendering the report.
  assert.deepEqual(model.current.environment, record.environment.environment);

  assert.ok(
    !model.limitations.includes(REPORT_LIMITATIONS.unrecordedIdentity),
    "an attributable ledger is not disclosed as an unattributable one",
  );
  // The suite of this temporary root does not validate, so the report claims no
  // drift: a comparison against a hash that was never computed is not a finding.
  assert.ok(
    !model.limitations.some((limitation) => limitation.includes("has changed since")),
    "drift is only claimed against a suite hash the working tree actually produced",
  );
});

test("a ledger from before the record existed reports no configuration identity, and says so", async (t) => {
  const root = await packageRoot(t);
  await writeRun(root, "run-20260811t090000000z", [validSample()], undefined);

  const model = (await generateBenchmarkReport({ packageRoot: root, out: () => undefined }))
    .rendered.model;

  assert.equal(model.current.identity.configHash, "");
  assert.equal(model.current.identity.policyHash, "");
  assert.ok(model.limitations.includes(REPORT_LIMITATIONS.unrecordedIdentity));
});

test("a run that could not read the compression configuration cannot be attributed to one", async (t) => {
  const root = await packageRoot(t);
  const record = runIdentityRecord({
    compressionConfig: {
      state: "absent",
      source: "vq/config/context-compression.json",
      digest: "",
    },
  });
  await writeRun(root, "run-20260811t090000000z", [validSample()], record);

  const model = (await generateBenchmarkReport({ packageRoot: root, out: () => undefined }))
    .rendered.model;

  assert.ok(
    model.limitations.includes(
      REPORT_LIMITATIONS.compressionConfigUnrecorded(record.compressionConfig),
    ),
  );
});

/**
 * Damaged provenance fails the generation. Degrading it to a limitation would
 * publish the methodology of the package as it stands today as the methodology
 * those samples were measured under, which is the one substitution BENCH-8
 * exists to prevent.
 */
test("a sidecar that cannot be read fails the report rather than being ignored", async (t) => {
  const root = await packageRoot(t);
  const record = runIdentityRecord();
  await writeRun(root, "run-20260811t090000000z", [validSample()], {
    ...record,
    // The configuration no longer hashes to what the record states about it.
    config: { ...record.config, repetitions: 7 },
  });

  await assert.rejects(
    generateBenchmarkReport({ packageRoot: root, out: () => undefined }),
    RunIdentityIntegrityError,
  );
});

/**
 * The pinning regression: identity and samples must come from one ledger.
 *
 * Two runs are on disk with different samples and different identities. A report
 * that resolved "the latest ledger" once per read could pair the newer run's
 * samples with the older run's identity, and nothing in the document would show
 * it.
 */
test("the identity and the samples of a report come from the same run", async (t) => {
  const root = await packageRoot(t);
  const older = runIdentityRecord({
    runId: "run-20260810t090000000z",
    suiteHash: `sha256:${"7".repeat(64)}`,
  });
  const newer = runIdentityRecord({
    runId: "run-20260811t090000000z",
    suiteHash: `sha256:${"8".repeat(64)}`,
  });
  await writeRun(root, older.runId, [validSample({ sampleId: "sample-0001" })], older);
  await writeRun(
    root,
    newer.runId,
    [
      validSample({ sampleId: "sample-0002", repetition: 1 }),
      validSample({ sampleId: "sample-0003", repetition: 2 }),
      validSample({ sampleId: "sample-0004", repetition: 3 }),
    ],
    newer,
  );

  const model = (await generateBenchmarkReport({ packageRoot: root, out: () => undefined }))
    .rendered.model;

  assert.equal(model.current.identity.suiteHash, newer.identity.suiteHash);
  assert.equal(model.current.sampleCount, 3, "the samples are the newest run's");
});
