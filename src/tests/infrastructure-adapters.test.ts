// VQ-404 (1/2) testai: Claude headless klasteris (decision/usage/stream meter/tool
// schema) ir ExecutionAdapter implementacijos su fake runner'iais + adapter runtime
// prielaidų vartai realioje FS.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { nodeFsAdapter } from "../infrastructure/fs/node-fs-adapter.js";
import { extractDecisionJson } from "../infrastructure/adapters/claude-decision.js";
import {
  createStreamJsonUsageMeter,
  extractUsage,
  extractUsageFromStreamJsonLog,
  isUsageLimitEnvelope,
  isUsageLimitOutput,
  usageFromStreamTotals,
} from "../infrastructure/adapters/claude-usage.js";
import {
  buildDispatchDisallowedTools,
  classifyDispatchWriteOutcome,
  claudeDispatchDisallowedToolsArgs,
  claudeMaxTurnsArgs,
  dispatchDisallowedToolCandidates,
  extractDispatchToolUsage,
  hasDispatchToolEvidence,
  isUnknownFlagFailure,
} from "../infrastructure/adapters/claude-tool-schema.js";
import {
  AdapterRuntime,
  createExecutionAdapter,
  ClaudeAdapter,
  CodexAdapter,
  createExecutionAdapterIntegrationReviewer,
  normalizeAdapterProcessResult,
  resolveAdapterRuntimeConfig,
  validateAdapterPrerequisites,
} from "../infrastructure/adapters/index.js";
import type { ExecutionAdapter } from "../domain/agents/execution-port.js";

const root = await mkdtemp(path.join(tmpdir(), "vq-adapt-"));
after(async () => {
  await rm(root, { recursive: true, force: true });
});

test("extractDecisionJson: grynas JSON, fenced blokas, įterptas objektas, šiukšlės — tuščias sprendimas", () => {
  assert.deepEqual(extractDecisionJson('{"verdict":"retry"}'), { verdict: "retry" });
  assert.deepEqual(extractDecisionJson('Paaiškinimas\n```json\n{"selected_model":"sonnet"}\n```'), {
    selected_model: "sonnet",
  });
  assert.deepEqual(extractDecisionJson('tekstas {"verdict":"done"} uodega'), { verdict: "done" });
  assert.deepEqual(extractDecisionJson("jokio json"), {});
});

test("usage ekstrakcija: json envelope, stream-json result ir 429 klasifikacija", () => {
  const envelope = JSON.stringify({
    usage: { input_tokens: 10, output_tokens: 5 },
    total_cost_usd: 0.2,
    num_turns: 7,
  });
  assert.deepEqual(extractUsage(envelope), {
    input_tokens: 10,
    output_tokens: 5,
    total_cost_usd: 0.2,
    num_turns: 7,
  });
  assert.equal(extractUsage("ne json"), undefined);

  const log = ['{"type":"system"}', '{"type":"result","usage":{"input_tokens":3,"output_tokens":4}}'].join("\n");
  assert.deepEqual(extractUsageFromStreamJsonLog(log), { input_tokens: 3, output_tokens: 4 });

  assert.equal(isUsageLimitOutput('{"api_error_status":429}'), true);
  assert.equal(isUsageLimitOutput("Claude session limit reached"), true);
  // Sėkmingo atsakymo TURINYS apie rate limiting nėra API limitas.
  assert.equal(isUsageLimitEnvelope({ is_error: false, result: "implemented login rate limit" }), false);
  assert.equal(isUsageLimitEnvelope({ is_error: true, result: "usage limit reached" }), true);
});

test("stream meter: max per id, idless idempotencija, delta-only srautas matomas, result laimi kai didžiausias", () => {
  const meter = createStreamJsonUsageMeter();
  // Ta pati žinutė streaming + galutinis įvykis: per lauką max, ne suma.
  meter.push('{"type":"assistant","message":{"id":"m1","usage":{"input_tokens":10,"output_tokens":1}}}\n');
  meter.push('{"type":"assistant","message":{"id":"m1","usage":{"input_tokens":10,"output_tokens":6}}}\n');
  meter.push('{"type":"assistant","message":{"id":"m2","usage":{"input_tokens":4,"output_tokens":2}}}\n');
  let totals = meter.totals();
  assert.equal(totals.total_tokens, 10 + 6 + 4 + 2);
  assert.equal(totals.messages, 2);

  // Gabalas, nutrūkęs vidury eilutės, suklijuojamas.
  const line = '{"type":"result","usage":{"input_tokens":100,"output_tokens":50}}';
  meter.push(line.slice(0, 10));
  meter.push(`${line.slice(10)}\n`);
  totals = meter.totals();
  assert.equal(totals.result_seen, true);
  assert.equal(totals.total_tokens, 150);

  // Delta-only srautas: skaičiuojasi viena žinute, usage matomas stabdikliui.
  const deltaMeter = createStreamJsonUsageMeter();
  deltaMeter.push('{"type":"message_delta","usage":{"output_tokens":9}}\n');
  deltaMeter.push('{"type":"stream_event","event":{"type":"message_delta","usage":{"output_tokens":12}}}\n');
  const deltaTotals = deltaMeter.totals();
  assert.equal(deltaTotals.messages, 1);
  assert.equal(deltaTotals.total_tokens, 12);
  assert.deepEqual(usageFromStreamTotals(deltaTotals), {
    input_tokens: 0,
    output_tokens: 12,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  });
  assert.equal(usageFromStreamTotals(createStreamJsonUsageMeter().totals()), undefined);
});

