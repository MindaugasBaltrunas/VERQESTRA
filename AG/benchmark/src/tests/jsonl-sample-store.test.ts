import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import {
  BenchmarkSampleRejectedError,
  SampleLedgerIntegrityError,
} from "../application/sample-ledger.js";
import { REDACTION_PLACEHOLDER } from "../application/secret-redaction.js";
import { BenchmarkPathEscapeError } from "../infrastructure/benchmark-workspace-paths.js";
import {
  DEFAULT_SAMPLE_LEDGER_PATH,
  JsonlSampleStore,
} from "../infrastructure/jsonl-sample-store.js";
import { validSample } from "./sample-fixtures.js";
import { SYNTHETIC_SECRETS } from "./secret-samples.js";

const LEDGER = "results/samples.jsonl";

/** A ledger root outside the package, removed with the test that made it. */
async function ledgerRoot(t: TestContext): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "ag-benchmark-ledger-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

async function newStore(t: TestContext): Promise<JsonlSampleStore> {
  return new JsonlSampleStore(LEDGER, await ledgerRoot(t));
}

test("an empty ledger is not an error: a run that stored nothing stored nothing", async (t) => {
  const store = await newStore(t);
  assert.deepEqual(await store.readAll(), { samples: [], corruptRecords: [] });
});

test("appended samples read back in order, one record per line", async (t) => {
  const store = await newStore(t);
  await store.append(validSample({ sampleId: "sample-0001" }));
  await store.append(validSample({ sampleId: "sample-0002", mode: "agent-solo" }));

  const text = await readFile(store.filePath, "utf8");
  assert.equal(text.split("\n").length - 1, 2, "one terminating newline per record");
  assert.ok(text.endsWith("\n"), "a complete ledger ends with a newline");

  const { samples, corruptRecords } = await store.readAll();
  assert.deepEqual(corruptRecords, []);
  assert.deepEqual(
    samples.map((sample) => sample.sampleId),
    ["sample-0001", "sample-0002"],
  );
  assert.deepEqual(samples[0], validSample({ sampleId: "sample-0001" }));
});

test("concurrent appends interleave no records", async (t) => {
  const store = await newStore(t);
  await Promise.all(
    [1, 2, 3, 4, 5].map((index) =>
      store.append(validSample({ sampleId: `sample-000${index}`, repetition: index })),
    ),
  );
  const { samples, corruptRecords } = await store.readAll();
  assert.deepEqual(corruptRecords, []);
  assert.equal(samples.length, 5);
  assert.deepEqual(
    [...samples].map((sample) => sample.sampleId).sort(),
    ["sample-0001", "sample-0002", "sample-0003", "sample-0004", "sample-0005"],
  );
});

test("a line that is not JSON is reported, and the readable records still are", async (t) => {
  const store = await newStore(t);
  await store.append(validSample({ sampleId: "sample-0001" }));
  await appendFile(store.filePath, "{ this is not json\n", "utf8");
  await store.append(validSample({ sampleId: "sample-0003" }));

  const { samples, corruptRecords } = await store.readAll();
  assert.equal(corruptRecords.length, 1);
  assert.match(corruptRecords[0] ?? "", /^line 2: malformed JSON/);
  assert.deepEqual(
    samples.map((sample) => sample.sampleId),
    ["sample-0001", "sample-0003"],
  );
});

test("a JSON line that is not a valid sample is reported with the field that failed", async (t) => {
  const store = await newStore(t);
  const tampered = { ...validSample(), acceptance: { verdict: "accepted", reasons: [], agentClaimedDone: true } };
  await mkdir(path.dirname(store.filePath), { recursive: true });
  await writeFile(store.filePath, `${JSON.stringify(tampered)}\n`, "utf8");

  const { samples, corruptRecords } = await store.readAll();
  assert.deepEqual(samples, []);
  assert.equal(corruptRecords.length, 1);
  assert.match(corruptRecords[0] ?? "", /^line 1: acceptance\.verdict: unknown-enum-value/);
});

