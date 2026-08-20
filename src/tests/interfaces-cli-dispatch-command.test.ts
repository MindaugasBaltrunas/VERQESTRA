// VQ-501 (2/5-g) testai — claude-dispatch orkestratorius per pilną fake ClaudeDispatchPorts
// harness'ą: invocation/artifacts/prelaunch vienetai ir claudeDispatch seka (happy path,
// biudžeto refuse, execution-context refuse) be jokio proceso ar realios FS.

import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import type { LlmCallAuthorization } from "../application/token-governance/tool-budget-gates.js";
import type { ContextPackFileSystemPort } from "../application/context-pack/ports.js";
import { prepareDispatchInvocation } from "../interfaces/cli/dispatch/claude-dispatch/dispatch-invocation.js";
import { prepareDispatchArtifacts } from "../interfaces/cli/dispatch/claude-dispatch/dispatch-artifacts.js";
import { prepareDispatchLaunchState } from "../interfaces/cli/dispatch/claude-dispatch/dispatch-prelaunch.js";
import { claudeDispatch } from "../interfaces/cli/dispatch/claude-dispatch/command.js";
import type {
  ClaudeDispatchPorts,
  DispatchAttemptView,
  DispatchLaunchResultView,
} from "../interfaces/cli/dispatch/claude-dispatch/dispatch-ports.js";
import { USAGE_ERROR_EXIT_CODE } from "../shared/exit-codes.js";

const ROOT = path.resolve("/repo");
const RUNTIME = path.join(ROOT, "vq");
const TASK_FILE = path.join(ROOT, "AG", "tasks", "queue", "0042-demo.md");
const TASK_TEXT = "# Task\n\n## Failai\nLeidžiama:\n- `src/a.ts`\n\n## Patikra\n- `pnpm test`\n";

function fakeContextPackFs(): ContextPackFileSystemPort {
  return {
    readTextFileIfExists: async () => undefined,
    readFileBytes: async () => new Uint8Array(),
    exists: async () => false,
    appendTextFile: async () => {},
    writeTextFile: async () => {},
    makeDirectory: async () => {},
  };
}

function auth(overrides: Partial<LlmCallAuthorization> = {}): LlmCallAuthorization {
  return {
    allowed: true,
    task_id: "0042-demo",
    phase: "implementation",
    reduce_context: false,
    hard_reasons: [],
    soft_reasons: [],
    raw_notices: [],
    total_llm_calls: 1,
    total_tokens: 0,
    billable_tokens: 0,
    remaining_total_llm_calls: null,
    remaining_total_tokens: null,
    phase_status: [],
    ...overrides,
  };
}

type Harness = {
  ports: ClaudeDispatchPorts;
  agLines: string[];
  errs: string[];
  writes: Map<string, string>;
  removed: string[];
  launchCalls: Array<{ nonce: string; promptPathModel: string; maxTurns?: number }>;
  finalizeCalls: Array<{ exitCode: number; toolSchemaMode: string }>;
  outcomeCalls: number;
};

