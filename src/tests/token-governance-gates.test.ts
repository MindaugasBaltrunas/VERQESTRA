// VQ-305 (3/3-a): usage-ledger grynųjų taisyklių, route-model matricos ir tool-budget vartų
// unit testai. Fake portai — jokio realaus FS; ledger'is maitinamas sintetiniu JSONL.
import assert from "node:assert/strict";
import test from "node:test";
import {
  buildTaskUsageLedger,
  canonicalTaskPhase,
  classifyTaskUsageCall,
  parseTaskUsageEntries,
  taskPhaseOfEntry,
} from "../domain/tokens/usage-ledger.js";
import {
  classifyTaskRiskTier,
  DEFAULT_ROUTING_POLICY,
  loadRoutingPolicy,
  routeModel,
  routingPolicyHash,
  routingPolicySchema,
} from "../application/token-governance/route-model.js";
import {
  authorizeLlmCall,
  enforceExecutionBudget,
  recordLlmCallReset,
  type TokenBudgetGatePorts,
} from "../application/token-governance/tool-budget-gates.js";
import { SOFT_BUDGET_RATIO } from "../application/token-governance/tool-budget-rules.js";

test("usage-ledger: fazių normalizacija, repair išvedimas ir kvietimų klasifikacija", () => {
  assert.equal(canonicalTaskPhase("dispatch"), "implementation");
  assert.equal(canonicalTaskPhase("diagnose-fastpath"), "diagnosis");
  assert.equal(canonicalTaskPhase("preflight-miss"), "preflight");
  assert.equal(canonicalTaskPhase("bootstrap-graph"), "planning");
  assert.equal(canonicalTaskPhase(""), "other");

  assert.equal(taskPhaseOfEntry({ task_phase: "repair", phase: "dispatch" }), "repair", "aiškus task_phase laimi");
  assert.equal(taskPhaseOfEntry({ phase: "dispatch", attempt: 2 }), "repair", "retry metaduomenys = repair");
  assert.equal(taskPhaseOfEntry({ phase: "dispatch", retry_reason: "tests" }), "repair");
  assert.equal(taskPhaseOfEntry({ phase: "dispatch" }), "implementation");

  assert.equal(classifyTaskUsageCall({ model: "none" }), "deterministic");
  assert.equal(classifyTaskUsageCall({ input_tokens: 10 }), "model-call");
  assert.equal(classifyTaskUsageCall({ outcome: "infrastructure" }), "zero-usage");
});

function usageLine(entry: Record<string, unknown>): string {
  return JSON.stringify(entry);
}

const USAGE_LOG = [
  usageLine({ task_id: "0042", phase: "dispatch", ts: "2026-08-20T01:00:00Z", input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 1000, cache_creation_input_tokens: 25 }),
  usageLine({ task_id: "0042", phase: "dispatch", ts: "2026-08-20T02:00:00Z", attempt: 2, retry_reason: "tests", input_tokens: 200, output_tokens: 100 }),
  usageLine({ task_id: "0042", phase: "diagnose", ts: "2026-08-20T02:30:00Z", model: "none" }),
  usageLine({ task_id: "0042", phase: "dispatch", ts: "2026-08-20T03:00:00Z", outcome: "infrastructure", input_tokens: 0 }),
  usageLine({ task_id: "kitas", phase: "dispatch", ts: "2026-08-20T03:30:00Z", input_tokens: 999 }),
  "sugadinta eilutė { ne json",
].join("\n");

