// VQ-501 (2/5-e) testai — dispatch runtime pusė: stop-bridge laukimo taisyklės (1213/1218),
// execution-result įrašo statyba (1117a), arrest stebėtojo IO apvalkalas, mid-dispatch
// watchdog'as su realiu stream meter'iu ir worker prompt paruošimas per portus.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAX_STOP_BRIDGE_WAIT_MS,
  STOP_BRIDGE_WAIT_MS,
  STOP_BRIDGE_WAIT_POLL_MS,
  classifyStopBridgeDone,
  isEmptyDispatchUsage,
  isZeroUsageLimitSignal,
  mergeStopBridgeSources,
  shouldWaitForOwnStopBridge,
  stopBridgeWaitMs,
  waitForOwnStopBridgeDone,
  type StopBridgeProbeResult,
} from "../application/task-execution/stop-bridge-wait.js";
import {
  buildDispatchExecutionRecord,
} from "../application/task-execution/dispatch-execution-record.js";
import { observeContextCompressionArrest } from "../application/context-pack/compression-arrest-observer.js";
import { contextArtifactSha256 } from "../application/context-pack/execution-context-fingerprint.js";
import type { ContextPackFileSystemPort } from "../application/context-pack/ports.js";
import {
  billableMeterBlindNotice,
  billableTokensOfStream,
  createMidDispatchBudgetWatchdog,
} from "../infrastructure/adapters/mid-dispatch-budget.js";
import { prepareWorkerPromptTask } from "../interfaces/cli/dispatch/claude-dispatch/worker-prompt-preparation.js";

function fakeContextPackFs(overrides: Partial<ContextPackFileSystemPort> = {}): ContextPackFileSystemPort {
  return {
    readTextFileIfExists: async () => undefined,
    readFileBytes: async () => new Uint8Array(),
    exists: async () => false,
    appendTextFile: async () => {},
    writeTextFile: async () => {},
    makeDirectory: async () => {},
    ...overrides,
  };
}

test("stop-bridge-wait: zero-usage klasifikacija ir done nuosavybė pagal nonce", () => {
  assert.equal(isEmptyDispatchUsage(undefined), true);
  assert.equal(isEmptyDispatchUsage({ cache_read_input_tokens: 5 }), false);
  assert.equal(isZeroUsageLimitSignal(0, undefined, false), true);
  assert.equal(isZeroUsageLimitSignal(0, undefined, true), false, "1055: done sesija nėra limitas");
  assert.equal(isZeroUsageLimitSignal(1, undefined, false), false);

  assert.equal(classifyStopBridgeDone('{"status":"done","dispatch_nonce":"n1"}', "n1"), "own-done");
  assert.equal(classifyStopBridgeDone('{"status":"done","dispatch_nonce":"kitas"}', "n1"), "foreign-done");
  assert.equal(classifyStopBridgeDone('{"status":"done"}', ""), "foreign-done", "tuščias mūsų nonce — svetimas");
  assert.equal(classifyStopBridgeDone('{"status":"error","dispatch_nonce":"n1"}', "n1"), "none");
  assert.equal(classifyStopBridgeDone("ne json", "n1"), "none");
});

test("stop-bridge-wait: lango dydžio šaltiniai ir clamp'ai (1218)", () => {
  assert.equal(stopBridgeWaitMs({}), STOP_BRIDGE_WAIT_MS);
  assert.equal(stopBridgeWaitMs({ AG_DISPATCH_STOP_WAIT_MS: "0" }), 0, "eksplicitinis opt-out");
  assert.equal(stopBridgeWaitMs({ AG_STOP_BRIDGE_WAIT_MS: "120000" }), 120_000, "legacy raktas gyvas");
  assert.equal(stopBridgeWaitMs({ AG_DISPATCH_STOP_WAIT_MS: "-5" }), STOP_BRIDGE_WAIT_MS, "klaida → default");
  assert.equal(stopBridgeWaitMs({ AG_DISPATCH_STOP_WAIT_MS: "999999999" }), MAX_STOP_BRIDGE_WAIT_MS);
  assert.equal(stopBridgeWaitMs({}, 999_999_999), MAX_STOP_BRIDGE_WAIT_MS, "override clamp'inamas ta pačia riba");
  assert.equal(stopBridgeWaitMs({}, 1), STOP_BRIDGE_WAIT_POLL_MS, "apatinis kraštas — vienas poll");
  assert.equal(stopBridgeWaitMs({}, 0), 0);
});