function makeHarness(input: {
  files?: Record<string, string>;
  launch?: DispatchLaunchResultView;
  authorization?: LlmCallAuthorization;
  requiredContext?: boolean;
  attempt?: DispatchAttemptView;
} = {}): Harness {
  const agLines: string[] = [];
  const errs: string[] = [];
  const writes = new Map<string, string>();
  const removed: string[] = [];
  const launchCalls: Array<{ nonce: string; promptPathModel: string; maxTurns?: number }> = [];
  const finalizeCalls: Array<{ exitCode: number; toolSchemaMode: string }> = [];
  const files = new Map(Object.entries(input.files ?? {}).map(([k, v]) => [k.replace(/\\/g, "/"), v]));
  const harness: Harness = { ports: undefined as never, agLines, errs, writes, removed, launchCalls, finalizeCalls, outcomeCalls: 0 };

  const ports: ClaudeDispatchPorts = {
    projectRoot: ROOT,
    runtimeRoot: RUNTIME,
    ensureDirs: async () => {},
    resolveExistingTaskFile: async () => TASK_FILE,
    readOptionalFile: async (p) => files.get(p.replace(/\\/g, "/")) ?? "",
    writeText: async (p, text) => {
      writes.set(p.replace(/\\/g, "/"), text);
    },
    removeIfExists: async (p) => {
      removed.push(p.replace(/\\/g, "/"));
    },
    readCurrentTaskId: async () => "",
    readRetryCounts: async () => ({}),
    resolveAttempt: async () => ({ ...(input.attempt ? { attempt: input.attempt } : {}), warnings: [] }),
    policyFs: { readTextFileIfExists: async () => undefined },
    workerPromptDeps: {
      fs: fakeContextPackFs(),
      clock: { timestamp: () => "2026-08-20T12:00:00.000Z" },
      runtimeRoot: RUNTIME,
      readTaskEvents: async () => [],
    },
    authorizeLlmCall: async () => input.authorization ?? auth(),
    models: {
      routingTierOfSelection: () => "standard",
      modelTierOfRoutingTier: (tier) => `tier-${tier}`,
      resolveRoutedModel: async (tier) => `claude-${tier}`,
    },
    loadProjectProfile: async () => undefined,
    powerShellCommand: async () => "pwsh.exe",
    mcpCapabilities: async () => ({ known: false, tools: [], source: "registry absent" }),
    loadToolPolicy: async () => ({}),
    resolveToolSchemaProfile: () => ({ mode: "off", candidates: [], applied: [], reason: "disabled" }),
    resolveDelivery: (deliveryInput) => ({
      view: { platform: "windows", transport: "prompt-file" },
      handle: { promptPathModel: `${deliveryInput.promptPath}|${deliveryInput.model}` } as never,
    }),
    createBudgetWatchdog: () => ({}) as never,
    launchProcess: async (launchInput) => {
      launchCalls.push({
        nonce: launchInput.dispatchNonce,
        promptPathModel: (launchInput.delivery as { promptPathModel?: string }).promptPathModel ?? "",
        ...(launchInput.dispatchMaxTurns === undefined ? {} : { maxTurns: launchInput.dispatchMaxTurns }),
      });
      return input.launch ?? { status: "finished", claudeExit: 0, budgetAborted: false, toolSchemaOutcome: { mode: "off", candidates: [], applied: [], reason: "disabled" } };
    },
    readClaudeLastLog: async () => "stream log",
    resolveOutcome: async (outcomeInput) => {
      harness.outcomeCalls += 1;
      return {
        exitCode: outcomeInput.initialExitCode,
        usageLimitHit: false,
        zeroUsageSuccess: false,
        stopBridgeDone: true,
      };
    },
    finalize: async (finalizeInput) => {
      finalizeCalls.push({ exitCode: finalizeInput.outcome.exitCode, toolSchemaMode: finalizeInput.toolSchema.mode });
    },
    logWriteFatal: (view) => view.attempt !== "written" && view.global !== "written",
    recordResumeCheckpoint: async () => {},
    agLog: async (line) => {
      agLines.push(line);
    },
    stderr: (line) => {
      errs.push(line);
    },
    newDispatchNonce: () => "nonce1234abcd",
    nowIso: () => "2026-08-20T12:00:00.000Z",
    nowMs: () => 1_000_000,
  };
  harness.ports = ports;
  return harness;
}

