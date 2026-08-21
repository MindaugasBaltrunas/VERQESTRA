// VQ-501 (2/5-f) testai — dispatch srauto infrastruktūra: adapterio kelio CTX-2 paritetas
// (buildAdapterExecutionRequest), baigties normalizavimas (resolveDispatchOutcome su realiu
// stop-bridge failu tmp kataloge) ir terminalinis finalizeDispatch su token-usage įrašu.
// launchClaudeProcess netestuojamas be realių procesų — jį dengia VQ-504 kompozicijos testai.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { resolveTokenBudgetConfig } from "../application/token-governance/token-budget-config.js";
import { buildExecutionContextMarker } from "../application/context-pack/execution-context-fingerprint.js";
import { buildWorkerPrompt } from "../application/task-execution/execution-context-gate.js";
import type { DispatchExecutionRecord, DispatchExecutionRecordInput } from "../application/task-execution/dispatch-execution-record.js";
import { USAGE_LIMIT_EXIT_CODE, BUDGET_EXCEEDED_EXIT_CODE } from "../shared/exit-codes.js";
import { nodeFsAdapter } from "../infrastructure/fs/node-fs-adapter.js";
import { createStreamJsonUsageMeter } from "../infrastructure/adapters/claude-usage.js";
import {
  buildAdapterExecutionRequest,
  claudeAdapterDispatch,
} from "../infrastructure/adapters/adapter-dispatch.js";
import {
  resolveDispatchOutcome,
} from "../infrastructure/adapters/claude-dispatch-outcome.js";
import { finalizeDispatch } from "../infrastructure/adapters/claude-dispatch-finalize.js";
import type { MidDispatchBudgetWatchdog, MidDispatchBudgetVerdict } from "../infrastructure/adapters/mid-dispatch-budget.js";

const projectRoot = await mkdtemp(path.join(tmpdir(), "vq-dflow-"));
const runtimeRoot = path.join(projectRoot, "vq");
after(async () => {
  await rm(projectRoot, { recursive: true, force: true });
});

const TASK_TEXT = "# Task\n\n## Failai\nLeidžiama:\n- `src/a.ts`\n\n## Patikra\n- `pnpm test`\n";

function fakeWatchdog(input: { verdict?: MidDispatchBudgetVerdict; billableSeen?: boolean } = {}): MidDispatchBudgetWatchdog {
  const meter = createStreamJsonUsageMeter();
  return {
    observe: () => undefined,
    hit: () => input.verdict,
    totals: () => meter.totals(),
    billableSeen: () => input.billableSeen ?? true,
  };
}

test("buildAdapterExecutionRequest: be taskText — passthrough; su kontekstu — kanoninis prompt'as; mismatch — refuse", async () => {
  const passthrough = buildAdapterExecutionRequest({ taskId: "0042", prompt: "SENAS" });
  assert.equal(passthrough.kind, "request");
  if (passthrough.kind === "request") {
    assert.equal(passthrough.request.prompt, "SENAS", "senų kvietėjų prompt'as nepaliestas");
    assert.equal(passthrough.compilation.kind, "disabled");
  }

  // Schema-validus pack'as: nuo C17 gate'as schema-invalidų pack'ą laiko fail-closed
  // (gali nešti SRC pjūvius) ir source-change attach virstų refuse.
  const contextPackText = JSON.stringify({
    task_id: "0042",
    phase: "implementation",
    goal: "Tikslas.",
    allowed_paths: ["src/a.ts"],
    checks: ["pnpm test"],
  });
  const artifact = `${buildExecutionContextMarker({ taskId: "0042", taskText: TASK_TEXT, contextPackText })}\n\n# Kontekstas\n`;
  const attached = buildAdapterExecutionRequest({
    taskId: "0042",
    taskText: TASK_TEXT,
    executionContext: artifact,
    contextPackText,
    executionContextMode: "preferred",
  });
  assert.equal(attached.kind, "request");
  if (attached.kind === "request") {
    assert.equal(
      attached.request.prompt,
      buildWorkerPrompt({ taskText: TASK_TEXT, executionContext: artifact }),
      "CTX-2: adapterio prompt'as = ta pati buildWorkerPrompt kompozicija",
    );
    assert.equal(attached.gate.kind, "attach");
  }

  const stale = buildAdapterExecutionRequest({
    taskId: "0042",
    taskText: `${TASK_TEXT}\npakeista`,
    executionContext: artifact,
    contextPackText,
    executionContextMode: "preferred",
  });
  assert.equal(stale.kind, "refuse", "source-change + fingerprint mismatch — fail-fast");

  const refused = await claudeAdapterDispatch({
    taskId: "0042",
    adapter: "dry-run",
    taskText: `${TASK_TEXT}\npakeista`,
    executionContext: artifact,
    contextPackText,
    executionContextMode: "preferred",
  });
  assert.equal(refused.status, "failed");
  assert.equal(refused.reason, "execution_context_refused");

  const dryRun = await claudeAdapterDispatch({ taskId: "0042", adapter: "dry-run", taskText: TASK_TEXT });
  assert.equal(dryRun.adapter, "dry-run");
  assert.equal(dryRun.status, "completed");
});

