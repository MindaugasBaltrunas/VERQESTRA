// Learning atminties ir emiterio testai (VQ-305 3/3-f). Elgesio etalonas: AG_loop
// learning-memory.test.ts + learning-emitter.test.ts (sutraukta iki portų lygio).

import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import {
  emitLearningEventsForTaskTransition,
  failurePatternRecommendationThreshold,
  failureSignature,
} from "../application/learning/learning-emitter.js";
import {
  appendLearningMemoryRecord,
  decideLearningRecommendation,
  queryLearningMemory,
  readLearningMemoryRecords,
  summarizeLearningMemory,
} from "../application/learning/learning-memory.js";
import type { LearningFsPort } from "../application/learning/ports.js";

const RUNTIME_ROOT = path.join(path.resolve("/repo"), "vq");

function fakeFs(): LearningFsPort {
  const norm = (p: string): string => p.replace(/\\/g, "/");
  const store = new Map<string, string>();
  return {
    readTextFileIfExists: async (p) => store.get(norm(p)),
    appendTextFile: async (p, text) => {
      store.set(norm(p), (store.get(norm(p)) ?? "") + text);
    },
    writeTextFile: async (p, content) => {
      store.set(norm(p), content);
    },
    makeDirectory: async () => {},
  };
}

test("append/read round-trip: stabilus id, rūšiuotos etiketės, pending default rekomendacijai", async () => {
  const fs = fakeFs();
  const written = await appendLearningMemoryRecord(fs, RUNTIME_ROOT, {
    type: "policy_recommendation",
    task_id: "T-1",
    summary: "  Peržiūrėti šabloną  ",
    labels: ["zeta", "alpha", "zeta", " "],
    evidence: ["b", "a"],
  });
  assert.equal(written.summary, "Peržiūrėti šabloną");
  assert.deepEqual(written.labels, ["alpha", "zeta"]);
  assert.deepEqual(written.evidence, ["a", "b"]);
  assert.equal(written.recommendation_status, "pending");
  assert.match(written.id, /^policy-recommendation-t-1/);

  const records = await readLearningMemoryRecords(fs, RUNTIME_ROOT);
  assert.equal(records.length, 1);
  assert.deepEqual(records[0], written);
});

test("query filtruoja pagal task/type/label ir riboja kiekį; summarize skaičiuoja paskutinį sprendimą", async () => {
  const fs = fakeFs();
  await appendLearningMemoryRecord(fs, RUNTIME_ROOT, {
    type: "task_outcome",
    task_id: "T-1",
    summary: "done: ok",
    labels: ["done"],
    evidence: [],
    ts: "2026-08-01T00:00:00.000Z",
  });
  const recommendation = await appendLearningMemoryRecord(fs, RUNTIME_ROOT, {
    type: "policy_recommendation",
    task_id: "T-2",
    summary: "Peržiūrėti",
    labels: ["auto-emitted"],
    evidence: [],
    ts: "2026-08-01T00:01:00.000Z",
  });

  const byLabel = await queryLearningMemory(fs, RUNTIME_ROOT, { label: "auto-emitted" });
  assert.deepEqual(byLabel.map((record) => record.id), [recommendation.id]);
  const limited = await queryLearningMemory(fs, RUNTIME_ROOT, { limit: 1 });
  assert.equal(limited.length, 1);

  await decideLearningRecommendation(fs, RUNTIME_ROOT, recommendation.id, "approved", ["review:ok"]);
  const summary = await summarizeLearningMemory(fs, RUNTIME_ROOT);
  // AN-1 (auditas 2026-09-05): sprendimas yra NAUJA to paties id eilutė, ne antra rekomendacija —
  // suvestinė dedup'ina pagal id (paskutinis laimi), kaip UI ją ir rodo. Žurnale eilučių trys.
  assert.equal((await readLearningMemoryRecords(fs, RUNTIME_ROOT)).length, 3);
  assert.equal(summary.records, 2);
  assert.equal(summary.by_type.policy_recommendation, 1);
  assert.equal(summary.by_type.task_outcome, 1);
  assert.equal(summary.approved_recommendations, 1);
  assert.equal(summary.pending_recommendations, 0);

  await assert.rejects(
    () => decideLearningRecommendation(fs, RUNTIME_ROOT, "nesamas-id", "rejected"),
    /Learning recommendation not found/,
  );
});

test("summarize: du įrašai tuo pačiu id — vienas įrašas suvestinėje", async () => {
  const fs = fakeFs();
  const base = {
    type: "task_outcome" as const,
    task_id: "T-9",
    summary: "done: ok",
    labels: [],
    evidence: [],
  };
  const first = await appendLearningMemoryRecord(fs, RUNTIME_ROOT, { ...base, ts: "2026-08-01T00:00:00.000Z" });
  const second = await appendLearningMemoryRecord(fs, RUNTIME_ROOT, {
    ...base,
    id: first.id,
    labels: ["pataisyta"],
    ts: "2026-08-01T00:05:00.000Z",
  });
  assert.equal(second.id, first.id);

  const summary = await summarizeLearningMemory(fs, RUNTIME_ROOT);
  assert.equal(summary.records, 1);
  assert.equal(summary.by_type.task_outcome, 1);
});

test("failureSignature normalizuoja skaitiklius ir grupuoja pagal fazę", () => {
  assert.equal(
    failureSignature({ phase: "preflight", to_state: "human-review", reason: "preflight_failed=2" }),
    "preflight:preflight_failed",
  );
  assert.equal(failureSignature({ to_state: "error", reason: "" }), "error:unknown");
});

test("emiteris rašo outcome + pattern, o rekomendaciją kelia LYGIAI ties slenksčiu", async () => {
  const fs = fakeFs();
  const failure = (index: number) => ({
    task_id: `T-${index}`,
    to_state: "error",
    reason: "preflight_failed=2",
    phase: "preflight",
  });

  for (let index = 0; index < failurePatternRecommendationThreshold; index += 1) {
    await emitLearningEventsForTaskTransition(fs, RUNTIME_ROOT, failure(index));
  }
  let records = await readLearningMemoryRecords(fs, RUNTIME_ROOT);
  assert.equal(records.filter((record) => record.type === "failure_pattern").length, 3);
  const recommendations = records.filter((record) => record.type === "policy_recommendation");
  assert.equal(recommendations.length, 1);
  assert.equal(recommendations[0]!.recommendation_status, "pending");
  assert.deepEqual(recommendations[0]!.evidence, ["task:T-0", "task:T-1", "task:T-2"]);

  // Ketvirta to paties parašo nesėkmė rekomendacijos nebedubliuoja (=== slenkstis).
  await emitLearningEventsForTaskTransition(fs, RUNTIME_ROOT, failure(3));
  records = await readLearningMemoryRecords(fs, RUNTIME_ROOT);
  assert.equal(records.filter((record) => record.type === "policy_recommendation").length, 1);
});

test("emiteris praleidžia apibendrintą human-review dublikatą ir ne-terminalinius perėjimus", async () => {
  const fs = fakeFs();
  await emitLearningEventsForTaskTransition(fs, RUNTIME_ROOT, {
    task_id: "T-1",
    to_state: "human-review",
    reason: "TASK HUMAN REVIEW: T-1 parked",
  });
  await emitLearningEventsForTaskTransition(fs, RUNTIME_ROOT, {
    task_id: "T-1",
    to_state: "delegated",
    reason: "dispatched",
  });
  assert.deepEqual(await readLearningMemoryRecords(fs, RUNTIME_ROOT), []);
});
