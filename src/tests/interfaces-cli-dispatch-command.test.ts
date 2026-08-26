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
import { buildExecutionContextMarker } from "../application/context-pack/execution-context-fingerprint.js";
import { USAGE_ERROR_EXIT_CODE } from "../shared/exit-codes.js";

// `claudeDispatch` resolves the execution-context mode from `process.env` itself
// (`command.ts` → `resolveExecutionContextMode()`), so there is no port to fake it through.
// Every harness below builds a source-change task with NO execution-context artifact — the
// `preferred` path. Run inside a dispatch, where the orchestrator exports
// `AG_EXECUTION_CONTEXT_MODE=required`, the ambient value made the gate refuse first and five
// tests failed on an exit code they never intended to assert. Pinning the baseline here makes
// the suite say which mode it means instead of inheriting the shell's; the one test that needs
// `required` still sets it explicitly and restores THIS value.
process.env["AG_EXECUTION_CONTEXT_MODE"] = "preferred";

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
  retryCounts?: Record<string, number>;
  attempt?: DispatchAttemptView;
  supervisorDecision?: Awaited<ReturnType<ClaudeDispatchPorts["readSupervisorDecision"]>>;
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
    readFileBytesIfExists: async (p) => {
      const text = files.get(p.replace(/\\/g, "/"));
      return text === undefined ? undefined : new TextEncoder().encode(text);
    },
    writeText: async (p, text) => {
      writes.set(p.replace(/\\/g, "/"), text);
    },
    removeIfExists: async (p) => {
      removed.push(p.replace(/\\/g, "/"));
    },
    readCurrentTaskId: async () => "",
    readRetryCounts: async () => input.retryCounts ?? {},
    resolveAttempt: async () => ({ ...(input.attempt ? { attempt: input.attempt } : {}), warnings: [] }),
    readSupervisorDecision: async () => input.supervisorDecision ?? { kind: "missing" },
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
    createBudgetWatchdog: () => ({}),
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
    // Be supervisor sprendimo `selected` yra `none`, ne hardcoded sonnet (2026-08-25 P1-3):
    // MODEL ROUTING eilutė nebegali rodyti „pasirinkimo", kurio niekas nepriėmė.
    assert.equal(repair.selected, "none");
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

// 0941 kanalo atkūrimas (2026-08-25 auditas, P0-1): be attempt'o preflight sprendimas
// dispatch'ą pasiekia per globalų decision.json veidrodį — su nuosavybės patikra.
test("prepareDispatchInvocation: globalus decision veidrodis — ok/foreign/invalid keliai", async () => {
  const own = await prepareDispatchInvocation(
    ["t"],
    makeHarness({
      supervisorDecision: {
        kind: "ok",
        decision: { task_id: "0042-demo", selected_model: "opus", token_budget_tier: "large" },
      },
    }).ports,
  );
  assert.equal(own.kind, "ready");
  if (own.kind === "ready") {
    assert.equal(own.selected, "opus", "supervisor pasirinkimas iš veidrodžio");
    assert.equal(own.decision["token_budget_tier"], "large", "paskelbtas tier'as pasiekia dispatch'ą");
  }

  const foreign = await prepareDispatchInvocation(["t"], makeHarness({ supervisorDecision: { kind: "foreign" } }).ports);
  assert.equal(foreign.kind, "ready");
  if (foreign.kind === "ready") {
    assert.deepEqual(foreign.decision, {}, "svetimo task'o veidrodis ignoruojamas");
    assert.equal(foreign.selected, "none");
  }

  const invalidMirror = await prepareDispatchInvocation(
    ["t"],
    makeHarness({ supervisorDecision: { kind: "invalid", errors: ["blogas JSON"] } }).ports,
  );
  assert.equal(invalidMirror.kind, "ready", "neperskaitomas veidrodis nestabdo — jis gali būti svetima liekana");
  if (invalidMirror.kind === "ready") {
    assert.deepEqual(invalidMirror.decision, {});
    assert.ok(
      invalidMirror.warnings.some((line) => line.includes("unreadable global supervisor decision.json")),
      "bet paliekamas MATOMAS įspėjimas",
    );
  }

  // Attempt'o sprendimas turi pirmenybę — veidrodis tada NEskaitomas.
  const attemptDecision: DispatchAttemptView = {
    taskId: "0042-demo",
    writeTaskOnce: async () => ({ ok: true }),
    readDecision: async () => ({ kind: "ok", decision: { task_id: "0042-demo", selected_model: "sonnet" } }),
    readArtifactText: async () => undefined,
    promoteExecutionContext: async () => ({ ok: true }),
    promoteContextPack: async () => ({ ok: true }),
    writeExecutionResult: async () => ({ ok: true }),
    appendDispatchLog: async () => {},
    readStopState: async () => ({ ok: false, reason: "missing", errors: [] }),
  };
  const attemptFirst = await prepareDispatchInvocation(
    ["t"],
    makeHarness({
      attempt: attemptDecision,
      supervisorDecision: { kind: "ok", decision: { task_id: "0042-demo", selected_model: "opus" } },
    }).ports,
  );
  assert.equal(attemptFirst.kind, "ready");
  if (attemptFirst.kind === "ready") {
    assert.equal(attemptFirst.selected, "sonnet", "attempt kanalas autoritetingesnis už veidrodį");
  }
});