test("usage-ledger: buildTaskUsageLedger — sumos, fazių tvarka, since reset", () => {
  const entries = parseTaskUsageEntries(USAGE_LOG);
  const ledger = buildTaskUsageLedger("0042", entries);
  assert.equal(ledger.records, 4, "svetimo task'o įrašas ir šiukšlė neskaičiuojami");
  assert.equal(ledger.llm_calls, 2, "deterministic ir zero-usage nedega kvietimų");
  assert.equal(ledger.zero_usage_events, 1);
  assert.equal(ledger.deterministic_events, 1);
  assert.equal(ledger.usage.total_tokens, 1475);
  assert.equal(ledger.usage.billable_tokens, 475, "billable be cache_read");
  assert.deepEqual(ledger.phases.map((phase) => phase.phase), ["implementation", "diagnosis", "repair"], "kanoninė tvarka");
  const sum = ledger.phases.reduce((total, phase) => total + phase.usage.billable_tokens, 0);
  assert.equal(sum, ledger.usage.billable_tokens, "visuma = fazių suma");

  const afterReset = buildTaskUsageLedger("0042", entries, { since: "2026-08-20T02:15:00Z" });
  assert.equal(afterReset.llm_calls, 0, "po reset lieka tik deterministic/zero įrašai");
  assert.equal(afterReset.records, 2);
});

const SIZE_SMALL = { lines: 10, allowedPaths: 1, domains: 1, actionBullets: 1 };

test("route-model: bazės klasifikacija, dydis, defer, eskalacija ir lubos", () => {
  assert.equal(classifyTaskRiskTier("# Task\nRotate security keys").tier, "advanced");
  assert.equal(classifyTaskRiskTier("# Task\nKeisk src/x.ts").tier, "standard");
  assert.equal(classifyTaskRiskTier("# Task\nPataisyk typo").tier, "routine");
  assert.equal(
    classifyTaskRiskTier("# Task\n## Agentai\narchitect -> security\n## Tikslas\nTypo fix").tier,
    "routine",
    "## Agentai sekcija nėra rizikos turinys",
  );

  const routine = routeModel({ phase: "implementation", taskText: "typo", failedAttempts: 0, size: SIZE_SMALL });
  assert.equal(routine.tier, "routine");

  const sized = routeModel({
    phase: "implementation",
    taskText: "typo",
    failedAttempts: 0,
    size: { ...SIZE_SMALL, allowedPaths: 5 },
  });
  assert.equal(sized.tier, "standard");
  assert.ok(sized.reason_codes.includes("structural-size"));

  // defer_steps=1 (default): pirma nesėkmė sugeriama, antra kelia pakopą.
  const deferred = routeModel({ phase: "repair", taskText: "typo", failedAttempts: 1, size: SIZE_SMALL });
  assert.equal(deferred.tier, "routine");
  assert.ok(deferred.reason_codes.includes("escalation-deferred"));
  const escalated = routeModel({ phase: "repair", taskText: "typo", failedAttempts: 2, size: SIZE_SMALL });
  assert.equal(escalated.tier, "standard");
  assert.ok(escalated.reason_codes.includes("retry-escalation"));

  // Lubos: daug nesėkmių niekada nepakelia virš advanced (AUTO_ESCALATION_CEILING).
  const capped = routeModel({ phase: "repair", taskText: "typo", failedAttempts: 9, size: SIZE_SMALL });
  assert.equal(capped.tier, "advanced");
  assert.ok(capped.reason_codes.includes("escalation-ceiling"));

  // Explicit virš lubų išlaikomas, bet eskalacija jo nebedidina.
  const explicit = routeModel({
    phase: "implementation",
    taskText: "typo",
    selectedTier: "critical",
    failedAttempts: 5,
    size: SIZE_SMALL,
  });
  assert.equal(explicit.tier, "critical");
  assert.ok(explicit.reason_codes.includes("explicit-above-ceiling"));

  // Biudžeto spaudimas užšaldo eskalaciją.
  const frozen = routeModel({
    phase: "repair",
    taskText: "typo",
    failedAttempts: 3,
    size: SIZE_SMALL,
    budget: { reduceContext: true, remainingTotalLlmCalls: 5, remainingTotalTokens: 100, totalLlmCalls: 3 },
  });
  assert.equal(frozen.tier, "routine");
  assert.ok(frozen.reason_codes.includes("budget-freeze"));

  assert.equal(routingPolicyHash(DEFAULT_ROUTING_POLICY), routingPolicyHash(routingPolicySchema.parse({})));
  assert.equal(DEFAULT_ROUTING_POLICY.escalation.defer_steps, 1, ".prefault užpildo vidinius defaultus");
});

