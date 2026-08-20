// Patikimumo analitikos testai (VQ-305 3/3-f). Elgesio etalonas: AG_loop
// reliability-analytics.test.ts (git parsing, UTC bucket'ai, incidentų kaina, kompozicija).

import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { buildFailureAnalytics } from "../application/learning/failure-analytics.js";
import { aggregateFileActivity, dateKey, parseGitNumstat } from "../application/learning/file-activity.js";
import {
  buildReliabilityAnalytics,
  type ReliabilityPorts,
  type SessionFileKind,
} from "../application/learning/reliability-report.js";
import type { LearningFsPort } from "../application/learning/ports.js";
import type { LearningTaskEventRecord, LearningUsageRecord } from "../application/learning/usage-view.js";

test("parseGitNumstat: numstat, name-status R ir riestinė rename forma duoda tikrus kelius", () => {
  const raw = [
    "@@abc|2026-08-10T01:30:34+03:00|feat",
    "3\t0\tsrc/new.ts",
    "1\t1\tsrc/mod.ts",
    "R100\tsrc/old.ts\tsrc/renamed.ts",
    "0\t0\tsrc/{a => b}.ts",
  ].join("\n");
  const commits = parseGitNumstat(raw);
  assert.equal(commits.length, 1);
  assert.deepEqual(commits[0]!.files, [
    { path: "src/new.ts", kind: "created" },
    { path: "src/mod.ts", kind: "modified" },
    { path: "src/old.ts", kind: "deleted" },
    { path: "src/renamed.ts", kind: "created" },
    { path: "src/a.ts", kind: "deleted" },
    { path: "src/b.ts", kind: "created" },
  ]);
});

test("dateKey visada UTC: lokalus poslinkis nebedingdo commit'o iš bucket'ų", () => {
  assert.equal(dateKey("2026-08-10T01:30:34+03:00"), "2026-08-09");
  const activity = aggregateFileActivity(
    [{ timestamp: "2026-08-10T01:30:34+03:00", files: [{ path: "a.ts", kind: "created" }] }],
    3,
    new Date("2026-08-10T12:00:00.000Z"),
  );
  const bucket = activity.byDay.find((day) => day.date === "2026-08-09");
  assert.equal(bucket?.commits, 1);
  assert.equal(bucket?.created, 1);
});

test("buildFailureAnalytics: incidentas atsidaro, užsidaro done ir susirenka tarp jų įrašytą usage", () => {
  const events: LearningTaskEventRecord[] = [
    { ts: "2026-08-10T10:00:00.000Z", task_id: "T-1", to_state: "error", reason: "tsc failed", phase: "dispatch" },
    { ts: "2026-08-10T10:30:00.000Z", task_id: "T-1", to_state: "done", reason: "repaired" },
    {
      ts: "2026-08-10T11:00:00.000Z",
      task_id: "T-2",
      to_state: "human-review",
      reason: "preflight failed",
      phase: "preflight",
    },
  ];
  const tokens: LearningUsageRecord[] = [
    {
      ts: "2026-08-10T10:10:00.000Z",
      task_id: "T-1",
      phase: "diagnose",
      model: "claude-sonnet-5",
      input_tokens: 100,
    },
    {
      ts: "2026-08-10T10:20:00.000Z",
      task_id: "T-1",
      phase: "dispatch",
      model: "claude-sonnet-5",
      attempt: 2,
      input_tokens: 200,
    },
    // Po incidento uždarymo — nepriskiriama.
    { ts: "2026-08-10T11:00:00.000Z", task_id: "T-1", phase: "dispatch", model: "claude-sonnet-5", input_tokens: 999 },
  ];
  const analytics = buildFailureAnalytics(events, tokens);
  assert.equal(analytics.failures, 2);
  assert.equal(analytics.fixed, 1);
  assert.equal(analytics.open, 1);
  assert.equal(analytics.fixRate, 0.5);
  assert.equal(analytics.medianRepairMinutes, 30);
  assert.equal(analytics.incidentTokens, 300);
  assert.equal(analytics.diagnosticTokens, 100);
  assert.equal(analytics.retryTokens, 200);
  assert.equal(analytics.repairTokens, 300);
  const typeNames = analytics.byType.map((entry) => entry.type).sort();
  assert.deepEqual(typeNames, ["Preflight / specification", "TypeScript"]);
});

test("buildReliabilityAnalytics: kompozicija per portus — be git, su session kind žurnalu", async () => {
  const norm = (p: string): string => p.replace(/\\/g, "/");
  const store = new Map<string, string>();
  const runtimeRoot = path.join(path.resolve("/repo"), "vq");
  store.set(
    norm(path.join(runtimeRoot, "logs", "task-events.jsonl")),
    `${JSON.stringify({ ts: "2026-08-10T10:00:00.000Z", task_id: "T-1", to_state: "done", reason: "ok" })}\n`,
  );
  store.set(
    norm(path.join(runtimeRoot, "logs", "token-usage.jsonl")),
    `${JSON.stringify({ ts: "2026-08-10T09:00:00.000Z", task_id: "T-1", phase: "dispatch", model: "claude-sonnet-5", input_tokens: 10 })}\n`,
  );
  const fs: LearningFsPort = {
    readTextFileIfExists: async (p) => store.get(norm(p)),
    appendTextFile: async () => {},
    writeTextFile: async () => {},
    makeDirectory: async () => {},
  };
  const ports: ReliabilityPorts = {
    fs,
    gitLog: async () => undefined,
    gitStatusPorcelain: async () => undefined,
    sessionWrites: async () => ["a.ts", "c.ts"],
    sessionFileKinds: async () =>
      new Map<string, SessionFileKind>([
        ["a.ts", "created"],
        ["b.ts", "modified"],
      ]),
  };

  const response = await buildReliabilityAnalytics(ports, { runtimeRoot, now: new Date("2026-08-10T12:00:00.000Z") });
  assert.equal(response.coverage.gitAvailable, false);
  assert.ok(response.coverage.limitations.some((line) => line.includes("Git history is unavailable")));
  assert.equal(response.coverage.taskEvents, 1);
  assert.equal(response.coverage.tokenRecords, 1);
  // Ledger'io failai + įvykių žurnalo failai = unikalūs touched; kind'ai — tik iš žurnalo.
  assert.deepEqual(response.files.session, { touched: 3, created: 1, modified: 1, deleted: 0 });
  assert.equal(response.reliability.failures, 0);
  assert.equal(typeof response.compressionCohorts, "object");
});