test("dispatch tool auditas: kohortos, id dedup, grindys ir unknown-flag fallback", () => {
  const log = [
    '{"type":"system","subtype":"init","tools":["Read","Bash","WebFetch","Task"]}',
    '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"Read"},{"type":"tool_use","id":"t1","name":"Read"}]}}',
    '{"type":"assistant","parent_tool_use_id":"p1","message":{"content":[{"type":"tool_use","id":"t2","name":"Grep"}]}}',
    '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t3","name":"WebFetch"}]}}',
    "{sugadinta",
  ].join("\n");
  const usage = extractDispatchToolUsage(log);
  assert.equal(usage.parsed, true);
  assert.equal(usage.events, 3);
  assert.equal(usage.unknownEvents, 1);
  assert.deepEqual(usage.mainUsed, ["Read", "WebFetch"]);
  assert.deepEqual(usage.agentUsed, ["Grep"]);
  assert.equal(hasDispatchToolEvidence(usage), true);
  assert.equal(hasDispatchToolEvidence(extractDispatchToolUsage("jokio json")), false);

  const candidates = dispatchDisallowedToolCandidates(
    { browser: false, scraper: false, mcp: false },
    { known: true, tools: ["mcp__browser__click", "vidinis"] },
  );
  assert.deepEqual(candidates, ["WebFetch", "WebSearch", "mcp__browser__click"]);
  // Grindys: baseline + apsaugoti agentų maršrutizavimo įrankiai niekada nešalinami;
  // vardas su kableliu atmetamas (CLI sąrašo injekcija).
  assert.deepEqual(
    buildDispatchDisallowedTools({ candidates: [...candidates, "Read", "Task", "bloga,injekcija"], protectedTools: ["Task"] }),
    ["WebFetch", "WebSearch", "mcp__browser__click"],
  );
  assert.deepEqual(claudeDispatchDisallowedToolsArgs([]), []);
  assert.deepEqual(claudeMaxTurnsArgs(2.5), []);
  assert.deepEqual(claudeMaxTurnsArgs(30), ["--max-turns", "30"]);

  assert.equal(isUnknownFlagFailure({ code: 2, stderr: "error: unknown option --disallowed-tools", stdout: "" }), true);
  assert.equal(isUnknownFlagFailure({ code: 1, stderr: "model refused", stdout: "" }), false);
});

test("classifyDispatchWriteOutcome: rašė, nerašė, nežinoma", () => {
  const wroteLog = [
    '{"type":"system","subtype":"init","tools":["Read","Write"]}',
    '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"w1","name":"Write"}]}}',
  ].join("\n");
  assert.equal(classifyDispatchWriteOutcome(extractDispatchToolUsage(wroteLog)), "wrote");

  const readOnlyLog = [
    '{"type":"system","subtype":"init","tools":["Read","Grep"]}',
    '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"r1","name":"Read"}]}}',
    '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"r2","name":"Grep"}]}}',
  ].join("\n");
  assert.equal(classifyDispatchWriteOutcome(extractDispatchToolUsage(readOnlyLog)), "no-writes");

  assert.equal(classifyDispatchWriteOutcome(extractDispatchToolUsage("jokio json")), "unknown");
  assert.equal(classifyDispatchWriteOutcome(extractDispatchToolUsage("")), "unknown");
});

test("adapteriai: dry-run completed, neįjungti claude/codex — not_implemented, fake runner — completed", async () => {
  const dry = await createExecutionAdapter("dry-run").execute({ taskId: "t1" });
  assert.equal(dry.status, "completed");

  const disabled = await createExecutionAdapter("claude").execute({ taskId: "t1", contextPack: {}, model: "sonnet" });
  assert.equal(disabled.status, "not_implemented");

  const noModel = await new ClaudeAdapter({ enabled: true }).execute({ taskId: "t1", contextPack: {} });
  assert.equal(noModel.status, "failed");
  assert.equal(noModel.reason, "claude_model_missing");

  const seen: { command: string; args: string[]; input: string }[] = [];
  const claude = new ClaudeAdapter({
    enabled: true,
    runner: async (command, args, input) => {
      seen.push({ command, args, input });
      return { code: 0, stdout: '{"result":"ok"}', stderr: "" };
    },
  });
  const completed = await claude.execute({ taskId: "t1", contextPack: { x: 1 }, model: "sonnet" });
  assert.equal(completed.status, "completed");
  assert.deepEqual(completed.structuredOutput, { result: "ok" });
  assert.deepEqual(seen[0]?.args, ["-p", "--output-format", "json", "--model", "sonnet"]);
  assert.equal(seen[0]?.input, '{"x":1}');

  const codex = new CodexAdapter({
    enabled: true,
    runner: async (_command, args) => {
      assert.deepEqual(args.slice(0, 3), ["exec", "--sandbox", "workspace-write"]);
      return { code: 124, stdout: "", stderr: "" };
    },
  });
  const timedOut = await codex.execute({ taskId: "t1", contextPack: {} });
  assert.equal(timedOut.status, "timed_out");
  assert.equal(timedOut.reason, "codex_timeout");
});

