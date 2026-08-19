// VQ-203 characterization (PAR-1): kompresijos politikos branduolio runner'is prieš
// pažodinę AG_loop fixture kopiją. Pipeline atkartoja normatyvinę tvarką be FS/log:
// parse → (arrest view) → apply → resolve deps → canary. Record režimo NĖRA.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { parseContextCompressionConfig } from "../domain/policies/compression/features.js";
import {
  canaryContextCompressionFeatures,
  contextCompressionCanaryBucket,
  isTaskInContextCompressionCanary,
} from "../domain/policies/compression/canary.js";
import {
  applyContextCompressionArrest,
  defaultContextCompressionArrestState,
  parseContextCompressionArrestState,
  type ContextCompressionArrestView,
} from "../domain/policies/compression/arrest.js";
import {
  contextCompressionArrestDecision,
  describeCompressionDependencyNotice,
  resolveCompressionFeatureDependencies,
} from "../domain/policies/compression/dependencies.js";

type PolicyCase = {
  id: string;
  kind: "pipeline" | "bucket";
  config?: unknown;
  arrestState?: unknown;
  taskId?: string;
  pairs?: Array<[string, string]>;
  expect: Record<string, unknown>;
};

const fixturePath = path.resolve(
  process.cwd(),
  "src",
  "tests",
  "fixtures",
  "characterization",
  "compression-policy-verdicts.json",
);

const fixture: { schema_version: number; cases: PolicyCase[] } = JSON.parse(await readFile(fixturePath, "utf8"));

function runCase(policyCase: PolicyCase): unknown {
  if (policyCase.kind === "bucket") {
    return { buckets: (policyCase.pairs ?? []).map(([taskId, salt]) => contextCompressionCanaryBucket(taskId, salt)) };
  }
  let parsed;
  try {
    parsed = parseContextCompressionConfig(policyCase.config);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { throws: message.split("\n")[0] };
  }
  const view: ContextCompressionArrestView =
    policyCase.arrestState === undefined
      ? { state: defaultContextCompressionArrestState(), unreadable: false }
      : parseContextCompressionArrestState(policyCase.arrestState);
  const { config, notices } = resolveCompressionFeatureDependencies(applyContextCompressionArrest(parsed, view), view);
  return {
    features: config.features,
    notices: notices.map(describeCompressionDependencyNotice),
    arrest_decision: contextCompressionArrestDecision(view) ?? null,
    ...(policyCase.taskId === undefined
      ? {}
      : {
          canary_cohort: isTaskInContextCompressionCanary(config, policyCase.taskId),
          canary_features: canaryContextCompressionFeatures(config, policyCase.taskId),
        }),
  };
}

test("compression-policy fixture is well-formed (schema v1, unique ids)", () => {
  assert.equal(fixture.schema_version, 1);
  assert.ok(fixture.cases.length >= 12, "fixture must keep its recorded coverage");
  const ids = fixture.cases.map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length, "case ids must be unique");
});

for (const policyCase of fixture.cases) {
  test(`compression-policy contract: ${policyCase.id}`, () => {
    const actual = JSON.parse(JSON.stringify(runCase(policyCase)));
    assert.deepStrictEqual(actual, policyCase.expect, policyCase.id);
  });
}
