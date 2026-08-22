import assert from "node:assert/strict";
import test from "node:test";

import { RUN_IDENTITY_RECORD_SCHEMA_VERSION } from "../application/ports/run-identity-store-port.js";
import { validateRunIdentityRecord } from "../application/run/recorded-run-identity.js";
import {
  COMPRESSION_CONFIG_PROJECTION_VERSION,
  computeCompressionConfigDigest,
  projectCompressionConfigView,
} from "../domain/compression/config-identity.js";
import { COMPRESSION_FEATURES, type CompressionFeature } from "../domain/compression/features.js";
import { readCompressionConfig, runIdentityRecord } from "./run-identity-fixtures.js";

/**
 * The compression provenance projection tells the truth about a canary (task
 * 0039).
 *
 * The projection used to compute `enabled: features[flag] === true`, so an
 * authored `"canary"` — a rollout somebody started, running for a sampled share
 * of dispatches — was recorded as `false`. The digest was never wrong (it is
 * taken over the whole raw document), but the readable summary beside it stated
 * the opposite of the configuration it summarised, and a sidecar that
 * contradicts itself is worse than one that says less.
 *
 * These tests pin the properties that keep it honest: the authored state passes
 * through uninterpreted, the canary parameters are visible, the digest is still
 * taken over the whole document, and what the projection writes is what the
 * reader accepts back.
 */

/** The state the projection produced for one flag, by name. */
function stateOf(document: unknown, feature: CompressionFeature): unknown {
  return projectCompressionConfigView(document).features.find((state) => state.feature === feature)
    ?.state;
}

