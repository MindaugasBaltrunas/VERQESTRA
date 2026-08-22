import assert from "node:assert/strict";
import test from "node:test";

import { guardComparison, refusedComparison } from "../application/baseline/comparability-gate.js";
import {
  assessComparability,
  comparabilityRefusalCodes,
  COMPARABILITY_REFUSAL_CODES,
  REQUIRED_METHODOLOGY_FIELDS,
  type ComparabilityAssessment,
} from "../domain/baseline/compatibility.js";
import {
  BASELINE_MANIFEST_SCHEMA_VERSION,
  type BaselineManifest,
} from "../domain/baseline/manifest.js";
import { EXECUTION_MODES } from "../domain/result.js";
import {
  manifestWith,
  VALID_RUN_ENVIRONMENT,
  VALID_SUITE_CONFIG,
  validManifest,
} from "./baseline-fixtures.js";

/**
 * BENCH-8 comparability tests.
 *
 * The gate is asserted from both sides. A pair that measured the same thing must
 * be accepted, or the benchmark can never report anything; a pair that differs
 * in any required methodology field must be refused with `inconclusive`, or the
 * benchmark reports a difference it cannot attribute. The advisory cases in
 * between are the ones a weaker gate gets wrong in the expensive direction: a
 * comparison refused for running on another operating system is a comparison
 * nobody can ever run twice.
 */

function refusalSubjects(assessment: ComparabilityAssessment): readonly string[] {
  return assessment.refusals.map((refusal) => refusal.subject);
}

// ---------------------------------------------------------------------------
// Accepting a comparable pair
// ---------------------------------------------------------------------------

test("two runs of the same methodology are comparable", () => {
  const baseline = validManifest();
  const current = validManifest({
    environment: { ...VALID_RUN_ENVIRONMENT, agCommit: "e".repeat(40) },
  });
  const assessment = assessComparability(baseline, current);
  assert.ok(assessment.comparable, JSON.stringify(assessment.refusals));
  assert.deepEqual(assessment.refusals, []);
  // A differing AG commit is the variable under measurement, so it raises nothing.
  assert.deepEqual(assessment.limitations, []);
  assert.equal(guardComparison(baseline, current).ok, true);
});

test("a pair sharing an AG commit is comparable but cannot attribute a difference to AG", () => {
  const assessment = assessComparability(validManifest(), validManifest());
  assert.ok(assessment.comparable);
  assert.ok(
    assessment.limitations.some((limitation) => limitation.includes("run-to-run variance")),
    JSON.stringify(assessment.limitations),
  );
});

test("a different host weakens the comparison instead of refusing it", () => {
  const current = manifestWith({
    environment: { platform: "linux", arch: "arm64", nodeVersion: "v22.16.0", cpuCount: 8 },
    osRelease: "Linux 6.8.0",
  });
  const assessment = assessComparability(validManifest(), current);
  assert.ok(assessment.comparable, JSON.stringify(assessment.refusals));
  const reported = [
    "environment.platform",
    "environment.arch",
    "environment.nodeVersion",
    "environment.cpuCount",
    "osRelease",
  ];
  for (const field of reported) {
    assert.ok(
      assessment.limitations.some((limitation) => limitation.startsWith(`${field} differs`)),
      `${field} produced no limitation: ${JSON.stringify(assessment.limitations)}`,
    );
  }
});

test("a different toolchain is reported, because a check can fail for its own reasons", () => {
  const current = manifestWith({
    toolVersions: [
      { tool: "git", version: "git version 2.30.0" },
      { tool: "node", version: "v22.15.0" },
      { tool: "pnpm", version: "9.15.9" },
    ],
  });
  const assessment = assessComparability(validManifest(), current);
  assert.ok(assessment.comparable);
  assert.ok(
    assessment.limitations.some((limitation) => limitation.includes("different tool versions")),
    JSON.stringify(assessment.limitations),
  );
});

// ---------------------------------------------------------------------------
// Refusing an incomparable pair
// ---------------------------------------------------------------------------

test("every required methodology field refuses the comparison when it differs", () => {
  const baseline = validManifest();
  const changed: ReadonlyArray<readonly [string, BaselineManifest]> = [
    [
      "identity.suiteHash",
      validManifest({ suiteHash: `sha256:${"1".repeat(64)}` }),
    ],
    ["suiteVersion", manifestWith({ suiteVersion: "2.0.0" })],
    [
      "identity.configHash",
      validManifest({ config: { ...VALID_SUITE_CONFIG, repetitions: 5 } }),
    ],
    [
      "identity.policyHash",
      validManifest({ policyHash: `sha256:${"2".repeat(64)}` }),
    ],
    [
      "modelSettings.model",
      validManifest({
        config: { ...VALID_SUITE_CONFIG, modelSettings: { model: "claude-haiku-4-5-20251001" } },
      }),
    ],
    [
      "modelSettings.temperature",
      validManifest({
        config: {
          ...VALID_SUITE_CONFIG,
          modelSettings: { ...VALID_SUITE_CONFIG.modelSettings, temperature: 1 },
        },
      }),
    ],
    [
      "modelSettings.maxOutputTokens",
      validManifest({
        config: {
          ...VALID_SUITE_CONFIG,
          modelSettings: { ...VALID_SUITE_CONFIG.modelSettings, maxOutputTokens: 64_000 },
        },
      }),
    ],
    ["verifierVersion", validManifest({ verifierVersion: "independent-acceptance/2" })],
    [
      "identity.modeAdapterVersions.ag-loop",
      validManifest({
        config: {
          ...VALID_SUITE_CONFIG,
          modeAdapterVersions: { ...VALID_SUITE_CONFIG.modeAdapterVersions, "ag-loop": "ag-loop/2" },
        },
      }),
    ],
  ];

  for (const [field, current] of changed) {
    const assessment = assessComparability(baseline, current);
    assert.ok(!assessment.comparable, `${field} did not refuse the comparison`);
    assert.ok(
      refusalSubjects(assessment).includes(field),
      `${field} was not named as the reason: ${JSON.stringify(refusalSubjects(assessment))}`,
    );
  }
});