// Pilna grandinė: veidrodžio tier'as realiai keičia turn langą — `source=token-budget`
// vietoje struktūrinio fallback'o (iki pataisos gamyboje: 17/17 `source=structural`).
test("claudeDispatch: veidrodžio token_budget_tier=large → DISPATCH TURN BUDGET source=token-budget", async () => {
  const h = makeHarness({
    files: { [TASK_FILE.replace(/\\/g, "/")]: TASK_TEXT },
    supervisorDecision: {
      kind: "ok",
      decision: { task_id: "0042-demo", selected_model: "opus", token_budget_tier: "large" },
    },
  });
  const code = await claudeDispatch(["AG/tasks/queue/0042-demo.md"], h.ports);
  assert.equal(code, 0);
  const turnLine = h.agLines.find((line) => line.startsWith("DISPATCH TURN BUDGET:")) ?? "";
  assert.notEqual(turnLine, "", "turn budžeto eilutė yra");
  assert.match(turnLine, /tier=large source=token-budget/, "tier'as iš preflight sprendimo, ne struktūrinis");
  const routingLine = h.agLines.find((line) => line.startsWith("MODEL ROUTING:"));
  assert.match(routingLine ?? "", /selected=opus/, "selected= rodo realų supervisor pasirinkimą");
});

// Antra to paties lauko pusė: kai sprendimo NĖRA (nei attempt, nei veidrodis), log'as turi
// tai ir pasakyti. Iki 2026-08-25 P1-3 čia stovėjo hardcoded `sonnet`, tad 09:41–10:06
// eilutės (`selected=sonnet model=claude-haiku-4-5`) atrodė kaip routing klaida, nors melavo
// tik šis laukas. Vienetinis testas to neįrodo — reikia REALIOS log'o eilutės iš grandinės.
test("claudeDispatch: be jokio decision → MODEL ROUTING eilutėje selected=none", async () => {
  const h = makeHarness({ files: { [TASK_FILE.replace(/\\/g, "/")]: TASK_TEXT } });
  const code = await claudeDispatch(["AG/tasks/queue/0042-demo.md"], h.ports);
  assert.equal(code, 0);
  const routingLine = h.agLines.find((line) => line.startsWith("MODEL ROUTING:")) ?? "";
  assert.notEqual(routingLine, "", "routing eilutė yra");
  assert.match(routingLine, /selected=none/, "nepriimtas pasirinkimas skelbiamas kaip none");
  assert.doesNotMatch(routingLine, /selected=(sonnet|opus|haiku)/, "joks konkretus modelis neprasimano");
});