test("stop-bridge-wait: šaltinių merge prioritetai ir laukimo kilpa su lipniu foreign-done", async () => {
  assert.deepEqual(mergeStopBridgeSources('{"status":"done","dispatch_nonce":"n1"}', "", "n1"), {
    classification: "own-done",
    source: "attempt",
  });
  assert.deepEqual(mergeStopBridgeSources(undefined, '{"status":"done","dispatch_nonce":"n1"}', "n1"), {
    classification: "own-done",
    source: "global",
  });
  assert.deepEqual(mergeStopBridgeSources('{"status":"done","dispatch_nonce":"x"}', "ne json", "n1"), {
    classification: "foreign-done",
    source: "attempt",
  });

  // own-done trečiame poll'e; laikas — fake.
  let clock = 0;
  const probes: StopBridgeProbeResult[] = [
    { classification: "none", source: "none" },
    { classification: "foreign-done", source: "global" },
    { classification: "own-done", source: "attempt" },
  ];
  let probeIndex = 0;
  const outcome = await waitForOwnStopBridgeDone({
    probe: async () => probes[Math.min(probeIndex++, probes.length - 1)]!,
    timeoutMs: 10_000,
    pollMs: 1_000,
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
  });
  assert.equal(outcome.classification, "own-done");
  assert.equal(outcome.polls, 3);

  // foreign-done lipnus: vėlesnis none jo nenutrina; timeout baigia su foreign.
  clock = 0;
  probeIndex = 0;
  const sticky = await waitForOwnStopBridgeDone({
    probe: async () =>
      [
        { classification: "foreign-done", source: "global" } as StopBridgeProbeResult,
        { classification: "none", source: "none" } as StopBridgeProbeResult,
      ][Math.min(probeIndex++, 1)]!,
    timeoutMs: 3_000,
    pollMs: 1_000,
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
  });
  assert.equal(sticky.classification, "foreign-done");

  // timeoutMs=0 → lygiai vienas probe be sleep; NaN sanitizuojamas; sustojęs laikrodis
  // nepadaro kilpos begalinės (maxPolls stabdis).
  let probeCount = 0;
  const zero = await waitForOwnStopBridgeDone({
    probe: async () => {
      probeCount += 1;
      return { classification: "none", source: "none" };
    },
    timeoutMs: 0,
    pollMs: 1_000,
    sleep: async () => {},
    now: () => 0,
  });
  assert.equal(zero.polls, 1);
  assert.equal(probeCount, 1);

  probeCount = 0;
  const frozen = await waitForOwnStopBridgeDone({
    probe: async () => {
      probeCount += 1;
      return { classification: "none", source: "none" };
    },
    timeoutMs: 5_000,
    pollMs: 1_000,
    sleep: async () => {},
    now: () => 0,
  });
  assert.ok(frozen.polls <= 7, "maxPolls stabdis suveikia su sustojusiu laikrodžiu");
  assert.equal(probeCount, frozen.polls);

  assert.equal(
    shouldWaitForOwnStopBridge({ exitCode: 0, usage: undefined, usageLimitHit: false, observed: "foreign-done" }),
    true,
  );
  assert.equal(
    shouldWaitForOwnStopBridge({ exitCode: 0, usage: undefined, usageLimitHit: false, observed: "own-done" }),
    false,
  );
  assert.equal(
    shouldWaitForOwnStopBridge({ exitCode: 0, usage: undefined, usageLimitHit: true, observed: "none" }),
    false,
  );
});