test("prepareDispatchInvocation: usage refuse, repair fazės detekcija, invalid attempt decision refuse", async () => {
  const base = makeHarness().ports;
  const usage = await prepareDispatchInvocation([], base);
  assert.equal(usage.kind, "refuse");

  const repairPorts = makeHarness({ files: { [TASK_FILE.replace(/\\/g, "/")]: "# Repair Task\n" } }).ports;
  const repair = await prepareDispatchInvocation(["t"], repairPorts);
  assert.equal(repair.kind, "ready");
  if (repair.kind === "ready") {
    assert.equal(repair.dispatchPhase, "repair");
    assert.equal(repair.taskId, "0042-demo", "be attempt'o — failo stem");
    assert.equal(repair.selected, "sonnet");
  }

  const attempt: DispatchAttemptView = {
    taskId: "0042-orig",
    writeTaskOnce: async () => ({ ok: true }),
    readDecision: async () => ({ kind: "invalid", reason: "corrupted", errors: ["blogas JSON"] }),
    readArtifactText: async () => undefined,
    promoteExecutionContext: async () => ({ ok: true }),
    promoteContextPack: async () => ({ ok: true }),
    writeExecutionResult: async () => ({ ok: true }),
    appendDispatchLog: async () => {},
    readStopState: async () => ({ ok: false, reason: "missing", errors: [] }),
  };
  const invalid = await prepareDispatchInvocation(["t"], makeHarness({ attempt }).ports);
  assert.equal(invalid.kind, "refuse");
  if (invalid.kind === "refuse") {
    assert.match(invalid.message, /Invalid attempt decision\.json/);
    assert.match(invalid.logLine ?? "", /task=0042-orig reason=corrupted/);
  }
});

test("prepareDispatchArtifacts: attempt kopija pirmi; legacy promotinamas; write klaidos — WARNING", async () => {
  const warnings: string[] = [];
  const promoted: string[] = [];
  const attempt: DispatchAttemptView = {
    taskId: "0042-demo",
    claudeLogPath: "/att/claude-last.log",
    writeTaskOnce: async () => ({ ok: false, reason: "io", errors: ["EACCES"] }),
    readDecision: async () => ({ kind: "missing" }),
    readArtifactText: async (kind) => (kind === "execution-context" ? undefined : undefined),
    promoteExecutionContext: async (text) => {
      promoted.push(text);
      return { ok: true };
    },
    promoteContextPack: async () => ({ ok: true }),
    writeExecutionResult: async () => ({ ok: true }),
    appendDispatchLog: async () => {},
    readStopState: async () => ({ ok: false, reason: "missing", errors: [] }),
  };
  const legacyPath = path.join(RUNTIME, "supervisor", "execution-context.md").replace(/\\/g, "/");
  const ports = {
    runtimeRoot: RUNTIME,
    readOptionalFile: async (p: string) => (p.replace(/\\/g, "/") === legacyPath ? "LEGACY KONTEKSTAS" : ""),
    agLog: async (line: string) => {
      warnings.push(line);
    },
  };
  const artifacts = await prepareDispatchArtifacts({ ports, taskId: "0042-demo", rawTaskText: TASK_TEXT, active: attempt });
  assert.equal(artifacts.attemptClaudeLog, "/att/claude-last.log");
  assert.equal(artifacts.executionContextRaw, "LEGACY KONTEKSTAS");
  assert.deepEqual(promoted, ["LEGACY KONTEKSTAS"], "legacy kopija promotinta į attempt namespace");
  assert.ok(warnings.some((line) => line.includes("dispatch task artifact write failed")));
  assert.ok(artifacts.claudeExitFile.replace(/\\/g, "/").endsWith("vq/state/claude-last-exit-code"));
});

test("prepareDispatchLaunchState: preview, valymai ir current-task-id per portus", async () => {
  const h = makeHarness();
  const checkpoints: string[] = [];
  await prepareDispatchLaunchState({
    ports: {
      runtimeRoot: RUNTIME,
      writeText: h.ports.writeText,
      removeIfExists: h.ports.removeIfExists,
      recordResumeCheckpoint: async (entry) => {
        checkpoints.push(entry.next_action);
      },
      nowIso: () => "2026-08-20T12:00:00.000Z",
    },
    taskId: "0042-demo",
    taskFile: TASK_FILE,
    dispatchLog: path.join(RUNTIME, "logs", "claude-dispatch-last.md"),
    claudeExitFile: path.join(RUNTIME, "state", "claude-last-exit-code"),
    visiblePrompt: path.join(RUNTIME, "supervisor", "claude-visible-prompt.md"),
    workerPrompt: "PROMPT",
    promptPreview: "PROMPT",
    claudeModel: "claude-x",
    selectedModel: "sonnet",
    effectiveTier: "tier-standard",
    routing: { tier: "standard", reason: "r", policyHash: "h" },
    failedAttempts: 0,
    sourceChange: true,
    executionContextPath: "none-path",
    contextGate: { kind: "skip", reason: "nėra artefakto" },
    workerPromptRecord: { mode: "raw", taskSha256: "a".repeat(64), rawChars: 5 },
    logDispatch: async () => {},
  });
  const dispatchLog = h.writes.get(path.join(RUNTIME, "logs", "claude-dispatch-last.md").replace(/\\/g, "/"))!;
  assert.ok(dispatchLog.includes("- model: claude-x"));
  assert.ok(dispatchLog.includes("- execution_context: none (nėra artefakto)"));
  assert.equal(h.writes.get(path.join(RUNTIME, "supervisor", "claude-visible-prompt.md").replace(/\\/g, "/")), "PROMPT");
  assert.equal(h.writes.get(path.join(RUNTIME, "state", "current-task-id").replace(/\\/g, "/")), "0042-demo\n");
  assert.equal(h.removed.length, 3, "exit + stop-status + stop-log išvalyti");
  assert.deepEqual(checkpoints, ["Claude is running the visible prompt"]);
});