// `selected=` neša DVI eilutes; eskalacijos šablonas atskiras ir per grandinę netikrintas
// (vienintelis jo assert'as — vienetinis, su `selectedModel: "sonnet"`, t. y. ikipataisos
// forma). Be sprendimo, bet su nesėkmingais bandymais, eskalacija turi kartoti tą patį
// `none`, kitaip melas grįžta pro antrą kanalą.
test("claudeDispatch: be decision + failed_attempts → MODEL ESCALATION eilutėje selected=none", async () => {
  const h = makeHarness({
    files: { [TASK_FILE.replace(/\\/g, "/")]: TASK_TEXT },
    retryCounts: { "task:0042-demo": 2 },
  });
  assert.equal(await claudeDispatch(["AG/tasks/queue/0042-demo.md"], h.ports), 0);
  const escalationLine = h.agLines.find((line) => line.startsWith("MODEL ESCALATION:")) ?? "";
  assert.notEqual(escalationLine, "", "failed_attempts=2 su default defer_steps=1 kelia pakopą");
  assert.match(escalationLine, /selected=none failed_attempts=2/, "eskalacija nepridengia tuščio pasirinkimo");
  assert.doesNotMatch(escalationLine, /selected=(sonnet|opus|haiku)/);
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
      writeText: (file: string, text: string) => h.ports.writeText(file, text),
      removeIfExists: (file: string) => h.ports.removeIfExists(file),
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

// PILNA grandinė, ne izoliuotas vienetas: realus context-pack su SRC pjūviu, pakeistas šaltinio
// failas, ir tvirtinimas, kad procesas NEPALEIDŽIAMAS. Artefaktų fingerprint'ai čia SUTAMPA —
// task tekstas ir pack'as nepakitę — tad vienintelė priežastis atmesti yra pats pjūvio šviežumas.
// Būtent to izoliuoti testai neįrodė: jie tikrino funkciją, ne kelią.
test("claudeDispatch: pasenęs SRC pjūvis → refuse, procesas NEPALEIDŽIAMAS", async () => {
  const packJson = JSON.stringify({
    task_id: "0042-demo",
    phase: "implementation",
    goal: "Tikslas.",
    allowed_paths: ["src/a.ts"],
    checks: ["pnpm test"],
    code_context: {
      enabled: true,
      symbol_fragments: [
        {
          id: "a#x",
          file: "src/a.ts",
          name: "x",
          reason: "exported",
          tier: "SRC",
          // Hash'as, kurio dabartinis failas NEATITIKS.
          source: { line: 1, endLine: 2, hash: "a".repeat(64), text: "senas pjūvis" },
        },
      ],
    },
  });
  const marker = buildExecutionContextMarker({
    taskId: "0042-demo",
    taskText: TASK_TEXT,
    contextPackText: packJson,
  });

  const stale = makeHarness({
    files: {
      [TASK_FILE.replace(/\\/g, "/")]: TASK_TEXT,
      [path.join(RUNTIME, "supervisor", "execution-context.md").replace(/\\/g, "/")]: `${marker}\n\n# Execution context\n`,
      [path.join(RUNTIME, "supervisor", "context-pack.json").replace(/\\/g, "/")]: packJson,
      // Šaltinis diske — kitoks nei pack'e užfiksuotas snapshot'as.
      [path.join(ROOT, "src", "a.ts").replace(/\\/g, "/")]: "export function x(): void {}\n",
    },
  });

  assert.equal(await claudeDispatch(["t"], stale.ports), USAGE_ERROR_EXIT_CODE);
  assert.equal(stale.launchCalls.length, 0, "procesas NEPALEISTAS su pasenusiu pjūviu");
  assert.ok(
    stale.errs.some((line) => line.includes("Execution context gate refused dispatch")),
    "atmetimas paskelbtas operatoriui",
  );
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