test("the required field list covers every hash, model setting and version a manifest carries", () => {
  const fields = REQUIRED_METHODOLOGY_FIELDS.map((entry) => entry.field);
  for (const expected of [
    "identity.suiteHash",
    "identity.configHash",
    "identity.policyHash",
    "suiteVersion",
    "modelSettings.model",
    "modelSettings.temperature",
    "modelSettings.maxOutputTokens",
    "verifierVersion",
    ...EXECUTION_MODES.map((mode) => `identity.modeAdapterVersions.${mode}`),
  ]) {
    assert.ok(fields.includes(expected), `${expected} is not a required methodology field`);
  }
  // The AG commit is the variable under measurement and must never be required.
  assert.ok(!fields.includes("identity.agCommit"));
});

test("a model setting present on one side only is a mismatch, not a default", () => {
  const withoutTemperature = validManifest({
    config: { ...VALID_SUITE_CONFIG, modelSettings: { model: "claude-opus-5" } },
  });
  const assessment = assessComparability(validManifest(), withoutTemperature);
  assert.ok(!assessment.comparable);
  assert.ok(refusalSubjects(assessment).includes("modelSettings.temperature"));
});

test("an adapter version a manifest never recorded is a mismatch even against itself", () => {
  const incomplete = manifestWith({
    identity: {
      ...validManifest().identity,
      modeAdapterVersions: { "ag-loop": "ag-loop/1" } as unknown as BaselineManifest["identity"]["modeAdapterVersions"],
    },
  });
  const assessment = assessComparability(incomplete, incomplete);
  assert.ok(!assessment.comparable);
  assert.ok(refusalSubjects(assessment).includes("identity.modeAdapterVersions.agent-solo"));
});

test("a run without an AG commit cannot be compared in either direction", () => {
  const unattributable = manifestWith({
    identity: { ...validManifest().identity, agCommit: "" },
  });
  for (const [baseline, current] of [
    [unattributable, validManifest()],
    [validManifest(), unattributable],
  ] as const) {
    const assessment = assessComparability(baseline, current);
    assert.ok(!assessment.comparable);
    assert.ok(
      comparabilityRefusalCodes(assessment).includes(
        COMPARABILITY_REFUSAL_CODES.unattributableRun,
      ),
    );
  }
});

test("a manifest from a schema version this build does not read is refused", () => {
  const future = manifestWith({ schemaVersion: BASELINE_MANIFEST_SCHEMA_VERSION + 1 });
  const assessment = assessComparability(validManifest(), future);
  assert.ok(!assessment.comparable);
  assert.ok(
    comparabilityRefusalCodes(assessment).includes(
      COMPARABILITY_REFUSAL_CODES.unsupportedManifestSchema,
    ),
  );
  assert.ok(refusalSubjects(assessment).includes("current"));
});

test("every required mismatch is reported, not only the first", () => {
  const current = validManifest({
    suiteHash: `sha256:${"3".repeat(64)}`,
    policyHash: `sha256:${"4".repeat(64)}`,
    verifierVersion: "independent-acceptance/2",
  });
  const assessment = assessComparability(validManifest(), current);
  assert.equal(assessment.refusals.length, 3);
});

// ---------------------------------------------------------------------------
// What a refusal publishes
// ---------------------------------------------------------------------------

test("a refused pair produces an inconclusive comparison, never a stable one", () => {
  const current = validManifest({ suiteHash: `sha256:${"5".repeat(64)}` });
  const gate = guardComparison(validManifest(), current);
  assert.equal(gate.ok, false);
  assert.ok(!gate.ok);
  assert.equal(gate.comparison.verdict, "inconclusive");
  assert.deepEqual(gate.comparison.reasons, [COMPARABILITY_REFUSAL_CODES.methodologyMismatch]);
  assert.deepEqual(gate.comparison.scenarios, []);
  assert.ok(
    gate.comparison.limitations.some((limitation) =>
      limitation.startsWith("identity.suiteHash:"),
    ),
    JSON.stringify(gate.comparison.limitations),
  );
  assert.ok(
    gate.comparison.limitations.some((limitation) =>
      limitation.includes("no scenario was compared"),
    ),
  );
});

test("the published reasons are bare codes, deduplicated", () => {
  const current = validManifest({
    suiteHash: `sha256:${"6".repeat(64)}`,
    policyHash: `sha256:${"7".repeat(64)}`,
  });
  const comparison = refusedComparison(assessComparability(validManifest(), current));
  assert.deepEqual(comparison.reasons, [COMPARABILITY_REFUSAL_CODES.methodologyMismatch]);
});

test("an accepted pair carries its limitations forward for the report to show", () => {
  const current = manifestWith({ osRelease: "Windows_NT 10.0.22631" });
  const gate = guardComparison(validManifest(), current);
  assert.ok(gate.ok);
  assert.ok(gate.limitations.some((limitation) => limitation.startsWith("osRelease differs")));
});
