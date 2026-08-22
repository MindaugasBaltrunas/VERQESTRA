import assert from "node:assert/strict";
import test from "node:test";

import { CANONICAL_DIGEST_PATTERN } from "../domain/baseline/canonical-json.js";
import {
  ALL_FEATURES_VARIANT_ID,
  BASELINE_VARIANT_ID,
  COMPRESSION_COHORT,
  baselineVariant,
  variantById,
  variantByIdentity,
} from "../domain/compression/cohort.js";
import {
  COMPRESSION_FEATURES,
  COMPRESSION_HOOK_PROFILES,
  CONTEXT_COMPRESSION_REGISTRY_VERSION,
} from "../domain/compression/features.js";
import {
  computeCompressionVariantIdentity,
  defineCompressionVariant,
  type CompressionVariant,
} from "../domain/compression/variant.js";
import { IDENTIFIER_PATTERN } from "../domain/validation.js";

/**
 * What a compression variant owes the rest of the package (task 0029).
 *
 * The identity is the only thing two runs are matched on, so the properties
 * asserted here are the ones a stored sample's attribution rests on: the same
 * flags always digest to the same value whatever order they were given in,
 * different wiring digests differently, and a cohort entry can always be stored
 * on the sample it produced.
 */

test("a variant identity depends on the flag set and not on the order it was given in", () => {
  const forwards = computeCompressionVariantIdentity(["compact_dsl", "worker_task_ir"], "unwired");
  const backwards = computeCompressionVariantIdentity(["worker_task_ir", "compact_dsl"], "unwired");

  assert.equal(forwards, backwards, "a set of flags has no order");
  assert.equal(forwards, computeCompressionVariantIdentity(["compact_dsl", "worker_task_ir"], "unwired"));
  assert.match(forwards, CANONICAL_DIGEST_PATTERN);
});

test("a flag enabled twice is the same variant as the flag enabled once", () => {
  assert.equal(
    computeCompressionVariantIdentity(["compact_dsl", "compact_dsl"], "unwired"),
    computeCompressionVariantIdentity(["compact_dsl"], "unwired"),
  );
});

test("adding a flag changes the identity", () => {
  assert.notEqual(
    computeCompressionVariantIdentity(["worker_task_ir"], "unwired"),
    computeCompressionVariantIdentity(["worker_task_ir", "compact_dsl"], "unwired"),
  );
});

test("the hook profile is part of the identity, so shadow and handler are two variants", () => {
  const shadow = variantById("bash-digest-shadow");
  const handler = variantById("bash-digest-handler");

  assert.ok(shadow !== undefined && handler !== undefined);
  assert.deepEqual(shadow.features, handler.features, "the two enable exactly the same flag");
  assert.notEqual(
    shadow.identity,
    handler.identity,
    "same flag, different observable behaviour: one population would hide the difference",
  );
});

test("a variant declares the features it was built from, canonically spelled", () => {
  const variant = defineCompressionVariant({
    id: "compiled-prompt-copy",
    features: ["compact_dsl", "worker_task_ir", "compact_dsl"],
    hookProfile: "unwired",
  });

  assert.deepEqual(variant.features, ["compact_dsl", "worker_task_ir"]);
  assert.equal(
    variant.identity,
    computeCompressionVariantIdentity(["worker_task_ir", "compact_dsl"], "unwired"),
  );
});

test("an id a sample could not carry is refused where it is declared, not where it is stored", () => {
  for (const id of ["Compiled Prompt", "compiled_prompt", " compiled-prompt", ""]) {
    assert.throws(
      () => defineCompressionVariant({ id, features: [], hookProfile: "unwired" }),
      TypeError,
      `"${id}" was accepted as a variant id`,
    );
  }
});

test("every cohort id can be stored on a sample and is declared once", () => {
  const ids = COMPRESSION_COHORT.map((variant) => variant.id);
  for (const id of ids) assert.match(id, IDENTIFIER_PATTERN);
  assert.equal(new Set(ids).size, ids.length, "two variants sharing an id would key one population");

  const identities = COMPRESSION_COHORT.map((variant) => variant.identity);
  assert.equal(new Set(identities).size, identities.length);
  for (const identity of identities) assert.match(identity, CANONICAL_DIGEST_PATTERN);
});

test("the cohort declares only flags and hook profiles this registry version knows", () => {
  for (const variant of COMPRESSION_COHORT) {
    for (const feature of variant.features) {
      assert.ok(
        (COMPRESSION_FEATURES as readonly string[]).includes(feature),
        `"${feature}" is not a flag of registry version ${CONTEXT_COMPRESSION_REGISTRY_VERSION}`,
      );
    }
    assert.ok((COMPRESSION_HOOK_PROFILES as readonly string[]).includes(variant.hookProfile));
  }
});

/**
 * The cohort covers the seven things acceptance criterion 1 names, and the two
 * that are combinations rather than flags are present as combinations. Written
 * as an exact list, so a variant quietly added or dropped fails here rather than
 * changing what a report claims to have measured.
 */
test("the cohort is exactly the frozen nine, in declaration order", () => {
  assert.deepEqual(
    COMPRESSION_COHORT.map((variant) => `${variant.id} [${variant.features.join("+")}] ${variant.hookProfile}`),
    [
      "baseline [] unwired",
      "worker-task-ir [worker_task_ir] unwired",
      "compact-dsl [compact_dsl] unwired",
      "symbol-slices [symbol_slices] unwired",
      "compiled-prompt [compact_dsl+worker_task_ir] unwired",
      "bash-digest-shadow [bash_output_digest] unwired",
      "bash-digest-handler [bash_output_digest] bash-digest-handler",
      "dispatch-tool-schema [dispatch_tool_schema] unwired",
      "all-features [bash_output_digest+compact_dsl+dispatch_tool_schema+symbol_slices+worker_task_ir] bash-digest-handler",
    ],
  );
  assert.equal(baselineVariant().id, BASELINE_VARIANT_ID);
  assert.deepEqual(
    [...(variantById(ALL_FEATURES_VARIANT_ID)?.features ?? [])].sort(),
    [...COMPRESSION_FEATURES].sort(),
    "the full combination enables every declared flag",
  );
});

test("a variant is sealed, so nothing it is compared against can edit it", () => {
  const variant = COMPRESSION_COHORT[1] as CompressionVariant;
  assert.ok(Object.isFrozen(variant));
  assert.ok(Object.isFrozen(variant.features));
  assert.throws(() => {
    (variant as { id: string }).id = "forged";
  }, TypeError);
});

test("an unknown id or identity yields no variant rather than an invented one", () => {
  assert.equal(variantById("worker-task-ir")?.id, "worker-task-ir");
  assert.equal(variantById("no-such-variant"), undefined);
  assert.equal(variantByIdentity(`sha256:${"0".repeat(64)}`), undefined);
  assert.equal(
    variantByIdentity((COMPRESSION_COHORT[2] as { identity: string }).identity)?.id,
    "compact-dsl",
  );
});
