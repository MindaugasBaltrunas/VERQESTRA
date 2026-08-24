import assert from "node:assert/strict";
import test from "node:test";
import { redactSensitiveText } from "../application/ag-loop-read-redaction.js";
// SKAIDYMAS (etalone šios funkcijos gyveno `ag-loop-ui-http-adapter.ts`, 596 eil.):
// VERQESTRA'oje projekcijos iškeltos į `ag-loop-ui-projections.ts`, tad testas ima jas iš ten.
import {
  projectActivityPayload,
  projectLearningPayload,
  projectLogsPayload,
  projectPolicyControlsPayload,
  projectTokenAnalyticsPayload,
  projectTokenUsagePayload,
} from "../infrastructure/ag-loop-ui-projections.js";

/**
 * SKAIDYMAS (VERQESTRA ≤500 eil. vartas; etalone šis failas buvo 557 eilutės).
 *
 * Čia lieka GRYNOJI pusė: redakcija ir projekcijos — funkcijos, kurios iš neįrodyto upstream
 * payload'o padaro mobiliajam matomą DTO. Adapterio integracija (kokie HTTP keliai kviečiami,
 * kaip elgiasi SSE srautas, kaip clampinamos ribos) persikėlė į
 * `ag-loop-ui-adapter-reads.test.ts`: ten reikia `fetch` dublio, čia — nė vieno.
 */

/**
 * Canaries planted in every upstream fixture below. A projection that forwards
 * an unexpected field fails the leakage assertion rather than the shape
 * assertion, which is the failure that actually matters.
 */
// Sudurta iš dalių, kad repo secret-scan hook'as nematchintų PAČIO testo
// šaltinio (ta pati konvencija kaip hooks/secret-scan.ts envAssignment);
// runtime reikšmė — pilnos formos GitHub token kanarėlė.
const SECRET_CANARY = "ghp_" + "0123456789abcdefghijklmnopqrstuvwx";
const PATH_CANARY = "D:/private/workspace/AG";
const POSIX_PATH_CANARY = "/home/operator/secrets";
const UI_TOKEN = "a".repeat(43);

function leakFree(value: unknown): void {
  const wire = JSON.stringify(value) ?? "";
  for (const canary of [SECRET_CANARY, PATH_CANARY, POSIX_PATH_CANARY, UI_TOKEN]) {
    assert.equal(wire.includes(canary), false, `${canary} reached the mobile DTO`);
  }
}

test("redaction removes secrets, host paths and terminal control sequences", () => {
  const escape = String.fromCharCode(0x1b);
  const redacted = redactSensitiveText(
    `${escape}[31mAuthorization: Bearer abc.def-ghi${escape}[0m ${SECRET_CANARY} ` +
    `TOKEN=hunter2 ran in ${PATH_CANARY} and ${POSIX_PATH_CANARY} via file://${PATH_CANARY}`,
    4096,
  );
  assert.equal(redacted.includes(SECRET_CANARY), false);
  assert.equal(redacted.includes("hunter2"), false);
  assert.equal(redacted.includes(PATH_CANARY), false);
  assert.equal(redacted.includes(POSIX_PATH_CANARY), false);
  assert.equal(redacted.includes(escape), false);
  assert.match(redacted, /Bearer \[REDACTED\]/);
  assert.match(redacted, /TOKEN=\[REDACTED\]/);
  assert.match(redacted, /\[PATH\]/);
  // Ordinary prose survives; redaction is not a blanket erasure.
  assert.match(redacted, /ran in/);
});

/**
 * Credential shapes an AG Loop log line really carries. Every case below leaked
 * verbatim before: an anchored `\bTOKEN` never matches `GITHUB_TOKEN=` because
 * `_` is a word character, and a JSON log line puts a quote between the name and
 * its separator.
 */
test("redaction covers prefixed, quoted and provider-shaped credentials", () => {
  const leaks: readonly (readonly [string, string])[] = [
    ["CLAUDE_CODE_OAUTH_TOKEN=oat-abcdefghijklmnop", "oat-abcdefghijklmnop"],
    ["AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY", "wJalrXUtnFEMI"],
    ["MY_PASSWORD=hunter2", "hunter2"],
    ['{"token":"eyJhbGciOiJIUzI1NiJ9.payload.signature"}', "eyJhbGciOiJIUzI1NiJ9"],
    ['{"password": "hunter2"}', "hunter2"],
    ["x-ag-ui-token: " + "a".repeat(43), "a".repeat(43)],
    ["-----BEGIN OPENSSH " + "PRIVATE KEY----- MIIEpAIBAAKCAQEA", "MIIEpAIBAAKCAQEA"],
    ["slack " + "xoxb-" + "123456789012-abcdefghijkl", "xoxb-123456789012"],
    ["npm_abcdefghijklmnopqrstuvwxyz123456", "npm_abcdefghijkl"],
  ];
  for (const [line, canary] of leaks) {
    const redacted = redactSensitiveText(line, 4096);
    assert.equal(redacted.includes(canary), false, `${canary} survived redaction of ${line}`);
    assert.match(redacted, /\[REDACTED\]/);
  }
});

