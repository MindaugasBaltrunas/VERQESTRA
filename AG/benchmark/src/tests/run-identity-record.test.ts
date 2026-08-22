import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import type {
  AcceptanceVerification,
  AcceptanceVerifierPort,
} from "../application/ports/acceptance-verifier-port.js";
import { readAuthoritativeSamples } from "../application/sample-ledger.js";
import {
  executeBenchmarkRun,
  type IsolatedSampleRunnerPort,
} from "../application/run/execute-benchmark-run.js";
import type { IsolatedSampleRun } from "../application/run/isolated-run-record.js";
import type {
  IsolatedRunInspector,
  IsolatedSampleRequest,
} from "../application/run/isolated-sample-runner.js";
import {
  RunIdentityIntegrityError,
  readRecordedRunIdentity,
} from "../application/run/recorded-run-identity.js";
import { buildRunConfiguration } from "../application/run/run-identity.js";
import { computeSuiteConfigHash } from "../domain/baseline/manifest.js";
import { computeCompressionConfigDigest } from "../domain/compression/config-identity.js";
import { JsonlSampleStore } from "../infrastructure/jsonl-sample-store.js";
import { JsonRunIdentityStore } from "../infrastructure/run-identity-store.js";
import {
  createRunId,
  reserveRunId,
  runIdentityPath,
  runLedgerPath,
} from "../infrastructure/run-ledger-store.js";
import {
  RecordingRunIdentityStore,
  RecordingSampleStore,
  scenario,
  START_COMMIT,
  WORKTREE_PATH,
} from "./execution-fixtures.js";
import { runConfigurationInput, runIdentityRecord } from "./run-identity-fixtures.js";
import { validSample } from "./sample-fixtures.js";

/**
 * What a run records about itself, and when (BENCH-8, task 1205).
 *
 * Two properties carry this file. The identity is written *before* the first
 * sample, which is what makes every stored measurement attributable even when a
 * run is killed halfway; and it is written *once*, so a run cannot re-label
 * samples it has already stored. Everything else here exists to keep those two
 * from being true only in a fake: the round trip goes through the real store and
 * the real reader, with a real `createRunId` and a real `Date#toISOString`,
 * because both of those formats are checked by patterns the write side does not
 * import.
 */

const FINAL_COMMIT = "b".repeat(40);

/** An accepted verification, so the pipeline reaches the store rather than stopping short. */
const acceptingVerifier: AcceptanceVerifierPort = {
  async verify(): Promise<AcceptanceVerification> {
    return {
      checks: [{ id: "unit", kind: "test", status: "passed", durationMs: 10 }],
      outOfScopeFiles: [],
      decision: { verdict: "verified-accepted", reasons: [], agentClaimedDone: true },
    };
  },
};

/** A runner whose every cell is measurable, so the run reaches the sample store. */
class MeasuringRunner implements IsolatedSampleRunnerPort {
  readonly requests: IsolatedSampleRequest[] = [];

  async run(
    request: IsolatedSampleRequest,
    inspect?: IsolatedRunInspector,
  ): Promise<IsolatedSampleRun> {
    this.requests.push(request);
    const worktree = { id: "cell-0001", path: WORKTREE_PATH, startCommit: START_COMMIT };
    const capture = {
      baseCommit: START_COMMIT,
      finalCommit: FINAL_COMMIT,
      changedFiles: ["src/app.ts"],
      diff: { text: "", truncated: false, byteLength: 0 },
    };
    await inspect?.({ request, worktree, capture, agentClaimedDone: true });
    return {
      scenarioId: request.scenario.id,
      mode: request.mode,
      repetition: request.repetition,
      worktreeId: worktree.id,
      worktreePath: WORKTREE_PATH,
      startedAt: "2026-08-11T09:00:00.000Z",
      durationMs: 1_000,
      agentDurationMs: 900,
      exit: "completed",
      failure: "",
      agentClaimedDone: true,
      telemetry: validSample().telemetry,
      usage: undefined,
      compression: undefined,
      workspace: capture,
      cleanup: { result: "removed", reason: "" },
    };
  }
}

/** A ledger root outside the package, removed with the test that made it. */
async function ledgerRoot(t: TestContext): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "ag-benchmark-identity-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

