import assert from "node:assert/strict";
import test from "node:test";

import { createBaselineDocument } from "../application/baseline/create-baseline.js";
import {
  canonicalDigest,
  canonicalJson,
  canonicallyEqual,
} from "../domain/baseline/canonical-json.js";
import {
  sealBaselineDocument,
  serializeBaselineDocument,
  toBenchmarkBaseline,
  validateBaselineDocument,
} from "../domain/baseline/document.js";
import {
  canonicalizeBaselineManifest,
  computeBaselineManifestHash,
  computeSuiteConfigHash,
  freezeDeep,
} from "../domain/baseline/manifest.js";
import { baselineVariant, variantById } from "../domain/compression/cohort.js";
import type { CompressionVariant } from "../domain/compression/variant.js";
import { aggregateSamplesByMode, toModeMetrics } from "../domain/metrics/aggregate.js";
import type { BenchmarkSuiteConfig } from "../domain/suite-config.js";
import type { ValidationProblem, ValidationResult } from "../domain/validation.js";
import {
  VALID_RUN_ENVIRONMENT,
  VALID_SUITE_CONFIG,
  validCreationRequest,
  validManifest,
} from "./baseline-fixtures.js";
import { validSample } from "./sample-fixtures.js";

/**
 * BENCH-8 manifest tests.
 *
 * Two properties are asserted throughout: the canonical form depends on the
 * values and on nothing else, and a stored baseline that no longer agrees with
 * itself is refused rather than read. Both are what makes a hash evidence - a
 * digest nobody rechecks is decoration, and one that moves with key order
 * declares every baseline incomparable with itself.
 *
 * The text fixtures are written as escapes rather than as literal characters:
 * this file states which code points it means, and a save that renormalised the
 * source would otherwise turn the normalisation tests into assertions that a
 * string equals itself.
 */

/** Precomposed: LATIN SMALL LETTER E WITH ACUTE. */
const PRECOMPOSED = "résumé";

/** Decomposed: plain "e" followed by COMBINING ACUTE ACCENT. The same word. */
const DECOMPOSED = "résumé";

// ---------------------------------------------------------------------------
// Canonical serialization
// ---------------------------------------------------------------------------

test("the canonical form sorts object keys and drops insignificant whitespace", () => {
  assert.equal(canonicalJson({ b: 1, a: { d: true, c: "x" } }), '{"a":{"c":"x","d":true},"b":1}');
  assert.equal(canonicalJson({ a: 1, b: 2 }), canonicalJson({ b: 2, a: 1 }));
});

test("the canonical form is blind to how a checkout stored the text", () => {
  assert.equal(
    canonicalJson({ task: "one\r\ntwo\rthree" }),
    canonicalJson({ task: "one\ntwo\nthree" }),
  );
  // Which spelling a file holds is decided by the editor and the filesystem,
  // never by what the recorded value means.
  assert.notEqual(PRECOMPOSED, DECOMPOSED);
  assert.equal(canonicalJson({ title: PRECOMPOSED }), canonicalJson({ title: DECOMPOSED }));
  assert.equal(
    canonicalJson({ [PRECOMPOSED]: 1 }),
    canonicalJson({ [DECOMPOSED]: 1 }),
    "a key is normalised as well as a value",
  );
});

test("arrays keep their order, because a sequence is content", () => {
  assert.notEqual(canonicalJson(["a", "b"]), canonicalJson(["b", "a"]));
});

test("an unmeasured value is absent rather than null, so a write and a read agree", () => {
  assert.equal(canonicalJson({ measured: 1, unmeasured: undefined }), '{"measured":1}');
  assert.ok(canonicallyEqual({ rate: undefined }, JSON.parse(canonicalJson({ rate: undefined }))));
  // `null` would come back as a value that was measured, so it is not the same statement.
  assert.ok(!canonicallyEqual({ rate: undefined }, { rate: null }));
});

test("a value that cannot be hashed honestly is refused rather than repaired", () => {
  assert.throws(() => canonicalJson({ rate: Number.NaN }), TypeError);
  assert.throws(() => canonicalJson({ rate: Number.POSITIVE_INFINITY }), TypeError);
  assert.throws(() => canonicalJson({ read: () => 1 }), TypeError);
  assert.throws(() => canonicalJson([1, undefined, 2]), TypeError);
  assert.throws(() => canonicalJson(undefined), TypeError);
});

test("negative zero and zero are the same measurement", () => {
  assert.equal(canonicalJson({ drift: -0 }), canonicalJson({ drift: 0 }));
});