test("resolveDispatchOutcome: own-done stop bridge — advisory be perrašymo; zero-usage be done → 75; budget abort → 80", async () => {
  const tokenBudget = resolveTokenBudgetConfig({});
  const lines: string[] = [];
  const logDispatch = async (line: string): Promise<void> => {
    void lines.push(line);
  };
  const previousEnv = process.env["AG_DISPATCH_STOP_WAIT_MS"];
  process.env["AG_DISPATCH_STOP_WAIT_MS"] = "0";
  try {
    // a) own-done: globalus stop failas su mūsų nonce — exit lieka 0, advisory eilutė.
    await nodeFsAdapter.writeTextFile(
      path.join(runtimeRoot, "state", "claude-stop-status.json"),
      JSON.stringify({ status: "done", dispatch_nonce: "nonce1" }),
    );
    const done = await resolveDispatchOutcome({
      runtimeRoot,
      taskId: "0042",
      initialExitCode: 0,
      claudeLogText: "",
      dispatchNonce: "nonce1",
      budgetWatchdog: fakeWatchdog(),
      budgetAborted: false,
      tokenBudget,
      sessionElapsedMs: 1_000,
      dispatchTimeoutMs: 100_000,
      logDispatch,
    });
    assert.equal(done.exitCode, 0);
    assert.equal(done.stopBridgeDone, true);
    assert.equal(done.zeroUsageSuccess, false);
    assert.ok(lines.some((line) => line.includes("DISPATCH USAGE ADVISORY")));

    // b) zero-usage be savo done (svetimas nonce) → USAGE_LIMIT_EXIT_CODE + foreign log.
    lines.length = 0;
    await nodeFsAdapter.writeTextFile(
      path.join(runtimeRoot, "state", "claude-stop-status.json"),
      JSON.stringify({ status: "done", dispatch_nonce: "svetimas" }),
    );
    const zero = await resolveDispatchOutcome({
      runtimeRoot,
      taskId: "0042",
      initialExitCode: 0,
      claudeLogText: "",
      dispatchNonce: "nonce1",
      budgetWatchdog: fakeWatchdog(),
      budgetAborted: false,
      tokenBudget,
      sessionElapsedMs: 1_000,
      dispatchTimeoutMs: 100_000,
      logDispatch,
    });
    assert.equal(zero.exitCode, USAGE_LIMIT_EXIT_CODE);
    assert.equal(zero.zeroUsageSuccess, true);
    assert.ok(lines.some((line) => line.includes("DISPATCH STOP BRIDGE FOREIGN")));

    // c) realus budget abort'as perrašo exit'ą į 80; usage iš watchdog totals nebūtinas.
    lines.length = 0;
    const verdict: MidDispatchBudgetVerdict = {
      reason: "budget-exceeded-mid-dispatch",
      billableTokens: 2_000_000,
      rawTokens: 3_000_000,
      limit: 1_500_000,
      limitSource: "dispatch-ceiling",
    };
    const aborted = await resolveDispatchOutcome({
      runtimeRoot,
      taskId: "0042",
      initialExitCode: BUDGET_EXCEEDED_EXIT_CODE,
      claudeLogText: `${JSON.stringify({ type: "result", usage: { input_tokens: 5, output_tokens: 1 } })}\n`,
      dispatchNonce: "nonce1",
      budgetWatchdog: fakeWatchdog({ verdict }),
      budgetAborted: true,
      tokenBudget,
      sessionElapsedMs: 1_000,
      dispatchTimeoutMs: 100_000,
      logDispatch,
    });
    assert.equal(aborted.exitCode, BUDGET_EXCEEDED_EXIT_CODE);
    assert.deepEqual(aborted.budgetVerdict, verdict);
    assert.ok(lines.some((line) => line.includes("DISPATCH BUDGET ABORT")));
    assert.deepEqual(aborted.usage, { input_tokens: 5, output_tokens: 1 }, "usage iš result envelope");
  } finally {
    if (previousEnv === undefined) delete process.env["AG_DISPATCH_STOP_WAIT_MS"];
    else process.env["AG_DISPATCH_STOP_WAIT_MS"] = previousEnv;
  }
});