/** A deep copy through JSON, which is the trip a stored record actually makes. */
function stored(value: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

/** One nested object of a stored document, so a test can damage exactly one field of it. */
function child(source: Record<string, unknown>, key: string): Record<string, unknown> {
  return source[key] as Record<string, unknown>;
}

test("an authored canary projects as a canary, never as an off flag", () => {
  assert.equal(stateOf({ features: { worker_task_ir: "canary" } }, "worker_task_ir"), "canary");
});

test("authored true and false pass through with the meaning they were written with", () => {
  const document = { features: { worker_task_ir: true, compact_dsl: false } };
  assert.equal(stateOf(document, "worker_task_ir"), true);
  assert.equal(stateOf(document, "compact_dsl"), false);
});

/**
 * Fail-closed, unchanged: only the *known-good* value domain widened. A state
 * this build cannot read still reads `false`, because the one answer it may never
 * invent is one that reports a feature as having been measured in use.
 */
test("a state this build does not know reads false rather than something on", () => {
  const document = { features: { worker_task_ir: "half-on", compact_dsl: 1 } };
  assert.equal(stateOf(document, "worker_task_ir"), false);
  assert.equal(stateOf(document, "compact_dsl"), false);
  assert.equal(stateOf({}, "symbol_slices"), false);
});

test("every declared feature is still listed once, in registry order", () => {
  const view = projectCompressionConfigView({ features: { symbol_slices: "canary" } });
  assert.deepEqual(
    view.features.map((state) => state.feature),
    [...COMPRESSION_FEATURES],
  );
});

test("the canary percentage and salt are both visible in the projection", () => {
  const view = projectCompressionConfigView({ canary: { percent: 50, salt: "ag-loop-canary" } });
  assert.equal(view.canary.percent, 50);
  assert.equal(view.canary.salt, "ag-loop-canary");
});

/** Absent is not zero and not the empty string: a value nobody wrote is not a rollout. */
test("an unstated percentage or salt stays undefined rather than being defaulted", () => {
  const view = projectCompressionConfigView({ canary: {} });
  assert.equal(view.canary.percent, undefined);
  assert.equal(view.canary.salt, undefined);
  assert.equal(projectCompressionConfigView({}).canary.percent, undefined);
});

/**
 * The digest is unchanged work: it still hashes the whole raw document, so a key
 * this build does not know still re-identifies the configuration, and two
 * documents that differ only outside the projection still differ here.
 */
test("the digest still covers the whole document, not the projected view", () => {
  const document = { version: 1, features: { worker_task_ir: "canary" } };
  const digest = computeCompressionConfigDigest(document);
  assert.equal(digest, computeCompressionConfigDigest({ ...document }));
  assert.notEqual(
    digest,
    computeCompressionConfigDigest({ ...document, features: { worker_task_ir: true } }),
  );
  assert.notEqual(
    digest,
    computeCompressionConfigDigest({ ...document, aKeyThisBuildDoesNotKnow: true }),
  );
});

/** The constants' documented contract: a projection of another shape is another version. */
test("the projection and record versions moved with the shape they describe", () => {
  assert.equal(COMPRESSION_CONFIG_PROJECTION_VERSION, 2);
  assert.equal(RUN_IDENTITY_RECORD_SCHEMA_VERSION, 2);
});

test("what the projection writes is what the record reader accepts back", () => {
  const validated = validateRunIdentityRecord(stored(runIdentityRecord()));
  assert.ok(validated.ok, JSON.stringify(validated.ok ? [] : validated.problems));
  assert.deepEqual(validated.value.compressionConfig.view?.features, [
    { feature: "worker_task_ir", state: true },
    { feature: "compact_dsl", state: false },
    { feature: "symbol_slices", state: "canary" },
    { feature: "bash_output_digest", state: false },
    { feature: "dispatch_tool_schema", state: false },
  ]);
  assert.deepEqual(validated.value.compressionConfig.view?.canary, {
    percent: 25,
    salt: "ag-loop-canary",
  });
});

/** A salt the configuration wrote as a blank string is a fact about the file, not a fault. */
test("a blank salt round-trips instead of being refused by the reader", () => {
  const compressionConfig = readCompressionConfig({ canary: { salt: "" } });
  const validated = validateRunIdentityRecord(stored(runIdentityRecord({ compressionConfig })));
  assert.ok(validated.ok, JSON.stringify(validated.ok ? [] : validated.problems));
  assert.equal(validated.value.compressionConfig.view?.canary.salt, "");
});

/**
 * Fail-closed on the way back in, per this reader's contract: a stored state
 * outside the tri-state is refused rather than repaired into `false`.
 */
test("a stored state outside the tri-state is refused, not repaired", () => {
  const record = stored(runIdentityRecord());
  const features = child(child(record, "compressionConfig"), "view")[
    "features"
  ] as Record<string, unknown>[];
  features[0]["state"] = "on";
  const validated = validateRunIdentityRecord(record);
  assert.equal(validated.ok, false);
  assert.ok(
    !validated.ok &&
      validated.problems.some(
        (problem) => problem.path === "compressionConfig.view.features[0].state",
      ),
    JSON.stringify(validated.ok ? [] : validated.problems),
  );
});

/** The canary fields are bounded and typed on the way back in, as every other stored field is. */
test("a canary percentage out of range and a salt that is not a string are refused", () => {
  const outOfRange = stored(runIdentityRecord());
  child(child(child(outOfRange, "compressionConfig"), "view"), "canary")["percent"] = 150;
  assert.equal(validateRunIdentityRecord(outOfRange).ok, false);

  const wrongSalt = stored(runIdentityRecord());
  child(child(child(wrongSalt, "compressionConfig"), "view"), "canary")["salt"] = 5;
  const validated = validateRunIdentityRecord(wrongSalt);
  assert.ok(
    !validated.ok &&
      validated.problems.some(
        (problem) => problem.path === "compressionConfig.view.canary.salt",
      ),
    JSON.stringify(validated.ok ? [] : validated.problems),
  );
});

test("a record whose canary object is missing is refused rather than defaulted", () => {
  const record = stored(runIdentityRecord());
  delete child(child(record, "compressionConfig"), "view")["canary"];
  const validated = validateRunIdentityRecord(record);
  assert.equal(validated.ok, false);
  assert.ok(
    !validated.ok &&
      validated.problems.some((problem) => problem.path === "compressionConfig.view.canary"),
    JSON.stringify(validated.ok ? [] : validated.problems),
  );
});

/**
 * A record written before this change is a document of another version, not a
 * damaged one of this version: a sidecar is never rewritten, so it is read under
 * the shape it was written in. The lift invents nothing — version 1 stated one
 * boolean per feature and that is all it is read as saying.
 */
test("a version-1 record is read under its own boolean shape", () => {
  const record = legacyRecord();
  const validated = validateRunIdentityRecord(record);
  assert.ok(validated.ok, JSON.stringify(validated.ok ? [] : validated.problems));
  assert.deepEqual(validated.value.compressionConfig.view?.features[0], {
    feature: "worker_task_ir",
    state: true,
  });
  // That shape had no field for a salt, so "not stated" is the whole truth.
  assert.deepEqual(validated.value.compressionConfig.view?.canary, {
    percent: 25,
    salt: undefined,
  });
});

/** That shape's percentage was absent-able too, and absent still means absent. */
test("a version-1 record that stated no canary percentage reads as stating none", () => {
  const record = legacyRecord();
  delete child(child(record, "compressionConfig"), "view")["canaryPercent"];
  const validated = validateRunIdentityRecord(record);
  assert.ok(validated.ok, JSON.stringify(validated.ok ? [] : validated.problems));
  assert.deepEqual(validated.value.compressionConfig.view?.canary, {
    percent: undefined,
    salt: undefined,
  });
});

/** The version decides the shape; a record is never read under whichever one happens to fit. */
test("a version-1 record carrying the tri-state shape is refused, not sniffed", () => {
  const record = stored(runIdentityRecord());
  record["schemaVersion"] = 1;
  const validated = validateRunIdentityRecord(record);
  assert.equal(validated.ok, false);
});

/** Tolerance is not open-ended: a version this build never defined is still refused. */
test("a record of an undefined schema version is refused", () => {
  const record = legacyRecord();
  record["schemaVersion"] = 99;
  const validated = validateRunIdentityRecord(record);
  assert.equal(validated.ok, false);
  assert.ok(
    !validated.ok &&
      validated.problems.some((problem) => problem.code === "unsupported-schema-version"),
    JSON.stringify(validated.ok ? [] : validated.problems),
  );
});

/** A record exactly as the previous build wrote one: version 1, boolean flags, bare percentage. */
function legacyRecord(): Record<string, unknown> {
  const record = stored(runIdentityRecord());
  record["schemaVersion"] = 1;
  child(record, "compressionConfig")["view"] = {
    version: 1,
    features: COMPRESSION_FEATURES.map((feature) => ({
      feature,
      enabled: feature === "worker_task_ir",
    })),
    canaryPercent: 25,
  };
  return record;
}