test("the run records its identity before it stores the first sample", async () => {
  const events: string[] = [];
  const identity = new RecordingRunIdentityStore(events);
  const store = new RecordingSampleStore(events);
  const record = runIdentityRecord();

  const outcome = await executeBenchmarkRun(
    {
      scenarios: [scenario({ id: "docs-add-page" })],
      modes: ["deterministic-control"],
      repetitions: 2,
      allowNetworkModels: false,
      identityRecord: record,
    },
    { runner: new MeasuringRunner(), verifier: acceptingVerifier, store, identity },
  );

  assert.equal(outcome.samples.length, 2, outcome.unmeasured.map((cell) => cell.reason).join("; "));
  assert.deepEqual(identity.recorded, [record]);
  // Not "the record event exists" but "it is first": a record written after a
  // sample would leave a stored measurement nothing could be attributed to.
  assert.equal(events[0], `record:${record.runId}`);
  assert.equal(
    events.filter((event) => event.startsWith("append:")).length,
    2,
    "every stored sample appears in the shared log",
  );
  assert.ok(!events.slice(1).some((event) => event.startsWith("record:")));
});

test("a run that cannot state its identity measures nothing at all", async () => {
  const refusing = new RecordingRunIdentityStore([], new Error("the sidecar could not be written"));
  const store = new RecordingSampleStore();
  const runner = new MeasuringRunner();

  await assert.rejects(
    executeBenchmarkRun(
      {
        scenarios: [scenario()],
        modes: ["deterministic-control"],
        repetitions: 1,
        allowNetworkModels: false,
        identityRecord: runIdentityRecord(),
      },
      { runner, verifier: acceptingVerifier, store, identity: refusing },
    ),
    /the sidecar could not be written/,
  );

  // Not an unmeasured cell: no cell was attempted, so there is no cell to report
  // — the run did not happen.
  assert.deepEqual(store.appended, []);
  assert.deepEqual(runner.requests, []);
});

test("a recorded identity reads back as the record that was written", async (t) => {
  const root = await ledgerRoot(t);
  // The real forms of both fields, not plausible-looking literals: `runId` is
  // checked against IDENTIFIER_PATTERN and `recordedAt` against a UTC pattern,
  // and neither producer imports the pattern it has to satisfy.
  const startedAt = new Date("2026-08-11T09:07:03.045Z");
  const runId = createRunId(startedAt);
  const record = runIdentityRecord({ runId, recordedAt: startedAt.toISOString() });

  const store = new JsonRunIdentityStore(runLedgerPath(runId), root);
  await store.record(record);

  assert.deepEqual(await readRecordedRunIdentity(store), record);
  assert.equal(
    path.relative(root, store.filePath).split(path.sep).join("/"),
    runIdentityPath(runLedgerPath(runId)),
    "the sidecar sits beside the ledger it describes",
  );
});

test("a run states its identity once: a second record is refused", async (t) => {
  const root = await ledgerRoot(t);
  const store = new JsonRunIdentityStore(runLedgerPath("run-20260811t090000000z"), root);
  await store.record(runIdentityRecord());

  await assert.rejects(
    store.record(runIdentityRecord({ suiteHash: `sha256:${"9".repeat(64)}` })),
    /has already recorded its identity/,
  );
  // And the first statement survives the refusal.
  assert.equal(
    (await readRecordedRunIdentity(store))?.identity.suiteHash,
    runIdentityRecord().identity.suiteHash,
  );
});

test("the recorded configuration hash moves with what the run executed", () => {
  const base = computeSuiteConfigHash(buildRunConfiguration(runConfigurationInput()));

  assert.equal(base, computeSuiteConfigHash(buildRunConfiguration(runConfigurationInput())));
  assert.notEqual(
    base,
    computeSuiteConfigHash(buildRunConfiguration(runConfigurationInput({ repetitions: 5 }))),
  );
  assert.notEqual(
    base,
    computeSuiteConfigHash(buildRunConfiguration(runConfigurationInput({ suiteVersion: "2.0.0" }))),
  );
  assert.notEqual(
    base,
    computeSuiteConfigHash(
      buildRunConfiguration(
        runConfigurationInput({
          modeAdapterVersions: {
            "ag-loop": "ag-loop/2",
            "agent-solo": "agent-solo/1",
            "deterministic-control": "deterministic-control/1",
          },
        }),
      ),
    ),
  );
});

/**
 * The compression configuration is digested whole, so a key this build does not
 * know still re-identifies the document. A projection would let the orchestrator's
 * configuration change under a run without the record saying anything.
 */