test("a record whose write did not finish is reported as truncated, never read as a measurement", async (t) => {
  const store = await newStore(t);
  await store.append(validSample({ sampleId: "sample-0001" }));
  // Exactly what a process killed mid-append leaves behind: a complete record,
  // then a prefix of the next one with no terminating newline.
  const line = JSON.stringify(validSample({ sampleId: "sample-0002" }));
  await appendFile(store.filePath, line.slice(0, Math.floor(line.length / 2)), "utf8");

  const { samples, corruptRecords } = await store.readAll();
  assert.deepEqual(
    samples.map((sample) => sample.sampleId),
    ["sample-0001"],
  );
  assert.equal(corruptRecords.length, 1);
  assert.match(corruptRecords[0] ?? "", /^line 2: truncated/);
});

test("appending onto a ledger that ends mid-record is refused, not fused into one line", async (t) => {
  const store = await newStore(t);
  await store.append(validSample({ sampleId: "sample-0001" }));
  const partial = JSON.stringify(validSample({ sampleId: "sample-0002" })).slice(0, 60);
  await appendFile(store.filePath, partial, "utf8");

  await assert.rejects(
    () => store.append(validSample({ sampleId: "sample-0003" })),
    SampleLedgerIntegrityError,
  );
  const text = await readFile(store.filePath, "utf8");
  assert.ok(text.endsWith(partial), "the refused append wrote onto the damaged tail anyway");
  // The first record stays readable; only the interrupted one is reported.
  const { samples, corruptRecords } = await store.readAll();
  assert.deepEqual(
    samples.map((sample) => sample.sampleId),
    ["sample-0001"],
  );
  assert.equal(corruptRecords.length, 1);
});

test("a blank line is a corrupt record, not an absent one", async (t) => {
  const store = await newStore(t);
  await store.append(validSample());
  await appendFile(store.filePath, "\n", "utf8");

  const { corruptRecords } = await store.readAll();
  assert.equal(corruptRecords.length, 1);
  assert.match(corruptRecords[0] ?? "", /^line 2: blank/);
});

test("a sample the reader would reject is never written", async (t) => {
  const store = await newStore(t);
  // `repairs >= attempts` is impossible: every repair is itself an attempt.
  const impossible = validSample({
    telemetry: { ...validSample().telemetry, attempts: 1, repairs: 3 },
  });
  await assert.rejects(() => store.append(impossible), BenchmarkSampleRejectedError);

  assert.deepEqual(await store.readAll(), { samples: [], corruptRecords: [] });
});

test("a refused sample does not wedge the ledger", async (t) => {
  const store = await newStore(t);
  await assert.rejects(
    () => store.append(validSample({ repetition: 0 })),
    BenchmarkSampleRejectedError,
  );
  await store.append(validSample({ sampleId: "sample-0002" }));

  const { samples, corruptRecords } = await store.readAll();
  assert.deepEqual(corruptRecords, []);
  assert.deepEqual(
    samples.map((sample) => sample.sampleId),
    ["sample-0002"],
  );
});

test("a credential reported by an adapter never reaches the file", async (t) => {
  const store = await newStore(t);
  const leaked = SYNTHETIC_SECRETS.anthropicApiKey;
  await store.append(
    validSample({ telemetry: { ...validSample().telemetry, model: `claude-opus-5 ${leaked}` } }),
  );

  const text = await readFile(store.filePath, "utf8");
  assert.equal(text.includes(leaked), false, "the stored line still carries the credential");
  assert.ok(text.includes(REDACTION_PLACEHOLDER));

  const { samples } = await store.readAll();
  assert.equal(samples[0]?.telemetry.model, `claude-opus-5 ${REDACTION_PLACEHOLDER}`);
});

test("the ledger path cannot leave the workspace", async (t) => {
  const root = await ledgerRoot(t);
  assert.throws(() => new JsonlSampleStore("../samples.jsonl", root), BenchmarkPathEscapeError);
  assert.throws(
    () => new JsonlSampleStore(path.join(root, "samples.jsonl"), root),
    BenchmarkPathEscapeError,
  );
  assert.equal(
    new JsonlSampleStore(DEFAULT_SAMPLE_LEDGER_PATH, root).filePath,
    path.join(root, "results", "samples.jsonl"),
  );
});