function fakeConfigFs(files: Record<string, string>): { readTextFileIfExists: (p: string) => Promise<string | undefined> } {
  const map = new Map(Object.entries(files));
  return { readTextFileIfExists: async (p) => map.get(p.replace(/\\/g, "/")) };
}

test("loadRoutingPolicy: failsafe — trūkstamas/sugadintas konfigas ar blokas → default politika", async () => {
  assert.deepEqual(await loadRoutingPolicy(fakeConfigFs({}), "/repo/vq"), DEFAULT_ROUTING_POLICY);
  assert.deepEqual(
    await loadRoutingPolicy(fakeConfigFs({ "/repo/vq/config/model-policy.json": "{ blogas" }), "/repo/vq"),
    DEFAULT_ROUTING_POLICY,
  );
  const configured = await loadRoutingPolicy(
    fakeConfigFs({
      "/repo/vq/config/model-policy.json": JSON.stringify({
        tiers: ["sonnet"],
        routing: { escalation: { defer_steps: 0, max_tier: "standard" } },
      }),
    }),
    "/repo/vq",
  );
  assert.equal(configured.escalation.defer_steps, 0);
  assert.equal(configured.escalation.max_tier, "standard");
});

const TOOL_BUDGET_JSON = JSON.stringify({
  default: {
    max_llm_calls: 3,
    max_total_llm_calls: 10,
    max_total_billable_tokens: 1000,
    phase_limits: { diagnose: { max_llm_calls: 2 } },
  },
});

function makeGatePorts(input: {
  configs?: Record<string, string>;
  usageLog?: string;
  resets?: Record<string, unknown>;
}): { ports: TokenBudgetGatePorts; statusWrites: [string, unknown][]; resets: Record<string, unknown> } {
  const statusWrites: [string, unknown][] = [];
  let resets: Record<string, unknown> = input.resets ?? {};
  const configs = {
    "/repo/vq/config/tool-budget.json": TOOL_BUDGET_JSON,
    "/repo/vq/config/model-policy.json": JSON.stringify({ tiers: ["haiku", "sonnet", "opus"] }),
    ...input.configs,
  };
  const ports: TokenBudgetGatePorts = {
    fs: fakeConfigFs(configs),
    readTokenUsageLog: async () => input.usageLog ?? "",
    readLlmCallResets: async () => resets,
    writeLlmCallResets: async (next) => void (resets = next),
    writeBudgetStatus: async (key, status) => void statusWrites.push([key, status]),
    nowIso: () => "2026-08-20T09:00:00.000Z",
  };
  return {
    ports,
    statusWrites,
    get resets() {
      return resets;
    },
  };
}

const PACK = { task_id: "0042", allowed_paths: ["src/a.ts"] };

test("enforceExecutionBudget: žalias kelias, modelio/įrankių/konteksto veto", async () => {
  const { ports, statusWrites } = makeGatePorts({});
  const ok = await enforceExecutionBudget(ports, "/repo/vq", { model: "sonnet", contextPack: PACK });
  assert.equal(ok.ok, true);
  assert.equal(ok.llm_calls, 1, "projektuojamas kvietimas įskaitytas");
  assert.equal(ok.task_id, "0042", "task id iš contextPack");
  assert.equal(statusWrites.at(-1)?.[0], "budget_enforcement");

  const badModel = await enforceExecutionBudget(ports, "/repo/vq", { model: "fable", contextPack: PACK });
  assert.equal(badModel.ok, false);
  assert.ok(badModel.reasons.includes("model not allowed: fable"));

  const badTool = await enforceExecutionBudget(ports, "/repo/vq", {
    model: "sonnet",
    contextPack: PACK,
    requestedTools: ["browser"],
  });
  assert.ok(badTool.reasons.includes("tool not allowed: browser"));
});