test("dispatch-execution-record: minimalus įrašas be optional raktų, pilnas su sha ir off-režimo praleidimu", () => {
  const minimal = buildDispatchExecutionRecord({
    status: "refused",
    phase: "implementation",
    taskFile: "AG/tasks/queue/0042.md",
    sourceChange: true,
    selectedModel: "sonnet",
    failedAttempts: 0,
    attempt: 1,
    startedAt: "2026-08-20T12:00:00.000Z",
    contextGate: { kind: "refuse", reason: "missing artifact" },
    reason: "gate refused",
  });
  assert.equal(minimal.schema, 1);
  assert.ok(!("prompt_chars" in minimal));
  assert.ok(!("tool_schema" in minimal));
  assert.ok(!("routing_tier" in minimal));
  assert.equal(minimal.context_gate.reason, "missing artifact");

  const attachGate = { kind: "attach", executionContext: "SLAPTAS KONTEKSTAS" } as { kind: string; reason?: string };
  const full = buildDispatchExecutionRecord({
    status: "started",
    phase: "repair",
    taskFile: "vq/state/repair/0042.md",
    sourceChange: false,
    selectedModel: "sonnet",
    failedAttempts: 1,
    attempt: 2,
    startedAt: "2026-08-20T12:00:00.000Z",
    contextGate: attachGate,
    routing: { baseTier: "standard", tier: "advanced", reason: "retry", policyHash: "rt1:abc", model: "claude-x" },
    prompt: "PROMPT BODY",
    workerPrompt: { mode: "raw", taskSha256: "a".repeat(64), rawChars: 10 },
    maxTurns: 30,
    delivery: { platform: "windows", transport: "prompt-file" },
    toolSchema: { mode: "off", candidates: [], applied: [], reason: "disabled" },
    usage: { input_tokens: 5 },
    midDispatchBudget: { billable_tokens: 9, raw_tokens: 12, limit: 8, limitSource: "dispatch-ceiling" },
  });
  assert.equal(full.prompt_chars, "PROMPT BODY".length);
  assert.equal(full.prompt_sha256, contextArtifactSha256("PROMPT BODY"));
  assert.equal(full.model, "claude-x");
  assert.ok(!("tool_schema" in full), "off režimas įraše nepalieka lauko");
  assert.ok(!JSON.stringify(full).includes("SLAPTAS KONTEKSTAS"), "execution context tekstas į artefaktą nepatenka");
  assert.deepEqual(full.mid_dispatch_budget, { billable_tokens: 9, raw_tokens: 12, limit: 8, limitSource: "dispatch-ceiling" });
});

test("compression-arrest-observer: neperskaitomas markeris ir nepakitusi būsena nerašo nieko", async () => {
  const writes: string[] = [];
  const unreadable = fakeContextPackFs({
    readTextFileIfExists: async () => "ne json",
    writeTextFile: async (p) => {
      writes.push(p);
    },
  });
  assert.deepEqual(
    await observeContextCompressionArrest(unreadable, "/repo/vq", {
      taskId: "0042",
      canaryFeatures: [],
      humanReviewTaskIds: [],
      now: new Date("2026-08-20T12:00:00.000Z"),
    }),
    [],
  );
  assert.equal(writes.length, 0, "neperskaitomas markeris NIEKADA neperrašomas");

  const clean = fakeContextPackFs({
    writeTextFile: async (p) => {
      writes.push(p);
    },
  });
  assert.deepEqual(
    await observeContextCompressionArrest(clean, "/repo/vq", {
      taskId: "0042",
      canaryFeatures: [],
      humanReviewTaskIds: [],
      now: new Date("2026-08-20T12:00:00.000Z"),
    }),
    [],
  );
  assert.equal(writes.length, 0, "nepakitusi būsena — jokio įrašo");
});