test("redaction leaves ordinary AG Loop prose readable", () => {
  for (const line of [
    "task 1135-read-only-proxy.md queued",
    "chain readme-guard -> coder -> reviewer",
    "token usage: 1200 input, 300 output",
    "dispatch max_turns: 80 model: claude-opus-5",
  ]) {
    assert.equal(redactSensitiveText(line, 4096), line);
  }
});

test("redaction hides host account names in every absolute-path form", () => {
  for (const [line, canary] of [
    ["cat ~operator/.ssh/id_rsa", "operator"],
    ["cwd /home/oper\u0117tor/secrets/key.pem", "oper\u0117tor"],
    ["cwd C:/Users/operator/workspace", "operator"],
    ["cwd \\\\host\\operator\\share", "operator"],
  ] as const) {
    const redacted = redactSensitiveText(line, 4096);
    assert.equal(redacted.includes(canary), false, `${canary} survived redaction of ${line}`);
    assert.match(redacted, /\[PATH\]/);
  }
});

test("redaction truncates after redacting, never before", () => {
  const redacted = redactSensitiveText(`${SECRET_CANARY} tail`, 12);
  assert.equal(redacted.length, 12);
  assert.equal(redacted.includes("ghp_"), false);
});

test("log projection redacts, bounds the line count and bounds each line", () => {
  const projected = projectLogsPayload(
    {
      lines: [
        `first ${SECRET_CANARY}`,
        `second ${PATH_CANARY}`,
        `third ${"x".repeat(9_000)}`,
      ],
      truncated: false,
      // Fields the AG Loop UI may add later must not ride along.
      root: PATH_CANARY,
      command: "npm test",
    },
    "claude",
    2,
  );
  assert.deepEqual(Object.keys(projected).sort(), ["lines", "log", "truncated"]);
  assert.equal(projected.log, "claude");
  assert.equal(projected.lines.length, 2);
  assert.equal(projected.truncated, true, "dropping a line must be reported");
  assert.equal((projected.lines[1] ?? "").length, 4096);
  leakFree(projected);
});

test("token usage projection keeps only the allowlisted record fields", () => {
  const projected = projectTokenUsagePayload(
    {
      records: [
        {
          ts: "2026-08-06T10:00:00.000Z",
          phase: "implementation",
          task_id: "1135-read-only-proxy",
          model: "claude-opus-5",
          attempt: 2,
          outcome: "succeeded",
          input_tokens: 10,
          output_tokens: 20,
          cache_read_input_tokens: 30,
          cache_creation_input_tokens: 40,
          total_cost_usd: 1.5,
          cwd: PATH_CANARY,
          command: `claude --token ${SECRET_CANARY}`,
          attempt_id: "internal-attempt",
        },
        { ts: "not-a-timestamp", task_id: `../${POSIX_PATH_CANARY}`, input_tokens: Number.NaN },
      ],
      pagination: { total_records: 2, offset: 0 },
    },
    5,
  );
  assert.deepEqual(Object.keys(projected), ["records"]);
  assert.deepEqual(Object.keys(projected.records[0] ?? {}).sort(), [
    "attempt",
    "cacheCreationInputTokens",
    "cacheReadInputTokens",
    "inputTokens",
    "model",
    "outcome",
    "outputTokens",
    "phase",
    "taskId",
    "totalCostUsd",
    "ts",
  ]);
  assert.equal(projected.records[0]?.taskId, "1135-read-only-proxy");
  // A malformed upstream record degrades to safe values instead of travelling.
  assert.equal(projected.records[1]?.ts, "");
  assert.equal(projected.records[1]?.taskId, "");
  assert.equal(projected.records[1]?.inputTokens, 0);
  leakFree(projected);
});

test("token usage projection honours the requested record bound", () => {
  const projected = projectTokenUsagePayload(
    { records: Array.from({ length: 40 }, () => ({ ts: "2026-08-06T10:00:00.000Z" })) },
    10,
  );
  assert.equal(projected.records.length, 10);
});

test("token analytics projection exposes the newest snapshot and drops the history", () => {
  const projected = projectTokenAnalyticsPayload({
    groups: [{ familyKey: "family", taskIds: ["1135"], totalTokensByTask: { "1135": 5 } }],
    candidates: [{
      taskId: "1135-read-only-proxy",
      familyKey: "read-only-proxy",
      taskTokens: 90,
      groupMedianTokens: 30,
      multiplier: 3,
      reasonHint: `ran ${PATH_CANARY}`,
    }],
    history: [
      { generatedAt: "2026-08-01T10:00:00.000Z", totals: { records: 1 } },
      {
        generatedAt: "2026-08-06T10:00:00.000Z",
        totals: { records: 7, totalTokens: 700, uniqueTasks: 3 },
        tokensByPhase: [{ key: "implementation", totalTokens: 500 }],
        tokensByModel: [{ key: "claude-opus-5", totalTokens: 700 }],
        tokensByDay: [{ key: "2026-08-06", totalTokens: 700 }],
        fastPathHitRate: { preflight: 0.5, diagnose: 0.25 },
        cacheHitRate: 0.4,
        repairShare: 0.1,
        groupMedians: [{ familyKey: "read-only-proxy", taskCount: 2, medianTokens: 30 }],
      },
    ],
  });
  assert.deepEqual(Object.keys(projected).sort(), ["candidates", "latestSnapshot"]);
  assert.equal(projected.latestSnapshot?.generatedAt, "2026-08-06T10:00:00.000Z");
  assert.equal(projected.latestSnapshot?.totals.totalTokens, 700);
  assert.deepEqual(projected.latestSnapshot?.tokensByModel, [
    { key: "claude-opus-5", totalTokens: 700 },
  ]);
  assert.equal(JSON.stringify(projected).includes("groupMedians"), false);
  assert.equal(JSON.stringify(projected).includes("taskIds"), false);
  leakFree(projected);
});