test("the compression configuration digest covers the whole document", () => {
  const document = { version: 1, features: { worker_task_ir: true } };
  const digest = computeCompressionConfigDigest(document);

  assert.equal(digest, computeCompressionConfigDigest({ ...document }));
  assert.notEqual(
    digest,
    computeCompressionConfigDigest({ ...document, features: { worker_task_ir: false } }),
  );
  assert.notEqual(
    digest,
    computeCompressionConfigDigest({ ...document, aFlagThisBuildDoesNotKnow: true }),
  );
});

test("a ledger written before the record existed reads as legacy, not as damaged", async (t) => {
  const root = await ledgerRoot(t);
  const ledgerPath = runLedgerPath("run-20260811t090000000z");
  const samples = [validSample({ sampleId: "sample-0001" }), validSample({ sampleId: "sample-0002" })];
  await mkdir(path.dirname(path.join(root, ...ledgerPath.split("/"))), { recursive: true });
  await writeFile(
    path.join(root, ...ledgerPath.split("/")),
    `${samples.map((sample) => JSON.stringify(sample)).join("\n")}\n`,
    "utf8",
  );

  assert.equal(await readRecordedRunIdentity(new JsonRunIdentityStore(ledgerPath, root)), undefined);
  assert.deepEqual(
    (await readAuthoritativeSamples(new JsonlSampleStore(ledgerPath, root))).map(
      (sample) => sample.sampleId,
    ),
    ["sample-0001", "sample-0002"],
  );
});

test("a sidecar whose hash does not describe its own configuration is refused", async (t) => {
  const root = await ledgerRoot(t);
  const ledgerPath = runLedgerPath("run-20260811t090000000z");
  const store = new JsonRunIdentityStore(ledgerPath, root);
  await store.record(runIdentityRecord());

  // Only the repetition count moves, and only in the stored document: the hash
  // beside it now describes a run nobody executed.
  const document = JSON.parse(await readFile(store.filePath, "utf8")) as {
    config: { repetitions: number };
  };
  document.config.repetitions = 7;
  await writeFile(store.filePath, JSON.stringify(document, null, 2), "utf8");

  await assert.rejects(readRecordedRunIdentity(store), RunIdentityIntegrityError);
});

/**
 * Two runs started in the same millisecond.
 *
 * The id carries a millisecond timestamp and nothing else, which separates two runs started in
 * the same second and not two started in the same millisecond. The second one lost: the sidecar
 * is opened `wx`, so it refused rather than overwriting — no data lost, and nothing spent yet,
 * because the identity is recorded before the first cell runs. What was lost was a legitimate
 * run, killed for a reason its operator could not see.
 */
test("a run id already taken is advanced, not collided with", async (t) => {
  const root = await ledgerRoot(t);
  const startedAt = new Date("2026-08-11T09:07:03.045Z");

  const first = await reserveRunId(startedAt, root);
  assert.equal(first, createRunId(startedAt), "an unused millisecond is used as it stands");

  // The first run claims its millisecond, exactly as the pipeline does before any cell runs.
  await new JsonRunIdentityStore(runLedgerPath(first), root).record(
    runIdentityRecord({ runId: first, recordedAt: startedAt.toISOString() }),
  );

  const second = await reserveRunId(startedAt, root);
  assert.notEqual(second, first, "a second run must not be handed the ledger of the first");
  assert.equal(second, createRunId(new Date(startedAt.getTime() + 1)), "advanced by one millisecond");

  // The shape is unchanged, so nothing downstream learns a new name: the newest run is still the
  // greatest name, and the release gate's restated pattern still matches.
  assert.match(runLedgerPath(second), /^results\/runs\/run-\d{8}t\d{9}z\.jsonl$/);
  assert.ok(second > first, "lexicographic order still equals chronological order");

  // And the advanced id is genuinely free: the second run records without a refusal.
  await new JsonRunIdentityStore(runLedgerPath(second), root).record(
    runIdentityRecord({ runId: second, recordedAt: startedAt.toISOString() }),
  );
});

test("a ledger with no sidecar still holds its millisecond", async (t) => {
  // Both halves are checked, because a run that crashed after its samples were written and before
  // its identity was — or one restored from an archive — leaves only the ledger. Handing that
  // millisecond to a new run would append one run's samples onto another's, which is the single
  // thing per-run files exist to prevent.
  const root = await ledgerRoot(t);
  const startedAt = new Date("2026-08-11T09:07:03.045Z");
  const taken = createRunId(startedAt);

  await mkdir(path.join(root, "results", "runs"), { recursive: true });
  await writeFile(path.join(root, "results", "runs", `${taken}.jsonl`), "", "utf8");

  assert.equal(await reserveRunId(startedAt, root), createRunId(new Date(startedAt.getTime() + 1)));
});