test("a digest names the algorithm that produced it", () => {
  assert.match(canonicalDigest({ a: 1 }), /^sha256:[0-9a-f]{64}$/);
  assert.equal(canonicalDigest({ a: 1, b: 2 }), canonicalDigest({ b: 2, a: 1 }));
  assert.notEqual(canonicalDigest({ a: 1 }), canonicalDigest({ a: 2 }));
});

// ---------------------------------------------------------------------------
// Manifest identity
// ---------------------------------------------------------------------------

test("the manifest hash is stable across repeated computation", () => {
  const manifest = validManifest();
  assert.equal(computeBaselineManifestHash(manifest), computeBaselineManifestHash(manifest));
  assert.match(computeBaselineManifestHash(manifest), /^sha256:[0-9a-f]{64}$/);
});

test("the manifest hash ignores the order the tool versions were captured in", () => {
  const forwards = validManifest();
  const backwards = validManifest({
    environment: {
      ...VALID_RUN_ENVIRONMENT,
      toolVersions: [...VALID_RUN_ENVIRONMENT.toolVersions].reverse(),
    },
  });
  assert.equal(computeBaselineManifestHash(forwards), computeBaselineManifestHash(backwards));
});

test("every methodology field moves the manifest hash", () => {
  const base = computeBaselineManifestHash(validManifest());
  const moved: Record<string, string> = {
    suiteHash: computeBaselineManifestHash(validManifest({ suiteHash: `sha256:${"9".repeat(64)}` })),
    policyHash: computeBaselineManifestHash(
      validManifest({ policyHash: `sha256:${"8".repeat(64)}` }),
    ),
    verifierVersion: computeBaselineManifestHash(
      validManifest({ verifierVersion: "independent-acceptance/2" }),
    ),
    model: computeBaselineManifestHash(
      validManifest({
        config: { ...VALID_SUITE_CONFIG, modelSettings: { model: "claude-sonnet-5" } },
      }),
    ),
    adapterVersion: computeBaselineManifestHash(
      validManifest({
        config: {
          ...VALID_SUITE_CONFIG,
          modeAdapterVersions: {
            ...VALID_SUITE_CONFIG.modeAdapterVersions,
            "ag-loop": "ag-loop/2",
          },
        },
      }),
    ),
    agCommit: computeBaselineManifestHash(
      validManifest({ environment: { ...VALID_RUN_ENVIRONMENT, agCommit: "d".repeat(40) } }),
    ),
  };
  for (const [field, hash] of Object.entries(moved)) {
    assert.notEqual(hash, base, `changing ${field} left the manifest hash unchanged`);
  }
});

test("the canonical manifest form is exported so two disagreeing hashes can be diffed", () => {
  const canonical = canonicalizeBaselineManifest(validManifest());
  assert.equal(canonicalDigest(JSON.parse(canonical)), computeBaselineManifestHash(validManifest()));
  assert.ok(!canonical.includes("\n"), canonical);
});

test("a manifest naming a mode without an adapter version is refused, not hashed", () => {
  const withoutAdapter = {
    ...VALID_SUITE_CONFIG,
    modeAdapterVersions: { "ag-loop": "ag-loop/1" },
  } as unknown as BenchmarkSuiteConfig;
  assert.throws(() => validManifest({ config: withoutAdapter }), TypeError);
});

test("the config hash ignores the order modes are presented in but not what they are", () => {
  const presented = computeSuiteConfigHash(VALID_SUITE_CONFIG);
  assert.equal(
    presented,
    computeSuiteConfigHash({ ...VALID_SUITE_CONFIG, modes: ["agent-solo", "ag-loop"] }),
  );
  assert.notEqual(presented, computeSuiteConfigHash({ ...VALID_SUITE_CONFIG, modes: ["ag-loop"] }));
  assert.notEqual(presented, computeSuiteConfigHash({ ...VALID_SUITE_CONFIG, repetitions: 5 }));
  assert.notEqual(
    presented,
    computeSuiteConfigHash({ ...VALID_SUITE_CONFIG, allowNetworkModels: true }),
  );
});

/**
 * The compression cohort enters the configuration identity only when a run
 * declares one. The first assertion is the one that matters: it pins the digest
 * of a cohort-less config to a literal, so a future field that quietly joined
 * the projection would be caught here rather than by every baseline recorded
 * before it silently becoming incomparable.
 */