test("token analytics projection survives an empty history", () => {
  assert.deepEqual(projectTokenAnalyticsPayload({}), { candidates: [], latestSnapshot: null });
});

test("policy controls projection drops route, source, editable and pending proposals", () => {
  const projected = projectPolicyControlsPayload({
    root: PATH_CANARY,
    controlPlane: {
      loop_controls: [{ id: "stop", endpoint: "/tasks/stop", method: "POST" }],
      policy_controls: [{
        group: "dispatch",
        label: "Dispatch",
        controls: [{
          id: "max_turns",
          label: "Max turns",
          value: 80,
          source: PATH_CANARY,
          editable: true,
          route: "/api/policies/runtime/proposals",
          allowed_values: ["40", "80"],
          pending_proposal: { id: "proposal-1", file: PATH_CANARY },
        }],
      }],
    },
  });
  assert.deepEqual(Object.keys(projected), ["groups"]);
  assert.deepEqual(projected.groups, [{
    id: "dispatch",
    label: "Dispatch",
    controls: [{ id: "max_turns", label: "Max turns", value: 80 }],
  }]);
  const wire = JSON.stringify(projected);
  assert.doesNotMatch(wire, /route|endpoint|method|editable|pending_proposal|allowed_values/i);
  leakFree(projected);
});

test("learning projection drops evidence, files and mutation actions", () => {
  const projected = projectLearningPayload({
    controlPlane: {
      learning_summary: {
        records: 12,
        by_type: { task_outcome: 8, policy_recommendation: 4 },
        pending_recommendations: 2,
        approved_recommendations: 1,
        rejected_recommendations: 1,
      },
      learning_recommendations: [{
        id: "rec-1",
        recommendation_status: "pending",
        summary: `raise turns for ${PATH_CANARY}`,
        labels: ["dispatch", "tokens"],
        evidence: [`${POSIX_PATH_CANARY}/evidence.json`],
        file: PATH_CANARY,
        task_id: "1135",
        actions: ["approve", "reject"],
      }],
    },
  });
  assert.deepEqual(Object.keys(projected).sort(), ["recommendations", "summary"]);
  assert.deepEqual(Object.keys(projected.recommendations[0] ?? {}).sort(), [
    "id",
    "labels",
    "status",
    "summary",
  ]);
  assert.equal(projected.summary.records, 12);
  assert.equal(projected.summary.pendingRecommendations, 2);
  assert.equal(projected.recommendations[0]?.status, "pending");
  const wire = JSON.stringify(projected);
  // The counts keep their own `approved`/`rejected` vocabulary; what must be
  // gone is the evidence, the host file and the approve/reject action list.
  assert.doesNotMatch(wire, /evidence|"actions"|"file"|"task_id"|reject"/i);
  leakFree(projected);
});

test("activity projection redacts the command fragment the upstream parser embeds", () => {
  const projected = projectActivityPayload({
    chain: ["readme-guard", "coder"],
    statuses: { coder: "running" },
    currentAgent: "coder",
    currentActivity: `Bash(npm test --token ${SECRET_CANARY} in ${PATH_CANARY})`,
    taskId: "1135-read-only-proxy",
    claudeStatus: "running",
    mode: "inline",
    updatedAt: "2026-08-06T10:00:00.000Z",
    command: `rm -rf ${PATH_CANARY}`,
    root: PATH_CANARY,
  });
  assert.deepEqual(Object.keys(projected).sort(), [
    "chain",
    "claudeStatus",
    "currentActivity",
    "currentAgent",
    "mode",
    "statuses",
    "taskId",
    "updatedAt",
  ]);
  assert.equal(projected.mode, "inline");
  assert.match(projected.currentActivity ?? "", /\[REDACTED\]/);
  leakFree(projected);
});

test("activity projection normalises an unknown mode and a hostile task id", () => {
  const projected = projectActivityPayload({
    mode: "remote-control",
    taskId: `../../${POSIX_PATH_CANARY}`,
    updatedAt: "yesterday",
  });
  assert.equal(projected.mode, "idle");
  assert.equal(projected.taskId, null);
  assert.equal(projected.updatedAt, "");
});