test("adapter runtime: prielaidų vartai (context-pack + budget_enforcement.ok) ir normalizacija", async () => {
  assert.throws(() => resolveAdapterRuntimeConfig({ timeoutMs: 0 }), /positive integer/);

  await nodeFsAdapter.makeDirectory(path.join(root, "darbo"));
  await assert.rejects(
    () => validateAdapterPrerequisites(root, path.join(root, "darbo")),
    /context-pack is missing/,
  );
  await nodeFsAdapter.writeTextFile(path.join(root, "vq", "supervisor", "context-pack.json"), '{"pack":1}');
  await nodeFsAdapter.writeTextFile(
    path.join(root, "vq", "state", "token-budget-status.json"),
    JSON.stringify({ budget_enforcement: { ok: true } }),
  );
  const prerequisites = await validateAdapterPrerequisites(root, path.join(root, "darbo"));
  assert.deepEqual(prerequisites.contextPack, { pack: 1 });

  await assert.rejects(() => validateAdapterPrerequisites(root, path.dirname(root)), /inside project root/);

  const runtime = new AdapterRuntime(root, { maxOutputBytes: 4 });
  const normalized = runtime.normalize("claude", { code: 0, stdout: "ilga išvestis", stderr: "" }, "claude_completed");
  assert.equal(normalized.status, "completed");
  assert.ok(Buffer.byteLength(normalized.stdout, "utf8") <= 4);
  assert.equal(normalizeAdapterProcessResult("codex", { code: 124, stdout: "", stderr: "" }, "x").status, "timed_out");
});

test("ClaudeAdapter + runtime: ilgas validus JSON su mažu maxOutputBytes vis tiek parsinamas (F14)", async () => {
  const smallOutputRuntime = new AdapterRuntime(root, { maxOutputBytes: 8 });
  const longPayload = "x".repeat(2000);
  const longJson = JSON.stringify({ result: "ok", padding: longPayload });
  const cwd = path.join(root, "darbo");

  const claude = new ClaudeAdapter({
    enabled: true,
    runtime: smallOutputRuntime,
    // Fake runner'is išvesties NEAPKIRPO (`stdoutTruncated` neteikiama) — apkirpimą daro
    // TIK `AdapterRuntime.normalize` per mažą `maxOutputBytes`. structuredOutput turi eiti
    // iš pilno, neapkirpto stdout.
    runner: async () => ({ code: 0, stdout: longJson, stderr: "" }),
  });
  const completed = await claude.execute({ taskId: "t1", contextPack: { x: 1 }, model: "sonnet", cwd });
  assert.equal(completed.status, "completed");
  assert.ok(Buffer.byteLength(completed.stdout, "utf8") <= 8, "grąžintas stdout laiko runtime apkirpimą");
  assert.deepEqual(completed.structuredOutput, { result: "ok", padding: longPayload });
});

test("ClaudeAdapter + runtime: runner'io apkirptas stdout — structuredOutput neteikiamas, reason su sufiksu (F14)", async () => {
  const runtime = new AdapterRuntime(root, { maxOutputBytes: 1024 });
  const cwd = path.join(root, "darbo");

  const claude = new ClaudeAdapter({
    enabled: true,
    runtime,
    runner: async () => ({ code: 0, stdout: '{"result":"ok"', stderr: "", stdoutTruncated: true }),
  });
  const completed = await claude.execute({ taskId: "t1", contextPack: { x: 1 }, model: "sonnet", cwd });
  assert.equal(completed.status, "completed");
  assert.equal(completed.structuredOutput, undefined);
  assert.equal(completed.reason, "claude_completed_claude_output_truncated");
});

test("integration reviewer tiltas: nepavykęs kvietimas NIEKADA nėra patvirtinimas", async () => {
  const failing: ExecutionAdapter = {
    kind: "claude",
    execute: async () => ({
      adapter: "claude",
      status: "failed",
      exitCode: 1,
      stdout: "",
      stderr: "boom",
      reason: "claude_exit_1",
    }),
  };
  const reviewer = createExecutionAdapterIntegrationReviewer(failing, { model: "sonnet" });
  const response = await reviewer.review({
    taskId: "t1",
    waveId: "w1",
    prompt: "review",
    risk: {
      version: 1,
      level: "review-required",
      semantic_review_allowed: true,
      human_review_required: false,
      signals: [],
      reasons: [],
      focus: { contracts: [], paths: [], modules: [], failing_gates: [], conflicts: [] },
      verdict_hash: "test",
    },
  });
  assert.equal(response.verdict, "escalate");
  assert.match(response.summary, /returned failed/);
  assert.equal(response.model, "sonnet");
});
