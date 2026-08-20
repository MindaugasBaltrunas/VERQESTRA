// Panašių taskų analitikos testai (VQ-305 3/3-f). Elgesio etalonas: AG_loop
// similar-task-analytics.test.ts (sutraukta iki branduolio elgesio).

import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import {
  detectOptimizationCandidates,
  groupTaskUsageByFamily,
  taskFamilyKey,
} from "../application/learning/similar-task-families.js";
import {
  buildTokenAnalyticsSnapshot,
  mergeCanonicalModelBuckets,
  readTokenAnalyticsHistory,
  updateTokenAnalyticsSnapshot,
} from "../application/learning/token-analytics-snapshot.js";
import type { LearningFsPort } from "../application/learning/ports.js";
import type { LearningTaskEventRecord, LearningUsageRecord } from "../application/learning/usage-view.js";

function usage(taskId: string, tokens: number, overrides: Partial<LearningUsageRecord> = {}): LearningUsageRecord {
  return {
    ts: "2026-08-10T00:00:00.000Z",
    task_id: taskId,
    phase: "dispatch",
    model: "claude-sonnet-5",
    input_tokens: tokens,
    ...overrides,
  };
}

test("taskFamilyKey: skaitinis prefiksas laimi, be jo — reikšmingi pavadinimo tokenai", () => {
  assert.equal(taskFamilyKey("1203-dispatch-retry"), "1203");
  assert.equal(taskFamilyKey("dispatch-retry-watchdog-fix"), "dispatch-retry-watchdog");
});

test("groupTaskUsageByFamily sujungia skirtingų numerių grupes su persidengiančiais tokenais", () => {
  const groups = groupTaskUsageByFamily([
    usage("0101-dispatch-retry-watchdog", 100),
    usage("0202-dispatch-retry-watchdog-extra", 300),
    usage("0909-visai-kita-tema", 50),
  ]);
  assert.equal(groups.length, 2);
  const merged = groups[0]!;
  assert.equal(merged.familyKey, "0101");
  assert.deepEqual(merged.taskIds, ["0101-dispatch-retry-watchdog", "0202-dispatch-retry-watchdog-extra"]);
  assert.equal(merged.totalTokens, 400);
  assert.equal(merged.medianTokens, 200);
});

test("detectOptimizationCandidates: outlier'is lyginamas su bendraamžių mediana ir gauna hint'ą", () => {
  const records = [
    usage("0300-schema-migration-a", 100),
    usage("0300-schema-migration-b", 110),
    usage("0300-schema-migration-c", 500),
  ];
  const events: LearningTaskEventRecord[] = [
    { ts: "1", task_id: "0300-schema-migration-c", to_state: "delegated" },
    { ts: "2", task_id: "0300-schema-migration-c", to_state: "error" },
    { ts: "3", task_id: "0300-schema-migration-c", to_state: "done" },
  ];
  const candidates = detectOptimizationCandidates(groupTaskUsageByFamily(records), records, events);
  assert.equal(candidates.length, 1);
  const candidate = candidates[0]!;
  assert.equal(candidate.taskId, "0300-schema-migration-c");
  assert.equal(candidate.groupMedianTokens, 105);
  assert.match(candidate.reasonHint, /daug repair ciklų \(2\)/);
});

test("buildTokenAnalyticsSnapshot: fazių/modelių bucket'ai, cache hit rate ir repair share", () => {
  const records = [
    usage("T-1", 0, { phase: "preflight-fastpath" }),
    usage("T-1", 100, { phase: "preflight" }),
    usage("T-1", 200, { phase: "dispatch", cache_read_input_tokens: 300, cache_creation_input_tokens: 100 }),
    usage("T-2", 50, { model: "sonnet" }),
  ];
  const events: LearningTaskEventRecord[] = [
    { ts: "1", task_id: "T-1", to_state: "delegated" },
    { ts: "2", task_id: "T-1", to_state: "done" },
  ];
  const snapshot = buildTokenAnalyticsSnapshot(records, events, new Date("2026-08-20T12:00:00.000Z"));
  assert.equal(snapshot.totals.records, 4);
  assert.equal(snapshot.totals.uniqueTasks, 2);
  assert.equal(snapshot.fastPathHitRate.preflight, 0.5);
  // cache_read / (input + cache_read + cache_creation) = 300 / (350 + 300 + 100)
  assert.equal(snapshot.cacheHitRate, 300 / 750);
  assert.equal(snapshot.repairShare, 0.5);
  assert.deepEqual(
    snapshot.tokensByModel.map((bucket) => bucket.key),
    ["sonnet"],
  );
});

test("mergeCanonicalModelBuckets suploja pilną model ID ir tier vardą į vieną eilutę", () => {
  const merged = mergeCanonicalModelBuckets([
    { key: "claude-sonnet-5", totalTokens: 100 },
    { key: "sonnet", totalTokens: 50 },
    { key: "none", totalTokens: 5 },
  ]);
  assert.deepEqual(merged, [
    { key: "sonnet", totalTokens: 150 },
    { key: "none", totalTokens: 5 },
  ]);
});

test("updateTokenAnalyticsSnapshot persistina snapshot'ą ir istoriją per portą", async () => {
  const norm = (p: string): string => p.replace(/\\/g, "/");
  const store = new Map<string, string>();
  const fs: LearningFsPort = {
    readTextFileIfExists: async (p) => store.get(norm(p)),
    appendTextFile: async (p, text) => {
      store.set(norm(p), (store.get(norm(p)) ?? "") + text);
    },
    writeTextFile: async (p, content) => {
      store.set(norm(p), content);
    },
    makeDirectory: async () => {},
  };
  const runtimeRoot = path.join(path.resolve("/repo"), "vq");
  store.set(
    norm(path.join(runtimeRoot, "logs", "token-usage.jsonl")),
    `${JSON.stringify(usage("T-1", 100))}\nnot-json\n`,
  );

  const first = await updateTokenAnalyticsSnapshot(fs, runtimeRoot, new Date("2026-08-20T12:00:00.000Z"));
  const second = await updateTokenAnalyticsSnapshot(fs, runtimeRoot, new Date("2026-08-20T13:00:00.000Z"));
  assert.equal(first?.totals.totalTokens, 100);
  assert.equal(second?.generatedAt, "2026-08-20T13:00:00.000Z");

  const history = await readTokenAnalyticsHistory(fs, runtimeRoot);
  assert.equal(history.length, 2);
  assert.equal(history[1]?.generatedAt, "2026-08-20T13:00:00.000Z");
});
