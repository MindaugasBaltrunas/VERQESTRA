// VQ-404 (2/2) testai — realus IntegrationPort (IVER-3 pilnoji pusė): reviewer per fake
// headless CLI (jokio proceso), biudžeto vartų wrapper'is su fail-closed elgesiu, usage
// apskaita per logTokenUsage, repair prompt saugykla ir realūs TokenBudgetGatePorts failai.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { INTEGRATION_REVIEW_PHASE, type IntegrationReviewerRequest } from "../application/integration/review-integration.js";
import type { IntegrationRiskVerdict } from "../application/integration/evaluate-integration-risk.js";
import { llmCallResetsPath, tokenBudgetStatusPath } from "../application/token-governance/tool-budget-gates.js";
import { nodeFsAdapter } from "../infrastructure/fs/node-fs-adapter.js";
import {
  DEFAULT_INTEGRATION_REVIEW_TIER,
  createIntegrationReviewPort,
} from "../infrastructure/adapters/integration-review-adapter.js";
import { createTokenBudgetGatePorts } from "../infrastructure/state/token-budget-gate-ports.js";
import {
  readTaskRepairPrompt,
  removeTaskRepairPrompt,
  taskRepairPath,
  writeTaskRepairPrompt,
} from "../infrastructure/state/task-repair-store.js";
import { tokenUsageLogPath } from "../infrastructure/state/token-usage-log.js";

const projectRoot = await mkdtemp(path.join(tmpdir(), "vq-ireview-"));
const runtimeRoot = path.join(projectRoot, "vq");
after(async () => {
  await rm(projectRoot, { recursive: true, force: true });
});

const RISK: IntegrationRiskVerdict = {
  version: 1,
  level: "review-required",
  semantic_review_allowed: true,
  human_review_required: false,
  signals: [],
  reasons: [],
  focus: { contracts: [], paths: [], modules: [], failing_gates: [], conflicts: [] },
  verdict_hash: "h1",
};

const REQUEST: IntegrationReviewerRequest = { taskId: "t1", waveId: "w1", prompt: "PROMPT", risk: RISK };

type HeadlessResult = { stdout: string; stderr: string; code: number };

function envelope(result: unknown, usage?: Record<string, number>): string {
  return JSON.stringify({
    is_error: false,
    result: typeof result === "string" ? result : JSON.stringify(result),
    ...(usage === undefined ? {} : { usage }),
  });
}

test("reviewer: sėkmingas kvietimas — verdiktas iš atsakymo, apskaitos model = kviesta pakopa, usage prisegamas", async () => {
  const seenCalls: Array<{ prompt: string; model: string; stateDir: string }> = [];
  const port = createIntegrationReviewPort({
    runtimeRoot,
    runHeadless: async (prompt, model, stateDir): Promise<HeadlessResult> => {
      seenCalls.push({ prompt, model, stateDir });
      return {
        stdout: envelope({ verdict: "approve", summary: "kontraktai suderinami", findings: [] }, { input_tokens: 11, output_tokens: 7 }),
        stderr: "",
        code: 0,
      };
    },
  });

  const response = await port.reviewer!.review(REQUEST);
  assert.equal(response.verdict, "approve");
  assert.equal(response.summary, "kontraktai suderinami");
  // Apskaitai rašoma pakopa, ne provider ID iš atsakymo.
  assert.equal(response.model, DEFAULT_INTEGRATION_REVIEW_TIER);
  assert.deepEqual(response.usage, { input_tokens: 11, output_tokens: 7 });
  // Į paleidiklį keliauja TIK request.prompt; modelis — realus provider ID iš models.env.
  assert.equal(seenCalls.length, 1);
  assert.equal(seenCalls[0]!.prompt, "PROMPT");
  assert.equal(seenCalls[0]!.model, "claude-sonnet-5");
  assert.equal(seenCalls[0]!.stateDir, path.join(runtimeRoot, "state"));
});

test("reviewer: 429 ir ne-nulinis exit — escalate su atgautu usage, niekada ne approve", async () => {
  const limited = createIntegrationReviewPort({
    runtimeRoot,
    runHeadless: async (): Promise<HeadlessResult> => ({
      stdout: JSON.stringify({ is_error: true, api_error_status: 429, result: "usage limit reached", usage: { input_tokens: 3 } }),
      stderr: "",
      code: 0,
    }),
  });
  const limitedResponse = await limited.reviewer!.review(REQUEST);
  assert.equal(limitedResponse.verdict, "escalate");
  assert.match(limitedResponse.summary, /usage limit/);
  assert.deepEqual(limitedResponse.usage, { input_tokens: 3 });

  const failed = createIntegrationReviewPort({
    runtimeRoot,
    runHeadless: async (): Promise<HeadlessResult> => ({ stdout: "", stderr: "boom\nantra eilutė", code: 2 }),
  });
  const failedResponse = await failed.reviewer!.review(REQUEST);
  assert.equal(failedResponse.verdict, "escalate");
  // Santrauka — viena eilutė (naujos eilutės išlygintos).
  assert.match(failedResponse.summary, /exited 2: boom antra eilutė/);

  const garbage = createIntegrationReviewPort({
    runtimeRoot,
    runHeadless: async (): Promise<HeadlessResult> => ({ stdout: envelope("cia ne json verdikta s"), stderr: "", code: 0 }),
  });
  const garbageResponse = await garbage.reviewer!.review(REQUEST);
  assert.equal(garbageResponse.verdict, "escalate");
});