test("enforceExecutionBudget: HUMAN-REVIEW-APPROVED slopina TIK `context files` priežastį", async () => {
  const CONTEXT_BUDGET = { "/repo/vq/config/context-budget.json": JSON.stringify({ max_files: 2, max_context_chars: 120 }) };
  const wide = { task_id: "0042", allowed_paths: ["src/a.ts", "src/b.ts", "src/c.ts"] };

  const { ports } = makeGatePorts({ configs: CONTEXT_BUDGET });
  const parked = await enforceExecutionBudget(ports, "/repo/vq", { model: "sonnet", contextPack: wide });
  assert.equal(parked.ok, false, "be žymos apimtis vis dar parkuoja");
  assert.ok(parked.reasons.includes("context files 3 > 2"), `got: ${parked.reasons.join("; ")}`);
  assert.deepEqual(parked.suppressed_reasons, []);

  const approved = await enforceExecutionBudget(ports, "/repo/vq", {
    model: "sonnet",
    contextPack: wide,
    humanReviewApproved: "operatorius 2026-09-03 ok",
  });
  assert.equal(approved.ok, true, `žyma atrakina apimtį (reasons: ${approved.reasons.join("; ")})`);
  assert.ok(!approved.reasons.some((reason) => reason.startsWith("context files")), "priežastis nebeįtraukiama");
  assert.deepEqual(approved.suppressed_reasons, [
    "context files 3 > 2 — suppressed by HUMAN-REVIEW-APPROVED: operatorius 2026-09-03 ok",
  ]);

  // Tuščia/blanki žyma nėra patvirtinimas.
  const blank = await enforceExecutionBudget(ports, "/repo/vq", { model: "sonnet", contextPack: wide, humanReviewApproved: "  " });
  assert.equal(blank.ok, false);
  assert.ok(blank.reasons.includes("context files 3 > 2"));

  // Slopinimo apimtis SIAURA: modelis, įrankiai, `context chars` ir ledger'io lubos lieka.
  const others = await enforceExecutionBudget(ports, "/repo/vq", {
    model: "fable",
    contextPack: { ...wide, filler: "x".repeat(200) },
    requestedTools: ["browser"],
    humanReviewApproved: "operatorius 2026-09-03 ok",
  });
  assert.equal(others.ok, false);
  assert.ok(others.reasons.includes("model not allowed: fable"));
  assert.ok(others.reasons.includes("tool not allowed: browser"));
  assert.ok(others.reasons.some((reason) => reason.startsWith("context chars")), `got: ${others.reasons.join("; ")}`);

  const heavy = makeGatePorts({
    configs: CONTEXT_BUDGET,
    usageLog: [
      usageLine({ task_id: "0042", phase: "dispatch", ts: "2026-08-20T01:00:00Z", input_tokens: 10 }),
      usageLine({ task_id: "0042", phase: "dispatch", ts: "2026-08-20T02:00:00Z", attempt: 2, retry_reason: "x", input_tokens: 10 }),
      usageLine({ task_id: "0042", phase: "dispatch", ts: "2026-08-20T03:00:00Z", attempt: 3, retry_reason: "x", input_tokens: 10 }),
    ].join("\n"),
  });
  const ledgerBlocked = await enforceExecutionBudget(heavy.ports, "/repo/vq", {
    model: "sonnet",
    contextPack: wide,
    humanReviewApproved: "operatorius 2026-09-03 ok",
  });
  assert.equal(ledgerBlocked.ok, false, "žyma neapmoka realių sąnaudų");
  assert.ok(ledgerBlocked.reasons.includes("LLM calls 4 > 3"), `got: ${ledgerBlocked.reasons.join("; ")}`);
});