test("finalizeDispatch: execution record, exit failas, checkpoint next_action ir token-usage įrašas", async () => {
  const records: DispatchExecutionRecord[] = [];
  const checkpoints: Array<{ status: string; next_action: string }> = [];
  const lines: string[] = [];
  const exitFile = path.join(runtimeRoot, "state", "claude-last-exit-code");
  const launchRecord: Omit<DispatchExecutionRecordInput, "status"> = {
    phase: "implementation",
    taskFile: "AG/tasks/queue/0042.md",
    sourceChange: true,
    selectedModel: "sonnet",
    failedAttempts: 0,
    attempt: 1,
    startedAt: "2026-08-20T12:00:00.000Z",
    contextGate: { kind: "skip", reason: "non-source" },
  };

  await finalizeDispatch({
    runtimeRoot,
    taskId: "0042",
    taskFile: "AG/tasks/queue/0042.md",
    dispatchPhase: "implementation",
    attempt: 1,
    effectiveTier: "sonnet",
    routingReasonCodes: ["routine-default"],
    claudeExitFile: exitFile,
    claudeLog: path.join(runtimeRoot, "logs", "claude-last.log"),
    claudeLogText: "",
    toolSchema: { mode: "applied", candidates: ["WebSearch"], applied: ["WebSearch"], reason: "policy" },
    launchRecord,
    outcome: {
      exitCode: USAGE_LIMIT_EXIT_CODE,
      usage: { input_tokens: 10, output_tokens: 2 },
      usageLimitHit: true,
      zeroUsageSuccess: false,
      stopBridgeDone: false,
    },
    recordExecutionResult: async (record) => {
      records.push(record);
    },
    recordResumeCheckpoint: async (entry) => {
      checkpoints.push({ status: entry.status, next_action: entry.next_action });
    },
    logDispatch: async (line) => {
      lines.push(line);
    },
  });

  assert.equal(records[0]?.status, "finished");
  assert.equal(records[0]?.exit_code, USAGE_LIMIT_EXIT_CODE);
  assert.equal(records[0]?.usage_limit_hit, true);
  assert.deepEqual(records[0]?.tool_schema?.applied, ["WebSearch"]);
  assert.equal((await nodeFsAdapter.readTextFileIfExists(exitFile))?.trim(), String(USAGE_LIMIT_EXIT_CODE));
  assert.equal(checkpoints[0]?.status, "failed");
  assert.match(checkpoints[0]?.next_action ?? "", /Usage limit — task requeued/);
  assert.ok(lines.some((line) => line.startsWith("CLAUDE FINISHED: exit_code=75")));
  assert.ok(lines.some((line) => line.startsWith("DISPATCH TOOL USAGE: task=0042")));

  const usageRaw = (await nodeFsAdapter.readTextFileIfExists(path.join(runtimeRoot, "logs", "token-usage.jsonl")))!;
  const usageRecord = JSON.parse(usageRaw.trim().split("\n").at(-1)!) as Record<string, unknown>;
  assert.equal(usageRecord["phase"], "dispatch");
  assert.equal(usageRecord["model"], "sonnet");
  assert.equal(usageRecord["outcome"], "infrastructure");
  assert.equal(usageRecord["attempt_id"], "0042:dispatch:1");
  assert.ok(!("parent_attempt_id" in usageRecord), "pirmam bandymui parent nėra");
  assert.ok(!("retry_reason" in usageRecord));
  assert.equal(usageRecord["dispatch_tool_schema"], "applied");
  assert.equal(usageRecord["disallowed_tools"], 1);
});