test("mid-dispatch watchdog: verdiktas vieną kartą, meter maitinamas toliau, blind notice", () => {
  let aborted = 0;
  const watchdog = createMidDispatchBudgetWatchdog({
    limit: 40_000,
    limitSource: "dispatch-ceiling",
    onExceeded: () => {
      aborted += 1;
    },
  });

  const line = (id: string, input: number): string =>
    `${JSON.stringify({ type: "assistant", message: { id, usage: { input_tokens: input, output_tokens: 10 } } })}\n`;

  assert.equal(watchdog.observe(line("m1", 10_000)), undefined, "po pirmos žinutės riba nepasiekta");
  assert.equal(watchdog.billableSeen(), true);
  const verdict = watchdog.observe(line("m2", 60_000));
  assert.ok(verdict, "riba peržengta — verdiktas");
  assert.equal(verdict?.limitSource, "dispatch-ceiling");
  assert.ok(verdict.billableTokens > 40_000);
  assert.equal(aborted, 1);
  assert.equal(watchdog.observe(line("m3", 5_000)), undefined, "verdiktas latch'intas, bet meter'is maitinamas");
  assert.equal(watchdog.hit(), verdict);
  assert.ok(watchdog.totals().total_tokens >= 70_000, "trečios žinutės usage įskaitytas į įrodymą");
  assert.equal(billableTokensOfStream(watchdog.totals()) > 0, true);

  const blind = billableMeterBlindNotice({
    taskId: "0042",
    billableSeen: false,
    elapsedMs: 60_000,
    timeoutMs: 100_000,
    totals: watchdog.totals(),
  });
  assert.match(blind ?? "", /DISPATCH BILLABLE METER BLIND: task=0042/);
  assert.equal(
    billableMeterBlindNotice({ taskId: "0042", billableSeen: true, elapsedMs: 60_000, timeoutMs: 100_000, totals: watchdog.totals() }),
    undefined,
  );
  assert.equal(
    billableMeterBlindNotice({ taskId: "0042", billableSeen: false, elapsedMs: 10_000, timeoutMs: 100_000, totals: watchdog.totals() }),
    undefined,
    "trumpa no-op sesija nėra aklumas",
  );
});

test("worker-prompt-preparation: default konfigas → raw įrašas be fallback; sugadintas konfigas → fallback log", async () => {
  const RAW_TASK = "# Task\n\n## Tikslas\nX.\n";
  const logs: string[] = [];
  const deps = {
    fs: fakeContextPackFs(),
    clock: { timestamp: () => "2026-08-20T12:00:00.000Z" },
    runtimeRoot: "/repo/vq",
    readTaskEvents: async () => [],
  };
  const result = await prepareWorkerPromptTask(
    { taskId: "0042", rawTaskText: RAW_TASK, logDispatch: async (line) => void logs.push(line) },
    deps,
  );
  assert.equal(result.workerPromptRecord.mode, "raw");
  assert.equal(result.workerPromptRecord.taskSha256, contextArtifactSha256(RAW_TASK));
  assert.equal(result.workerPromptRecord.rawChars, RAW_TASK.length);
  assert.equal(result.compiledTask, undefined);
  assert.ok(result.compressionConfig, "default konfigas vis tiek grąžinamas");
  assert.deepEqual(logs, [], "default kelias tylus");

  const brokenLogs: string[] = [];
  const broken = await prepareWorkerPromptTask(
    { taskId: "0042", rawTaskText: RAW_TASK, logDispatch: async (line) => void brokenLogs.push(line) },
    {
      ...deps,
      fs: fakeContextPackFs({
        readTextFileIfExists: async (p) => (p.replace(/\\/g, "/").endsWith("context-compression.json") ? "{ blogas" : undefined),
      }),
    },
  );
  assert.equal(broken.compressionConfig, undefined, "konfigo krovimo klaida — be politikos");
  assert.match(broken.workerPromptRecord.compressionFallback ?? "", /raw/);
  assert.ok(brokenLogs.some((line) => line.startsWith("DISPATCH COMPRESSION FALLBACK: task=0042")));
});
