// Task 160 testai: preflight'o LLM modelis yra FIKSUOTA konstanta (`PREFLIGHT_LLM_TIER`), o
// `optimizedBudget.model_policy_hint` lieka TIK užuomina vykdytojui. Modelių auditas
// 2026-09-03 (R4): 85 iš 125 preflight'ų sukosi opus'e (≈ 47 $), nors 90 % jų verdiktas buvo
// „vykdyk sonnet'u". Atskiras failas — `interfaces-cli-preflight.test.ts` yra prie 500 eilučių
// gate'o ribos.

import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import type { LlmCallAuthorization } from "../application/token-governance/tool-budget-gates.js";
import type { AgentPolicy } from "../domain/policies/agent-selection.js";
import { claudePreflight } from "../interfaces/cli/dispatch/claude-preflight/index.js";
import { PREFLIGHT_LLM_TIER } from "../interfaces/cli/dispatch/claude-preflight/preflight-llm.js";
import type { ClaudePreflightPorts, PreflightDecision, PreflightLlmResult } from "../interfaces/cli/dispatch/claude-preflight/preflight-ports.js";

const ROOT = path.resolve("/repo");
const TASK_FILE = path.join(ROOT, "AG", "tasks", "queue", "0160-demo.md");

/**
 * Opus hint'as gaunamas per klasifikaciją: „architecture" raktažodis → `architecture`
 * kategorija (sensitivity high, modelPolicyHint opus). Rizikos vartai jos neliečia, tad
 * task'as pasiekia modelio pasirinkimą.
 */
const OPUS_HINT_TASK = [
  "# Task",
  "",
  "## Spec source",
  "AG/openspec/changes/my-change/spec.md",
  "",
  "## Tikslas",
  "Sutvarkyti architecture ribas.",
  "",
  "## Agentai",
  "readme-guard -> coder",
  "",
  "## Failai",
  "Leidžiama:",
  "- `src/a.ts`",
  "- `src/tests/a.test.ts`",
  "",
  "## Veiksmas",
  "- Perkelti riba.",
  "",
  "## Patikra",
  "- `pnpm test`",
  "",
  "## Stop",
  "Kai žalia, sustok.",
  "",
  "## Neįtraukta",
  "- nieko",
  "",
].join("\n");

/**
 * Haiku hint'as: tik `routine` kategorija, struktūriškai mažas task'as ir JOKIOS aktyvios
 * OpenSpec change nuorodos — kitaip `preflightTier` pakiltų iki sonnet ir testas nebeskirtų
 * konstantos nuo užuominos.
 */
const HAIKU_HINT_TASK = [
  "# Task",
  "",
  "## Spec source",
  "docs/spec-workflow.md",
  "",
  "## Tikslas",
  "Perrasyti docs pastraipa.",
  "",
  "## Agentai",
  "readme-guard -> coder",
  "",
  "## Failai",
  "Leidžiama:",
  "- `docs/notes.md`",
  "",
  "## Veiksmas",
  "- Perrasyti pastraipa.",
  "",
  "## Patikra",
  "- `pnpm test`",
  "",
  "## Stop",
  "Kai žalia, sustok.",
  "",
  "## Neįtraukta",
  "- nieko",
  "",
].join("\n");

/** Nežinomas agentas grandinėje = deterministinio fast-path miss → LLM kelias. */
function withLlmPath(taskText: string): string {
  return taskText.replace("readme-guard -> coder", "readme-guard -> nezinomas");
}

function auth(): LlmCallAuthorization {
  return {
    allowed: true, task_id: "0160-demo", phase: "preflight", reduce_context: false,
    hard_reasons: [], soft_reasons: [], raw_notices: [], total_llm_calls: 1,
    total_tokens: 0, billable_tokens: 0, remaining_total_llm_calls: null,
    remaining_total_tokens: null, phase_status: [],
  };
}

const POLICY: AgentPolicy = {
  version: "1",
  default_role: "coder",
  roles: {
    "readme-guard": { allowed_adapters: ["claude"], default_model_hint: "sonnet", can_write_code: false },
    coder: { allowed_adapters: ["claude"], default_model_hint: "sonnet", can_write_code: true },
  },
};