test("enforceExecutionBudget: ledger vartai — dispatch riba, infra nedega bandymo, reset atrakina", async () => {
  const heavyLog = [
    usageLine({ task_id: "0042", phase: "dispatch", ts: "2026-08-20T01:00:00Z", input_tokens: 10 }),
    usageLine({ task_id: "0042", phase: "dispatch", ts: "2026-08-20T02:00:00Z", attempt: 2, retry_reason: "x", input_tokens: 10 }),
    usageLine({ task_id: "0042", phase: "dispatch", ts: "2026-08-20T03:00:00Z", attempt: 3, retry_reason: "x", input_tokens: 10 }),
    usageLine({ task_id: "0042", phase: "dispatch", ts: "2026-08-20T04:00:00Z", outcome: "infrastructure" }),
  ].join("\n");
  const { ports } = makeGatePorts({ usageLog: heavyLog });
  const blocked = await enforceExecutionBudget(ports, "/repo/vq", { model: "sonnet", contextPack: PACK });
  assert.equal(blocked.ok, false);
  assert.ok(blocked.reasons.includes("LLM calls 4 > 3"), `got: ${blocked.reasons.join("; ")}`);

  // Requeue reset žyma atrakina: skaičiuojami tik vėlesni įrašai.
  await recordLlmCallReset(ports, "0042");
  const afterReset = await enforceExecutionBudget(ports, "/repo/vq", { model: "sonnet", contextPack: PACK });
  assert.equal(afterReset.ok, true, "po reset ledger tuščias ir kvietimas leidžiamas");
});

test("enforceExecutionBudget: billable lubos, raw notice ir soft slenkstis", async () => {
  // Task billable 800 (impl 400 + repair 400), raw 2000 — raw virš 1000 lubų, billable telpa;
  // impl fazės billable 400 telpa į projektuojamos fazės rezervą (45% × 1000 = 450).
  const log = [
    usageLine({
      task_id: "0042",
      phase: "dispatch",
      ts: "2026-08-20T01:00:00Z",
      input_tokens: 250,
      output_tokens: 100,
      cache_creation_input_tokens: 50,
      cache_read_input_tokens: 1200,
    }),
    usageLine({
      task_id: "0042",
      phase: "dispatch",
      ts: "2026-08-20T02:00:00Z",
      attempt: 2,
      retry_reason: "tests",
      input_tokens: 300,
      output_tokens: 100,
    }),
  ].join("\n");
  const { ports } = makeGatePorts({ usageLog: log });
  const status = await enforceExecutionBudget(ports, "/repo/vq", { model: "sonnet", contextPack: PACK });
  assert.equal(status.ok, true, `raw perviršis baigties nekeičia (reasons: ${status.reasons.join("; ")})`);
  assert.equal(status.billable_tokens, 800);
  assert.equal(status.total_tokens, 2000);
  assert.ok(
    status.raw_notices.some((notice) => notice.includes("task raw tokens 2000 > 1000 (billable 800 within limit)")),
    `raw notice: ${status.raw_notices.join(" | ")}`,
  );
  assert.ok(status.soft_reasons.some((reason) => reason.startsWith("task tokens 800 near 1000")), "soft >= 80%");
  assert.equal(status.reduce_context, true);
  assert.equal(SOFT_BUDGET_RATIO, 0.8);
});

test("authorizeLlmCall: fazės rezervas projektuojamai fazei ir failsafe be konfigo", async () => {
  const { ports } = makeGatePorts({});
  const auth = await authorizeLlmCall(ports, "/repo/vq", { taskId: "0042", phase: "diagnosis" });
  assert.equal(auth.allowed, true);
  const diagnosis = auth.phase_status.find((phase) => phase.phase === "diagnosis");
  assert.ok(diagnosis, "projektuojama fazė visada ataskaitoje");
  assert.equal(diagnosis?.max_llm_calls, 2, "phase_limits.diagnose normalizuotas į diagnosis");

  // Be jokio konfigo — failsafe default profilis (be limitų) leidžia kvietimą.
  const bare = makeGatePorts({ configs: { "/repo/vq/config/tool-budget.json": "{ blogas" } });
  const failsafe = await authorizeLlmCall(bare.ports, "/repo/vq", { taskId: "0042", phase: "preflight" });
  assert.equal(failsafe.allowed, true);
  assert.equal(failsafe.remaining_total_llm_calls, null, "failsafe profilis be whole-task ribų");
});