test("claudeDispatch: happy path — seka iki finalize, nonce iš porto, exit iš outcome", async () => {
  const h = makeHarness({ files: { [TASK_FILE.replace(/\\/g, "/")]: TASK_TEXT } });
  const code = await claudeDispatch(["AG/tasks/queue/0042-demo.md"], h.ports);
  assert.equal(code, 0);
  assert.equal(h.launchCalls.length, 1);
  assert.equal(h.launchCalls[0]!.nonce, "nonce1234abcd");
  assert.match(h.launchCalls[0]!.promptPathModel, /claude-visible-prompt\.md\|claude-/);
  assert.equal(h.outcomeCalls, 1);
  assert.deepEqual(h.finalizeCalls, [{ exitCode: 0, toolSchemaMode: "off" }]);
  assert.ok(h.agLines.some((line) => line.startsWith("MODEL ROUTING: task=0042-demo")));
  assert.ok(h.agLines.some((line) => line.startsWith("DISPATCH CONTEXT SKIP: task=0042-demo")));
  assert.ok(h.agLines.some((line) => line.startsWith("DISPATCH TURN BUDGET:")));
  // Prelaunch per portus: preview + prompt failas + current-task-id.
  assert.ok(h.writes.has(path.join(RUNTIME, "supervisor", "claude-visible-prompt.md").replace(/\\/g, "/")));
  assert.equal(h.writes.get(path.join(RUNTIME, "state", "current-task-id").replace(/\\/g, "/")), "0042-demo\n");
});

test("claudeDispatch: biudžeto refuse → USAGE_ERROR be paleidimo; required konteksto refuse", async () => {
  const refused = makeHarness({
    files: { [TASK_FILE.replace(/\\/g, "/")]: TASK_TEXT },
    authorization: auth({ allowed: false, hard_reasons: ["LLM calls 9 > 8"] }),
  });
  assert.equal(await claudeDispatch(["t"], refused.ports), USAGE_ERROR_EXIT_CODE);
  assert.equal(refused.launchCalls.length, 0, "procesas nepaleistas");
  assert.ok(refused.errs.some((line) => line.includes("Execution budget refused dispatch")));

  const previousEnv = process.env["AG_EXECUTION_CONTEXT_MODE"];
  process.env["AG_EXECUTION_CONTEXT_MODE"] = "required";
  try {
    const contextRefused = makeHarness({ files: { [TASK_FILE.replace(/\\/g, "/")]: TASK_TEXT } });
    assert.equal(await claudeDispatch(["t"], contextRefused.ports), USAGE_ERROR_EXIT_CODE);
    assert.ok(contextRefused.errs.some((line) => line.includes("Execution context gate refused dispatch")));
    assert.equal(contextRefused.launchCalls.length, 0);
  } finally {
    if (previousEnv === undefined) delete process.env["AG_EXECUTION_CONTEXT_MODE"];
    else process.env["AG_EXECUTION_CONTEXT_MODE"] = previousEnv;
  }
});
