// VQ-501 (2/5-d) testai — dispatch sprendimų pusė: token-budget-config sluoksnis su
// stebimu pirmumu, execution-context vartai (application), pristatymo/tool-schema pusė
// (infrastructure) ir routing/budget planai (interfaces) per fake portus.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_MAX_DISPATCH_BILLABLE_TOKENS,
  loadTokenBudgetConfig,
  resolveMidDispatchTokenLimit,
  resolveTokenBudgetConfig,
} from "../application/token-governance/token-budget-config.js";
import { DEFAULT_TURN_LIMITS } from "../application/token-governance/turn-budget.js";
import {
  buildWorkerPrompt,
  evaluateExecutionContextGate,
  isRepairDispatchPrompt,
  isSourceChangeDispatch,
  publishedTokenBudgetTier,
  resolveCanonicalWorkerPrompt,
  resolveExecutionContextMode,
  workerPromptPreview,
} from "../application/task-execution/execution-context-gate.js";
import {
  buildExecutionContextMarker,
} from "../application/context-pack/execution-context-fingerprint.js";
import type { LlmCallAuthorization } from "../application/token-governance/tool-budget-gates.js";
import {
  claudeLastLogWriteFatal,
  writeClaudeLastLog,
} from "../infrastructure/adapters/claude-last-log.js";
import {
  loadDispatchToolPolicyDecision,
  nonWindowsClaudeDispatchArgs,
  resolveDispatchPromptDelivery,
  resolveDispatchToolSchemaProfile,
} from "../infrastructure/adapters/claude-dispatch-delivery.js";
import { claudeDispatchTimeoutMs, DEFAULT_CLAUDE_DISPATCH_TIMEOUT_MS } from "../interfaces/cli/dispatch/claude-dispatch/dispatch-timeout.js";
import { resolveDispatchRoutingPlan } from "../interfaces/cli/dispatch/claude-dispatch/dispatch-routing-plan.js";
import { resolveDispatchBudgetPlan } from "../interfaces/cli/dispatch/claude-dispatch/dispatch-budget-plan.js";
import { buildBasePrompt, ETALONAS_TEMPLATE_PATH, splitDirective, type PreflightPromptContext } from "../interfaces/cli/dispatch/claude-preflight/preflight-llm.js";
import { DEFAULT_PREFLIGHT_LIMITS } from "../application/policy-governance/preflight-limits-policy.js";

const emptyFs = { readTextFileIfExists: async (): Promise<string | undefined> => undefined };