test("a config that declares no compression cohort hashes exactly as it always did", () => {
  assert.ok(!Object.hasOwn(VALID_SUITE_CONFIG, "compressionCohort"));
  assert.equal(
    computeSuiteConfigHash(VALID_SUITE_CONFIG),
    // The projection as it stood before the cohort field existed, restated here
    // rather than referenced: a new field that quietly joined the real one would
    // otherwise re-identify every configuration ever hashed, and every baseline
    // recorded under it would become incomparable without anything being said.
    canonicalDigest({
      schemaVersion: VALID_SUITE_CONFIG.schemaVersion,
      suiteVersion: VALID_SUITE_CONFIG.suiteVersion,
      modes: [...VALID_SUITE_CONFIG.modes].sort(),
      repetitions: VALID_SUITE_CONFIG.repetitions,
      modelSettings: {
        model: VALID_SUITE_CONFIG.modelSettings.model,
        temperature: VALID_SUITE_CONFIG.modelSettings.temperature,
        maxOutputTokens: VALID_SUITE_CONFIG.modelSettings.maxOutputTokens,
      },
      limits: {
        timeoutMs: VALID_SUITE_CONFIG.limits.timeoutMs,
        tokenLimit: VALID_SUITE_CONFIG.limits.tokenLimit,
      },
      modeAdapterVersions: { ...VALID_SUITE_CONFIG.modeAdapterVersions },
      allowNetworkModels: VALID_SUITE_CONFIG.allowNetworkModels,
    }),
  );
});

test("declaring a cohort makes the run a visibly different configuration", () => {
  const withCohort = computeSuiteConfigHash({
    ...VALID_SUITE_CONFIG,
    compressionCohort: [baselineVariant(), variantById("worker-task-ir") as CompressionVariant],
  });
  assert.notEqual(withCohort, computeSuiteConfigHash(VALID_SUITE_CONFIG));
  assert.notEqual(
    withCohort,
    computeSuiteConfigHash({
      ...VALID_SUITE_CONFIG,
      compressionCohort: [baselineVariant()],
    }),
    "a cohort with another variant in it measured something else",
  );
});

test("the config hash ignores how a cohort was written down but not what it declares", () => {
  const cohort = [baselineVariant(), variantById("compiled-prompt") as CompressionVariant];
  const declared = computeSuiteConfigHash({ ...VALID_SUITE_CONFIG, compressionCohort: cohort });

  assert.equal(
    declared,
    computeSuiteConfigHash({
      ...VALID_SUITE_CONFIG,
      compressionCohort: [...cohort].reverse(),
    }),
    "the order variants are presented in is presentation, not measurement",
  );
  assert.equal(
    declared,
    computeSuiteConfigHash({
      ...VALID_SUITE_CONFIG,
      compressionCohort: cohort.map((variant) => ({
        ...variant,
        features: [...variant.features].reverse(),
      })),
    }),
    "a set of flags has no order either",
  );
});

// ---------------------------------------------------------------------------
// Immutability
// ---------------------------------------------------------------------------

test("a built manifest cannot be edited by whoever it is compared against", () => {
  const manifest = validManifest();
  assert.ok(Object.isFrozen(manifest));
  assert.ok(Object.isFrozen(manifest.identity));
  assert.ok(Object.isFrozen(manifest.identity.modeAdapterVersions));
  assert.ok(Object.isFrozen(manifest.toolVersions));
  assert.throws(() => {
    (manifest as { baselineId: string }).baselineId = "forged";
  }, TypeError);
});

test("freezing reaches through arrays and nested records", () => {
  const frozen = freezeDeep({ list: [{ nested: { deep: 1 } }] });
  assert.ok(Object.isFrozen(frozen.list[0]?.nested));
});

// ---------------------------------------------------------------------------
// The stored document
// ---------------------------------------------------------------------------

function problemsOf(result: ValidationResult<unknown>): readonly ValidationProblem[] {
  return result.ok ? [] : result.problems;
}

function problemAt(result: ValidationResult<unknown>, path: string): ValidationProblem | undefined {
  return problemsOf(result).find((problem) => problem.path === path);
}

/** A sealed baseline as it comes back off disk: serialized, then parsed. */
function storedDocument(): Record<string, unknown> {
  const sealed = sealBaselineDocument(validManifest(), validCreationRequest().samples);
  return JSON.parse(serializeBaselineDocument(sealed)) as Record<string, unknown>;
}

test("a created baseline carries its samples, its aggregates and its manifest hash", () => {
  const result = createBaselineDocument(validCreationRequest());
  assert.ok(result.ok, JSON.stringify(problemsOf(result)));
  const document = result.value;
  assert.equal(document.manifestHash, computeBaselineManifestHash(document.manifest));
  assert.equal(document.samples.length, 1);
  assert.deepEqual(document.aggregates, toModeMetrics(aggregateSamplesByMode(document.samples)));
  assert.equal(document.manifest.identity.configHash, computeSuiteConfigHash(VALID_SUITE_CONFIG));
});