type Harness = {
  ports: ClaudePreflightPorts;
  /** Kiekvienas `resolveModel` kvietimas — tier'as, kurio prašė preflight'as. */
  resolvedTiers: string[];
  /** Kiekvieno realaus LLM kvietimo modelio ID. */
  headlessModels: string[];
  fileDecisions: PreflightDecision[];
  usageLogs: Array<[string, string, string | undefined]>;
  agLines: string[];
};

function makeHarness(input: { taskText: string; llm?: (prompt: string) => PreflightLlmResult }): Harness {
  const resolvedTiers: string[] = [];
  const headlessModels: string[] = [];
  const fileDecisions: PreflightDecision[] = [];
  const usageLogs: Array<[string, string, string | undefined]> = [];
  const agLines: string[] = [];

  const ports: ClaudePreflightPorts = {
    projectRoot: ROOT,
    runtimeRoot: path.join(ROOT, "vq"),
    agRoot: path.join(ROOT, "AG"),
    ensureDirs: async () => {},
    resolveExistingTaskFile: async () => TASK_FILE,
    readOptionalFile: async (absolutePath) => (absolutePath === TASK_FILE ? input.taskText : ""),
    listAgentFiles: async () => ["readme-guard.md", "coder.md"],
    loadAgentPolicy: async () => POLICY,
    loadProjectProfile: async () => undefined,
    verificationCommands: async () => ({ rebuild: "pnpm build", checks: ["pnpm test"] }),
    policyFs: { readTextFileIfExists: async () => undefined },
    openSpec: {
      fs: {
        exists: async () => true,
        // `openspec/project.md` grąžinamas VISADA — be jo OpenSpec kontekstas būtų
        // "not found" ir haiku task'as parkuotųsi dar prieš modelio pasirinkimą.
        readTextFileIfExists: async (p) => {
          const normalized = p.replace(/\\/g, "/");
          if (normalized.includes("openspec/project.md")) return "# Projektas\nturinys\n";
          return normalized.includes("openspec/changes/my-change") ? "# Spec\nturinys\n" : undefined;
        },
        listSubdirectories: async () => [],
      },
      isDirectory: async (p) => p.replace(/\\/g, "/").endsWith("openspec/changes/my-change"),
    },
    authorizeLlmCall: async () => auth(),
    generateChange: async () => null,
    writeTemplateChange: async () => null,
    resolveModel: async (tier) => {
      resolvedTiers.push(tier);
      return `model-${tier}`;
    },
    modelSelectionRules: "- MODELIO TAISYKLĖS",
    runHeadless: async (prompt, model) => {
      headlessModels.push(model);
      return input.llm ? input.llm(prompt) : { stdout: "{}", stderr: "", code: 0 };
    },
    parseDecision: (stdout) => {
      try {
        return JSON.parse(stdout) as PreflightDecision;
      } catch {
        return {};
      }
    },
    isUsageLimitOutput: () => false,
    logTokenUsage: async (phase, model, stdout) => { usageLogs.push([phase, model, stdout]); },
    ensureFreshCodeIndex: async () => ({ kind: "skip" }),
    attempt: {
      writeDecision: async () => {},
      writeTask: async () => {},
      appendPreflightInput: async () => {},
    },
    files: {
      writeDecision: async (json) => { fileDecisions.push(JSON.parse(json) as PreflightDecision); },
      writeReformulated: async () => {},
      writePreflightInput: async () => {},
      writeSupervisorLog: async () => {},
      dirExists: async () => true,
    },
    recordResumeCheckpoint: async () => {},
    agLog: async (line) => { agLines.push(line); },
    stderr: () => {},
  };

  return { ports, resolvedTiers, headlessModels, fileDecisions, usageLogs, agLines };
}

function llmDecision(claudeTask: string): PreflightDecision {
  return {
    verdict: "delegate",
    task_id: "0160-demo",
    selected_model: "sonnet",
    target_agent_chain: ["coder"],
    reason: "ok",
    claude_task: claudeTask,
    child_tasks: [],
  };
}