function auth(overrides: Partial<LlmCallAuthorization> = {}): LlmCallAuthorization {
  return {
    allowed: true,
    task_id: "0042",
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

test("token-budget-config: pirmumas per raktą su stebimais šaltiniais ir kietos lubos", async () => {
  const defaults = resolveTokenBudgetConfig({});
  assert.deepEqual(defaults.turnLimits, DEFAULT_TURN_LIMITS);
  assert.equal(defaults.sources.large, "code");
  assert.equal(defaults.maxDispatchBillableTokens, DEFAULT_MAX_DISPATCH_BILLABLE_TOKENS);

  const layered = resolveTokenBudgetConfig({
    override: { turnLimits: { medium: 90 } },
    legacyTurnLimits: { medium: 70, small: 10 },
  });
  assert.equal(layered.turnLimits.medium, 90);
  assert.equal(layered.sources.medium, "config", "konfigas laimi prieš legacy");
  assert.equal(layered.turnLimits.small, 10);
  assert.equal(layered.sources.small, "legacy");
  assert.equal(layered.sources.repair, "code");

  assert.throws(() => resolveTokenBudgetConfig({ override: { turnLimits: { large: 301 } } }), /hard ceiling 300/);
  assert.throws(
    () => resolveTokenBudgetConfig({ override: { turnLimits: { small: 100, medium: 50 } } }),
    /small \(100\) must not exceed medium \(50\)/,
  );
  assert.throws(
    () => resolveTokenBudgetConfig({ override: { maxDispatchBillableTokens: 50_000 } }),
    /below the hard floor 100000/,
  );
  // Legacy sluoksnio pažeidimas atributuojamas legacy failui, ne konfigui.
  assert.throws(
    () => resolveTokenBudgetConfig({ legacyTurnLimits: { large: 500 } }),
    /preflight-limits\.json#turnLimits/,
  );

  // Loader'is: nėra failo → default'ai; blogas JSON / nežinomas raktas → fail-fast.
  const loaded = await loadTokenBudgetConfig(emptyFs, "/repo/vq");
  assert.equal(loaded.turnLimits.large, DEFAULT_TURN_LIMITS.large);
  await assert.rejects(
    () => loadTokenBudgetConfig({ readTextFileIfExists: async () => "{ blogas" }, "/repo/vq"),
    /not valid JSON/,
  );
  await assert.rejects(
    () => loadTokenBudgetConfig({ readTextFileIfExists: async () => '{"nezinomas":1}' }, "/repo/vq"),
    /validation failed/,
  );

  assert.deepEqual(resolveMidDispatchTokenLimit({ maxDispatchBillableTokens: 1000, remainingTaskTokens: null }), {
    limit: 1000,
    source: "dispatch-ceiling",
  });
  assert.deepEqual(resolveMidDispatchTokenLimit({ maxDispatchBillableTokens: 1000, remainingTaskTokens: 400 }), {
    limit: 400,
    source: "task-remaining",
  });
  assert.deepEqual(resolveMidDispatchTokenLimit({ maxDispatchBillableTokens: 1000, remainingTaskTokens: -5 }), {
    limit: 0,
    source: "task-remaining",
  });
});

const SOURCE_TASK = "# Task\n\n## Failai\nLeidžiama:\n- `src/a.ts`\n";

test("execution-context-gate: source-change detekcija, mode, tier paskelbimas", () => {
  assert.equal(isSourceChangeDispatch(SOURCE_TASK), true);
  assert.equal(isSourceChangeDispatch("# Task\n\n## Failai\nLeidžiama:\n- `doc/x.md`\n"), false);
  assert.equal(isSourceChangeDispatch("# Task\n\n## Failai\nLeidžiama:\n- `AG/tasks/queue/0001.md`\n"), false);
  assert.equal(isSourceChangeDispatch("# Repair Task\n"), false, "be Failai — ne source change");
  assert.equal(isRepairDispatchPrompt("# Repair Task\n\n## Klaida\nx"), true);
  assert.equal(isRepairDispatchPrompt(SOURCE_TASK), false);

  assert.equal(resolveExecutionContextMode({ AG_EXECUTION_CONTEXT_MODE: "required" }), "required");
  assert.equal(resolveExecutionContextMode({ AG_EXECUTION_CONTEXT_MODE: "netinkamas" }), "preferred");
  assert.equal(resolveExecutionContextMode({}), "preferred");

  assert.equal(publishedTokenBudgetTier({ task_id: "0042", token_budget_tier: "large" }, "0042"), "large");
  assert.equal(publishedTokenBudgetTier({ task_id: "kitas", token_budget_tier: "large" }, "0042"), undefined);
  assert.equal(publishedTokenBudgetTier({ token_budget_tier: "netinkamas" }, "0042"), undefined);
});

test("execution-context-gate: off/missing/attach/mismatch šakos su 0002 repair išimtimi", () => {
  const taskText = SOURCE_TASK;
  // SCHEMA-VALIDUS minimalus pack'as. Nuo C17 vartas neparsinamą/schema-invalidų pack'ą laiko
  // galinčiu nešti SRC pjūvius (fail-closed) ir source-change dispatch'ą atmeta — tad fikstūra
  // `{task_id}` čia nebe „minimalizmas", o kitas, atmetimo kelias.
  const contextPackText = JSON.stringify({
    task_id: "0042",
    phase: "implementation",
    goal: "Tikslas.",
    allowed_paths: ["src/a.ts"],
    checks: ["pnpm test"],
  });
  const marker = buildExecutionContextMarker({ taskId: "0042", taskText, contextPackText });
  const artifact = `${marker}\n\n# Execution context body\n`;
  // `staleSourceSlices` PRIVALOMAS: tipas verčia kiekvieną kvietėją pasakyti, ką jis žino,
  // tad „nepatikrinta" nebegali tyliai virsti „šviežia".
  const base = {
    mode: "preferred" as const,
    sourceChange: true,
    taskId: "0042",
    taskText,
    staleSourceSlices: "unchecked" as const,
  };

  assert.equal(evaluateExecutionContextGate({ ...base, mode: "off" }).kind, "skip");
  assert.equal(evaluateExecutionContextGate({ ...base, mode: "required" }).kind, "refuse", "required be artefakto");
  assert.equal(evaluateExecutionContextGate(base).kind, "skip");

  const attach = evaluateExecutionContextGate({ ...base, executionContext: artifact, contextPackText });
  assert.equal(attach.kind, "attach");

  const foreign = evaluateExecutionContextGate({
    ...base,
    executionContext: artifact.replace("task_id=0042", "task_id=kitas"),
    contextPackText,
  });
  assert.equal(foreign.kind, "refuse", "svetimo task'o kontekstas — fail-fast");

  const staleForRepair = evaluateExecutionContextGate({
    ...base,
    isRepair: true,
    executionContext: artifact,
    contextPackText,
    taskText: `${taskText}\npakeistas`,
  });
  assert.equal(staleForRepair.kind, "skip", "0002: repair'ui pasenęs kontekstas — skip, ne refuse");
  assert.match(staleForRepair.kind === "skip" ? staleForRepair.reason : "", /regeneration_unavailable/);

  // Artefaktų darna NELYGU šviežumui: task tekstas ir pack'as sutampa baitas į baitą, o SRC
  // pjūvio šaltinis jau perrašytas ankstesnio bandymo. Politika ta pati kaip fingerprint
  // neatitikimui — source-change non-repair fail-fast, repair'ui skip.
  const staleSlice = evaluateExecutionContextGate({
    ...base,
    executionContext: artifact,
    contextPackText,
    staleSourceSlices: ["src/a.ts"],
  });
  assert.equal(staleSlice.kind, "refuse", "pasenęs SRC pjūvis source-change dispatch'e — refuse");
  assert.match(staleSlice.kind === "refuse" ? staleSlice.reason : "", /no longer match the working tree: src\/a\.ts/);

  assert.equal(
    evaluateExecutionContextGate({
      ...base,
      isRepair: true,
      executionContext: artifact,
      contextPackText,
      staleSourceSlices: ["src/a.ts"],
    }).kind,
    "skip",
    "repair'ui pasenęs pjūvis — skip, ne refuse (ta pati 0002 politika)",
  );

  assert.equal(
    evaluateExecutionContextGate({ ...base, executionContext: artifact, contextPackText, staleSourceSlices: [] }).kind,
    "attach",
    "tuščias sąrašas reiškia PATIKRINTA ir šviežia",
  );

  // `"unchecked"` savaime NĖRA blokas: kai pack'e SRC pjūvių nėra, tikrinti nėra ko.
  assert.equal(
    evaluateExecutionContextGate({ ...base, executionContext: artifact, contextPackText }).kind,
    "attach",
    "nepatikrinta + pack'e nėra pjūvių — praleidžiama",
  );

  // Bet kai pjūvių YRA, nepatikrintas kelias konteksto nebeprisega. Garantija struktūrinė: ji
  // klausia PATIES pack'o, o ne to, ar `symbol_slices` konfige įjungtas.
  const packWithSlices = JSON.stringify({
    task_id: "0042",
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
          source: { line: 1, endLine: 2, hash: "a".repeat(64), text: "pjūvis" },
        },
      ],
    },
  });
  const sliceMarker = buildExecutionContextMarker({ taskId: "0042", taskText, contextPackText: packWithSlices });
  const unverified = evaluateExecutionContextGate({
    ...base,
    executionContext: `${sliceMarker}\n\n# Execution context body\n`,
    contextPackText: packWithSlices,
  });
  assert.equal(unverified.kind, "refuse", "nepatikrinti SRC pjūviai source-change dispatch'e — refuse");
  assert.match(unverified.kind === "refuse" ? unverified.reason : "", /cannot verify them against the working tree/);

  const canonical = resolveCanonicalWorkerPrompt({ ...base, executionContext: artifact, contextPackText });
  assert.equal(canonical.kind, "prompt");
  if (canonical.kind === "prompt") {
    assert.ok(canonical.prompt.includes("# Execution context"), "kontekstas prisegtas po --- skirtuko");
    assert.ok(canonical.prompt.startsWith("# Task"));
  }

  assert.equal(buildWorkerPrompt({ taskText, compiledTask: "KOMPILIUOTA" }), "KOMPILIUOTA");
  assert.equal(buildWorkerPrompt({ taskText }), taskText, "be konteksto — NEPAKEISTAS tekstas");
  const preview = workerPromptPreview("x".repeat(13_000), "AG/tasks/queue/0042.md", 100);
  assert.ok(preview.includes("[...sutrumpinta. Pilnas failas: AG/tasks/queue/0042.md]"));
});

