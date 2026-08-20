// vq/runtime layout testai (E4 VQ-401). Elgesio etalonas: AG_loop runtime-paths.test.ts
// branduolys: segmentų validacija, containment ir artefaktų registras.

import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import type { AttemptRef } from "../application/scheduling/worker-limits.js";
import {
  RUNTIME_ARTIFACTS,
  attemptArtifactPath,
  attemptDir,
  attemptLogPath,
  isInsideRuntimeRoot,
  runtimeAggregateRootDir,
  validateRuntimeSegment,
} from "../infrastructure/runtime-paths.js";

const RUNTIME_ROOT = path.join(path.resolve("/repo"), "vq");
const REF: AttemptRef = { runId: "r1", workerId: "w1", taskId: "0042-task", attemptId: "a2" };

function failureReason(result: { ok: boolean; reason?: string }): string | undefined {
  return result.ok ? undefined : (result as { reason: string }).reason;
}

test("validateRuntimeSegment: kiekviena atmetimo taisyklė turi savo priežastį", () => {
  assert.equal(failureReason(validateRuntimeSegment("", "run")), "empty");
  assert.equal(failureReason(validateRuntimeSegment("x".repeat(65), "run")), "too-long");
  assert.equal(failureReason(validateRuntimeSegment("Wg1", "worker")), "uppercase");
  assert.equal(failureReason(validateRuntimeSegment("wg1:hash", "run")), "charset");
  assert.equal(failureReason(validateRuntimeSegment("../up", "task")), "charset");
  assert.equal(failureReason(validateRuntimeSegment("x.", "task")), "trailing-dot");
  assert.equal(failureReason(validateRuntimeSegment("con.log", "log-channel")), "reserved-device-name");
  assert.equal(validateRuntimeSegment("0042-task.v2", "task").ok, true);
});

test("attemptDir: vq/runtime šaknis ir pilna run/worker/task/attempt hierarchija", () => {
  const dir = attemptDir(RUNTIME_ROOT, REF);
  assert.ok(dir.ok);
  const expected = path.join(
    runtimeAggregateRootDir(RUNTIME_ROOT),
    "runs",
    "r1",
    "workers",
    "w1",
    "tasks",
    "0042-task",
    "attempts",
    "a2",
  );
  assert.equal(dir.ok && dir.value, expected);

  const bad = attemptDir(RUNTIME_ROOT, { ...REF, taskId: "Blogas" });
  assert.equal(failureReason(bad), "uppercase");
});

test("artefaktų registras: usage yra append-only JSONL, o kelias baigiasi kanoniniu vardu", () => {
  assert.equal(RUNTIME_ARTIFACTS.usage.policy, "append-only");
  assert.equal(RUNTIME_ARTIFACTS.usage.format, "jsonl");
  const usage = attemptArtifactPath(RUNTIME_ROOT, REF, "usage");
  assert.ok(usage.ok);
  assert.ok(usage.ok && usage.value.endsWith(path.join("attempts", "a2", "token-usage.jsonl")));

  const log = attemptLogPath(RUNTIME_ROOT, REF, "dispatch");
  assert.ok(log.ok);
  assert.ok(log.ok && log.value.endsWith(path.join("logs", "dispatch.log")));
  assert.equal(failureReason(attemptLogPath(RUNTIME_ROOT, REF, "Kanalas")), "uppercase");
  assert.equal(failureReason(attemptLogPath(RUNTIME_ROOT, REF, "blogas kanalas")), "charset");
});

test("isInsideRuntimeRoot: šaknis nėra viduje, pabėgimas — irgi ne", () => {
  assert.equal(isInsideRuntimeRoot(RUNTIME_ROOT, "runs/r1"), true);
  assert.equal(isInsideRuntimeRoot(RUNTIME_ROOT, "."), false);
  assert.equal(isInsideRuntimeRoot(RUNTIME_ROOT, "../už-ribos"), false);
});