test("PREFLIGHT_LLM_TIER yra fiksuota sonnet pakopa (task 160)", () => {
  assert.equal(PREFLIGHT_LLM_TIER, "sonnet");
});

test("claudePreflight: opus hint'as NEbeperka opus preflight'o — LLM kviečiamas sonnet'u", async () => {
  const claudeTask = OPUS_HINT_TASK.replace("readme-guard -> coder", "coder");
  const h = makeHarness({
    taskText: withLlmPath(OPUS_HINT_TASK),
    llm: () => ({ stdout: JSON.stringify(llmDecision(claudeTask)), stderr: "", code: 0 }),
  });

  assert.equal(await claudePreflight(["t"], h.ports), 0);
  assert.ok(h.agLines.some((line) => line.includes("fastpath-miss")), "LLM kelias, ne fast-path");
  assert.deepEqual(h.resolvedTiers, ["sonnet"], "modelis imamas iš konstantos, ne iš model_policy_hint");
  assert.deepEqual(h.headlessModels, ["model-sonnet"], "realus LLM kvietimas — sonnet");
  // Užuomina žurnale lieka matoma: biudžeto pakopa ir realiai kvietęs modelis — atskiri laukai.
  const budgetLine = h.agLines.find((line) => line.includes("token-budget tier=")) ?? "";
  assert.match(budgetLine, /model_hint=opus/, "hint'as toliau skelbiamas kaip užuomina");
  assert.match(budgetLine, /preflight_llm=sonnet$/, "žurnalas pasako, kas realiai kvietė");
});

test("claudePreflight: haiku hint'as taip pat kviečia sonnet'ą (konstanta nepriklauso nuo pakopos)", async () => {
  const claudeTask = HAIKU_HINT_TASK.replace("readme-guard -> coder", "coder");
  const h = makeHarness({
    taskText: withLlmPath(HAIKU_HINT_TASK),
    llm: () => ({ stdout: JSON.stringify(llmDecision(claudeTask)), stderr: "", code: 0 }),
  });

  assert.equal(await claudePreflight(["t"], h.ports), 0);
  const budgetLine = h.agLines.find((line) => line.includes("token-budget tier=")) ?? "";
  assert.match(budgetLine, /model_hint=haiku/, "be aktyvios OpenSpec change užuomina lieka haiku");
  assert.deepEqual(h.resolvedTiers, ["sonnet"]);
  assert.deepEqual(h.headlessModels, ["model-sonnet"]);
});

test("claudePreflight: token-usage `model` rodo REALIAI kvietusią pakopą, ne užuominą", async () => {
  const claudeTask = OPUS_HINT_TASK.replace("readme-guard -> coder", "coder");
  const h = makeHarness({
    taskText: withLlmPath(OPUS_HINT_TASK),
    llm: () => ({ stdout: JSON.stringify(llmDecision(claudeTask)), stderr: "", code: 0 }),
  });

  assert.equal(await claudePreflight(["t"], h.ports), 0);
  assert.equal(h.usageLogs[0]?.[0], "preflight");
  assert.equal(h.usageLogs[0]?.[1], "sonnet", "token-usage.jsonl `model` nebemeluoja apie opus preflight'ą");
});

test("claudePreflight: `selected_model` užuomina toliau seka model_policy_hint (opus hint → opus)", async () => {
  const h = makeHarness({ taskText: OPUS_HINT_TASK });

  assert.equal(await claudePreflight(["t"], h.ports), 0);
  const decision = h.fileDecisions[0]!;
  assert.equal(decision.verdict, "delegate");
  assert.equal(decision.selected_model, "opus", "vykdytojo užuomina nepakito — ją renka optimizatorius");
  assert.deepEqual(h.resolvedTiers, ["sonnet"], "net fast-path'e modelis resolvinamas iš konstantos");
  assert.deepEqual(h.headlessModels, [], "fast-path be LLM kvietimo");
  assert.deepEqual(h.usageLogs[0], ["preflight-fastpath", "none", undefined]);
});