test("the same baseline serializes to the same bytes", () => {
  const first = createBaselineDocument(validCreationRequest());
  const second = createBaselineDocument(validCreationRequest());
  assert.ok(first.ok && second.ok);
  assert.equal(serializeBaselineDocument(first.value), serializeBaselineDocument(second.value));
  assert.ok(serializeBaselineDocument(first.value).endsWith("\n"));
});

test("a stored baseline reads back as the document that was sealed", () => {
  const result = validateBaselineDocument(storedDocument());
  assert.ok(result.ok, JSON.stringify(problemsOf(result)));
  assert.equal(result.value.manifest.baselineId, "2026-08-07-opus-5");
  assert.equal(result.value.manifest.verifierVersion, validManifest().verifierVersion);
  assert.ok(Object.isFrozen(result.value.manifest));
});

test("a manifest edited after sealing no longer matches its own hash", () => {
  const stored = storedDocument();
  (stored["manifest"] as { modelSettings: { model: string } }).modelSettings.model = "cheap-model";
  const result = validateBaselineDocument(stored);
  assert.ok(!result.ok);
  assert.equal(problemAt(result, "manifestHash")?.code, "inconsistent");
});

test("aggregates that are not the fold of the stored samples are refused", () => {
  const stored = storedDocument();
  (stored["aggregates"] as Array<{ metrics: { sampleCount: number } }>)[0]!.metrics.sampleCount = 99;
  const result = validateBaselineDocument(stored);
  assert.ok(!result.ok);
  assert.equal(problemAt(result, "aggregates")?.code, "inconsistent");
});

test("a document missing its aggregates is refused rather than recomputed into shape", () => {
  const stored = storedDocument();
  delete stored["aggregates"];
  const result = validateBaselineDocument(stored);
  assert.ok(!result.ok);
  assert.equal(problemAt(result, "aggregates")?.code, "missing");
});

test("a field this schema version does not define is reported, not ignored", () => {
  const stored = storedDocument();
  stored["notes"] = "hand written";
  const result = validateBaselineDocument(stored);
  assert.ok(!result.ok);
  assert.equal(problemAt(result, "notes")?.code, "unknown-field");
});

test("a corrupt sample refuses the whole baseline (BENCH-5)", () => {
  const stored = storedDocument();
  (stored["samples"] as Array<Record<string, unknown>>)[0]!["mode"] = "hand-run";
  const result = validateBaselineDocument(stored);
  assert.ok(!result.ok);
  assert.ok(
    problemsOf(result).some((problem) => problem.path.startsWith("samples[0]")),
    JSON.stringify(problemsOf(result)),
  );
});

test("a baseline with no sample measured nothing and is refused", () => {
  const result = createBaselineDocument(validCreationRequest({ samples: [] }));
  assert.ok(!result.ok);
  assert.equal(problemAt(result, "samples")?.code, "empty");
});

test("a run that cannot be attributed to a commit is never stored", () => {
  const result = createBaselineDocument(
    validCreationRequest({ environment: { ...VALID_RUN_ENVIRONMENT, agCommit: "" } }),
  );
  assert.ok(!result.ok);
  assert.equal(problemAt(result, "manifest.identity.agCommit")?.code, "empty");
});

test("a local-time stamp cannot be ordered against another machine's and is refused", () => {
  const result = createBaselineDocument(validCreationRequest({ createdAt: "2026-08-07 09:00:00" }));
  assert.ok(!result.ok);
  assert.equal(problemAt(result, "manifest.createdAt")?.code, "malformed");
});

test("a baseline id a file name cannot carry is refused at creation", () => {
  const result = createBaselineDocument(validCreationRequest({ baselineId: "Opus 5 / run 2" }));
  assert.ok(!result.ok);
  assert.equal(problemAt(result, "manifest.baselineId")?.code, "malformed");
});

test("the published baseline view states what the manifest recorded", () => {
  const result = createBaselineDocument(validCreationRequest());
  assert.ok(result.ok);
  const published = toBenchmarkBaseline(result.value);
  assert.equal(published.createdAt, "2026-08-07T09:00:00.000Z");
  assert.deepEqual(published.identity, result.value.manifest.identity);
  assert.deepEqual(published.modelSettings, VALID_SUITE_CONFIG.modelSettings);
  assert.deepEqual(published.environment, VALID_RUN_ENVIRONMENT.environment);
  assert.deepEqual(published.samples, [validSample()]);
});