test("budget: authorizeLlmCall wrapper'is; sugriuvęs vertinimas — allowed:false (fail-closed)", async () => {
  const port = createIntegrationReviewPort({
    runtimeRoot,
    runHeadless: async (): Promise<HeadlessResult> => ({ stdout: envelope({ verdict: "approve", summary: "", findings: [] }), stderr: "", code: 0 }),
  });
  // Be jokio konfigo galioja failsafe rezervai — kvietimas leidžiamas.
  const allowed = await port.budget!.authorize({ taskId: "t1", phase: INTEGRATION_REVIEW_PHASE });
  assert.equal(allowed.allowed, true);
  assert.deepEqual(allowed.reasons, []);
  // Vartų sprendimo veidrodis parašytas.
  const mirror = JSON.parse((await nodeFsAdapter.readTextFileIfExists(tokenBudgetStatusPath(runtimeRoot)))!) as Record<string, unknown>;
  assert.ok(mirror["llm_call_authorization"]);

  const broken = createIntegrationReviewPort({
    runtimeRoot,
    authorize: async () => {
      throw new Error("ledger unreadable");
    },
  });
  const rejected = await broken.budget!.authorize({ taskId: "t1", phase: INTEGRATION_REVIEW_PHASE });
  assert.equal(rejected.allowed, false);
  assert.match(rejected.reasons.join("; "), /budget could not be evaluated: ledger unreadable/);
});

test("usage.record: įrašas su integration-review faze patenka į token-usage.jsonl; repair prompt — į vq/state/repair", async () => {
  const port = createIntegrationReviewPort({ runtimeRoot });
  await port.usage!.record({
    taskId: "t1",
    phase: INTEGRATION_REVIEW_PHASE,
    model: "sonnet",
    usage: { input_tokens: 5, output_tokens: 2 },
    outcome: "succeeded",
  });
  const logRaw = (await nodeFsAdapter.readTextFileIfExists(tokenUsageLogPath(runtimeRoot)))!;
  const record = JSON.parse(logRaw.trim().split("\n").at(-1)!) as Record<string, unknown>;
  assert.equal(record["phase"], INTEGRATION_REVIEW_PHASE);
  assert.equal(record["task_id"], "t1");
  assert.equal(record["model"], "sonnet");
  assert.equal(record["outcome"], "succeeded");
  assert.equal(record["input_tokens"], 5);

  await port.writeRepairPrompt!("t1", "# Repair Task\n\nturinys\n");
  assert.equal(await readTaskRepairPrompt(runtimeRoot, "t1"), "# Repair Task\n\nturinys\n");
  assert.equal(taskRepairPath(runtimeRoot, "t1"), path.join(runtimeRoot, "state", "repair", "t1.md"));
});

test("task-repair-store: id validacija, trūkstamas failas — tuščia eilutė, remove idempotentiškas", async () => {
  assert.throws(() => taskRepairPath(runtimeRoot, "../pabegimas"), /Invalid repair task id/);
  assert.throws(() => taskRepairPath(runtimeRoot, ".."), /Invalid repair task id/);
  assert.equal(await readTaskRepairPrompt(runtimeRoot, "nesamas"), "");
  const written = await writeTaskRepairPrompt(runtimeRoot, "t9", "body\n");
  assert.equal(written, taskRepairPath(runtimeRoot, "t9"));
  await removeTaskRepairPrompt(runtimeRoot, "t9");
  await removeTaskRepairPrompt(runtimeRoot, "t9");
  assert.equal(await readTaskRepairPrompt(runtimeRoot, "t9"), "");
});

test("token-budget-gate-ports: resets round-trip, status merge pagal raktą, tolerantiškas skaitymas", async () => {
  const ports = createTokenBudgetGatePorts(runtimeRoot);
  assert.deepEqual(await ports.readLlmCallResets(), {});
  await ports.writeLlmCallResets({ t1: "2026-08-20T10:00:00.000Z" });
  assert.deepEqual(await ports.readLlmCallResets(), { t1: "2026-08-20T10:00:00.000Z" });

  await ports.writeBudgetStatus("pirmas", { ok: true });
  await ports.writeBudgetStatus("antras", { ok: false });
  const status = JSON.parse((await nodeFsAdapter.readTextFileIfExists(tokenBudgetStatusPath(runtimeRoot)))!) as Record<string, unknown>;
  // Merge: ankstesni raktai (ir llm_call_authorization iš budget testo) neužtrinami.
  assert.deepEqual(status["pirmas"], { ok: true });
  assert.deepEqual(status["antras"], { ok: false });
  assert.ok(status["llm_call_authorization"]);

  // Sugadintas resets failas — {}, ne metimas.
  await nodeFsAdapter.writeTextFile(llmCallResetsPath(runtimeRoot), "ne json");
  assert.deepEqual(await ports.readLlmCallResets(), {});
  assert.ok(ports.nowIso().includes("T"));
});