test("claude-dispatch-delivery: POSIX argumentai, delivery šakos ir 0028 tool profilis", async () => {
  const args = nonWindowsClaudeDispatchArgs("model-x", 60, ["WebSearch"]);
  assert.deepEqual(args, [
    "-p",
    "--verbose",
    "--permission-mode",
    "auto",
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--include-hook-events",
    "--model",
    "model-x",
    "--max-turns",
    "60",
    "--disallowed-tools",
    "WebSearch",
  ]);

  const windows = resolveDispatchPromptDelivery({
    powerShellCommand: "pwsh.exe",
    promptPath: "C:/p.md",
    model: "model-x",
    prompt: "PROMPT",
    disallowedTools: ["WebFetch"],
  });
  assert.equal(windows.platform, "windows");
  assert.equal(windows.prompt, "PROMPT");
  const posix = resolveDispatchPromptDelivery({ promptPath: "/p.md", model: "model-x", prompt: "PROMPT" });
  assert.equal(posix.platform, "posix");
  assert.equal(posix.transport, "stdin");

  // Pacing įrankių draudimas (2026-08-27 „no write-tool calls" incidentas) galioja
  // KIEKVIENAME režime — ir kai dispatch_tool_schema išjungtas ar be biudžeto kandidatų.
  const pacing = ["CronCreate", "EnterPlanMode", "ScheduleWakeup"];
  const off = resolveDispatchToolSchemaProfile({
    enabled: false,
    platform: "windows",
    policy: {},
    mcp: { known: false, tools: [], source: "registry absent" },
  });
  assert.equal(off.mode, "off");
  assert.deepEqual(off.candidates, []);
  assert.deepEqual(off.applied, pacing);
  assert.equal(off.shadow, undefined, "mcp.known === false — pjūvis neautoritetingas, ne 0");

  // 036-c-04: shadow pora skaičiuojama net kai profilis IŠJUNGTAS — `off` grąžina pilną porą,
  // kai MCP pjūvis žinomas, o `candidates`/`applied` lieka nepakitę.
  const offWithMcp = resolveDispatchToolSchemaProfile({
    enabled: false,
    platform: "windows",
    policy: {},
    mcp: { known: true, tools: ["mcp__srv__tool"], source: "registry" },
  });
  assert.equal(offWithMcp.mode, "off");
  assert.deepEqual(offWithMcp.candidates, []);
  assert.deepEqual(offWithMcp.applied, pacing);
  assert.ok(offWithMcp.shadow, "known mcp — shadow pora užpildyta net off režime");
  assert.equal(offWithMcp.shadow?.fullChars, offWithMcp.shadow?.reducedChars, "off: applied=pacing neliečia inventoriaus");

  const none = resolveDispatchToolSchemaProfile({
    enabled: true,
    platform: "posix",
    policy: { mcp: false },
    mcp: { known: false, tools: [], source: "registry absent: vq/config/mcp-capabilities.json" },
  });
  assert.equal(none.mode, "no-candidates");
  assert.match(none.reason, /mcp schemas left uncompressed \(registry absent/);
  assert.deepEqual(none.applied, pacing);
  assert.equal(none.shadow, undefined, "mcp.known === false — pjūvis neautoritetingas, ne 0");

  const applied = resolveDispatchToolSchemaProfile({
    enabled: true,
    platform: "windows",
    policy: { browser: false, scraper: false, mcp: false },
    mcp: { known: true, tools: ["mcp__srv__tool"], source: "registry" },
  });
  assert.equal(applied.mode, "applied");
  assert.deepEqual(applied.candidates, ["WebFetch", "WebSearch", "mcp__srv__tool"]);
  assert.deepEqual(applied.applied, ["CronCreate", "EnterPlanMode", "ScheduleWakeup", "WebFetch", "WebSearch", "mcp__srv__tool"]);
  assert.ok(applied.shadow, "known mcp + pašalinti kandidatai — shadow pora užpildyta");
  assert.ok(
    (applied.shadow?.reducedChars ?? Infinity) < (applied.shadow?.fullChars ?? -Infinity),
    "applied: pašalinti įrankiai turi sumažinti proxy dydį",
  );

  // Sugadintas biudžetas NIEKO nedraudžia (fail-safe {}).
  assert.deepEqual(await loadDispatchToolPolicyDecision({ readTextFileIfExists: async () => "{ blogas" }, "/repo/vq"), {});
});

test("claude-last-log: attempt kanalas pirminis, veidrodžio retry, fatal tik be nė vieno kanalo", async () => {
  const writes: string[] = [];
  let globalFails = 2;
  const result = await writeClaudeLastLog(
    { attemptPath: "/att/claude-last.log", globalPath: "/vq/logs/claude-last.log" },
    "TEKSTAS",
    {
      write: async (target) => {
        if (target.startsWith("/vq") && globalFails > 0) {
          globalFails -= 1;
          throw new Error("EBUSY");
        }
        writes.push(target);
      },
      sleep: async () => {},
    },
  );
  assert.deepEqual(result, { attempt: "written", global: "written", errors: [] });
  assert.equal(writes.length, 2);
  assert.equal(claudeLastLogWriteFatal(result), false);

  const blind = await writeClaudeLastLog(
    { globalPath: "/vq/logs/claude-last.log" },
    "TEKSTAS",
    {
      write: async () => {
        throw new Error("EBUSY");
      },
      sleep: async () => {},
      attempts: 2,
    },
  );
  assert.equal(blind.attempt, "absent");
  assert.equal(blind.global, "failed");
  assert.equal(claudeLastLogWriteFatal(blind), true);
  assert.equal(blind.errors.length, 1, "tik paskutinio bandymo klaida");
});

test("dispatch-timeout: env override laimi, kitaip biudžeto derivacija arba plačiausias langas", () => {
  assert.equal(claudeDispatchTimeoutMs({ CLAUDE_DISPATCH_TIMEOUT_MS: "5000" }), 5000);
  assert.equal(claudeDispatchTimeoutMs({}), DEFAULT_CLAUDE_DISPATCH_TIMEOUT_MS);
  const derived = claudeDispatchTimeoutMs({}, { tier: "small" });
  assert.ok(derived < DEFAULT_CLAUDE_DISPATCH_TIMEOUT_MS, "small langas siauresnis už large default'ą");
});

test("dispatch-routing-plan: maršruto log eilutės ir eskalacijos žinutė per provider portus", async () => {
  const lines: string[] = [];
  const plan = await resolveDispatchRoutingPlan({
    runtimeRoot: "/repo/vq",
    taskId: "0042",
    taskText: SOURCE_TASK,
    phase: "implementation",
    decision: {},
    selectedModel: "sonnet",
    failedAttempts: 2,
    authorization: auth(),
    policyFs: emptyFs,
    models: {
      routingTierOfSelection: () => "standard",
      modelTierOfRoutingTier: (tier) => `model-tier-${tier}`,
      resolveRoutedModel: async (tier) => `claude-${tier}`,
    },
    logDispatch: async (line) => {
      lines.push(line);
    },
  });
  assert.equal(plan.claudeModel, `claude-${plan.routing.tier}`);
  assert.match(lines[0] ?? "", /^MODEL ROUTING: task=0042 phase=implementation selected=sonnet/);
  // failedAttempts=2 su default defer_steps=1 → viena eskalacijos pakopa virš bazės.
  assert.notEqual(plan.routing.tier, plan.routing.base_tier);
  assert.match(lines[1] ?? "", /^MODEL ESCALATION: task=0042/);
});

const ETALONAS_SECTION_LIST = [
  "# Task", "## Spec source", "## Priklausomybės", "## Žingsnis 0", "## Tikslas",
  "## Agentai", "## Failai", "## Veiksmas", "## Patikra", "## Stop", "## Neįtraukta",
];

function assertEtalonasTemplate(prompt: string, extra: RegExp[], label: string): void {
  assert.ok(prompt.includes(ETALONAS_TEMPLATE_PATH), `${label} cituoja etalono kelią`);
  for (const heading of ETALONAS_SECTION_LIST) assert.ok(prompt.includes(heading), `${label}: ${heading}`);
  for (const pattern of extra) assert.match(prompt, pattern, `${label}: ${pattern}`);
}

test("preflight-llm: reformulacijos ir skėlimo prompt'ai gauna etalono šabloną (070-c-04)", () => {
  const context: PreflightPromptContext = {
    taskId: "0042", activeText: "# Task\n", openSpecContext: "", architectureRules: "",
    availableAgents: "coder, reviewer, tester", modelSelectionRules: "",
  };
  assertEtalonasTemplate(
    buildBasePrompt(context, "full"),
    [/katalogo wildcard'as/, /savo testo failu/, /I18nContext\.tsx/, /dashboard\.css/],
    "reformulacijos promptas",
  );
  assertEtalonasTemplate(
    splitDirective(["10 domenų > 5"], DEFAULT_PREFLIGHT_LIMITS, false),
    [/## Failai`\s*scope NEGALI persidengti/, /duplicate_scope/, /UI vaikas `## Priklausomybės` PRIVALO nurodyti serverio vaiko task id/],
    "skėlimo promptas",
  );
});

test("dispatch-budget-plan: paskelbtas tier'as, reduced šaka ir stebimi šaltiniai log eilutėse", async () => {
  const base = {
    runtimeRoot: "/repo/vq",
    taskId: "0042",
    taskMetrics: { lines: 10, allowedPaths: 1, domains: 1, actionBullets: 1, domainNames: ["src"] },
    phase: "implementation" as const,
    remainingTaskTokens: null,
    policyFs: emptyFs,
    env: {},
  };
  const published = await resolveDispatchBudgetPlan({
    ...base,
    decision: { task_id: "0042", token_budget_tier: "large" },
    reduceContextReasons: [],
  });
  // 016 (2026-08-25): lubos default'as suderintas su 0033 kalibracija — large tier'as gauna
  // PILNĄ lentelės 180, lubos jo nebekerpa (min(180, 180)).
  assert.equal(published.dispatchMaxTurns, DEFAULT_TURN_LIMITS.large);
  assert.match(published.turnLog, /tier=large source=token-budget/);
  assert.match(published.tokenLog, /limit=1500000 limit_source=dispatch-ceiling/);

  const reduced = await resolveDispatchBudgetPlan({
    ...base,
    decision: { task_id: "0042", token_budget_tier: "large" },
    reduceContextReasons: ["task tokens near limit"],
    remainingTaskTokens: 200_000,
  });
  assert.match(reduced.turnLog, /source=reduced\(soft-budget\) base_tier=large/);
  assert.equal(reduced.dispatchMaxTurns, DEFAULT_TURN_LIMITS.medium, "reduced nuleidžia vienu laipteliu");
  assert.match(reduced.tokenLog, /limit=200000 limit_source=task-remaining/);

  // Svetimo task'o sprendimas → struktūrinis kelias.
  const structural = await resolveDispatchBudgetPlan({
    ...base,
    decision: { task_id: "kitas", token_budget_tier: "large" },
    reduceContextReasons: [],
  });
  assert.match(structural.turnLog, /source=structural/);
});
