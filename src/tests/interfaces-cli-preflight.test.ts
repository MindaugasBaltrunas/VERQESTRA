// VQ-501 (2/5-b) testai — claude-preflight adapteris per fake ClaudePreflightPorts (jokio
// LLM, jokios FS) + application preflight-fastpath taisyklė ir spec-source pagalbininkai.

import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import {
  evaluateDeterministicPreflight,
  extractChainFromAgentaiSection,
} from "../application/quality-gates/preflight-fastpath.js";
import type { LlmCallAuthorization } from "../application/token-governance/tool-budget-gates.js";
import type { AgentPolicy } from "../domain/policies/agent-selection.js";
import { USAGE_ERROR_EXIT_CODE, USAGE_LIMIT_EXIT_CODE } from "../shared/exit-codes.js";
import { claudePreflight } from "../interfaces/cli/dispatch/claude-preflight/index.js";
import { validatePreflightDecision } from "../interfaces/cli/dispatch/claude-preflight/preflight-validate.js";
import {
  appendSpecSourceRef,
  hasValidArchitectureNodeReference,
} from "../interfaces/cli/dispatch/claude-preflight/spec-source.js";
import type {
  ClaudePreflightPorts,
  PreflightDecision,
  PreflightLlmResult,
} from "../interfaces/cli/dispatch/claude-preflight/preflight-ports.js";

const ROOT = path.resolve("/repo");
const TASK_FILE = path.join(ROOT, "AG", "tasks", "queue", "0042-demo.md");

const CANONICAL_TASK = [
  "# Task",
  "",
  "## Spec source",
  "AG/openspec/changes/my-change/spec.md",
  "",
  "## Tikslas",
  "Padaryti X.",
  "",
  "## Agentai",
  "readme-guard -> coder",
  "",
  "## Failai",
  "Leidžiama:",
  "- `src/a.ts`",
  "",
  "## Veiksmas",
  "- Daryti.",
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

const LLM_CLAUDE_TASK = [
  "# Task",
  "",
  "## Spec source",
  "openspec/changes/my-change/",
  "",
  "## Tikslas",
  "Padaryti X.",
  "",
  "## Agentai",
  "readme-guard -> coder",
  "",
  "## Failai",
  "Leidžiama:",
  "- `src/a.ts`",
  "",
  "## Veiksmas",
  "- Daryti.",
  "",
  "## Patikra",
  "- `pnpm test`",
  "",
  "## Stop",
  "Stop.",
].join("\n");

// Senos preambulės imitacija (046-a-02): requeue'intas failas gali nešti bet kokį ankstesnį
// `verificationPreamble` turinį — jis privalo dingti, ne susikaupti.
const STALE_PREAMBLE = "## Žingsnis 0 — SENA-VERSIJA-QWERTY\nSENA-KOMANDA-QWERTY\n\n## Sandbox taisyklės (sena)\n- x\n\n\n";

function auth(overrides: Partial<LlmCallAuthorization> = {}): LlmCallAuthorization {
  return {
    allowed: true, task_id: "0042-demo", phase: "preflight", reduce_context: false,
    hard_reasons: [], soft_reasons: [], raw_notices: [], total_llm_calls: 1,
    total_tokens: 0, billable_tokens: 0, remaining_total_llm_calls: null,
    remaining_total_tokens: null, phase_status: [],
    ...overrides,
  };
}

const POLICY: AgentPolicy = {
  version: "1",
  default_role: "coder",
  roles: {
    "readme-guard": { allowed_adapters: ["claude"], default_model_hint: "sonnet", can_write_code: false },
    coder: { allowed_adapters: ["claude"], default_model_hint: "sonnet", can_write_code: true },
    tester: { allowed_adapters: ["claude"], default_model_hint: "sonnet", can_write_code: true },
  },
};

type Harness = {
  ports: ClaudePreflightPorts;
  fileDecisions: PreflightDecision[];
  attemptDecisions: PreflightDecision[];
  reformulated: string[];
  attemptTasks: string[];
  preflightInputs: string[];
  usageLogs: Array<[string, string, string | undefined]>;
  agLines: string[];
  errs: string[];
  checkpoints: string[];
};

function makeHarness(input: {
  taskText: string;
  llm?: (prompt: string) => PreflightLlmResult | Promise<PreflightLlmResult>;
  graphJson?: string;
}): Harness {
  const fileDecisions: PreflightDecision[] = [];
  const attemptDecisions: PreflightDecision[] = [];
  const reformulated: string[] = [];
  const attemptTasks: string[] = [];
  const preflightInputs: string[] = [];
  const usageLogs: Array<[string, string, string | undefined]> = [];
  const agLines: string[] = [];
  const errs: string[] = [];
  const checkpoints: string[] = [];

  const ports: ClaudePreflightPorts = {
    projectRoot: ROOT,
    runtimeRoot: path.join(ROOT, "vq"),
    agRoot: path.join(ROOT, "AG"),
    ensureDirs: async () => {},
    resolveExistingTaskFile: async () => TASK_FILE,
    readOptionalFile: async (absolutePath) => {
      if (absolutePath === TASK_FILE) return input.taskText;
      if (absolutePath.endsWith("graph.json")) return input.graphJson ?? "";
      return "";
    },
    listAgentFiles: async () => ["readme-guard.md", "coder.md", "tester.md", "ne-agentas.txt"],
    loadAgentPolicy: async () => POLICY,
    loadProjectProfile: async () => undefined,
    verificationCommands: async () => ({ rebuild: "pnpm build", checks: ["pnpm test"] }),
    policyFs: { readTextFileIfExists: async () => undefined },
    openSpec: {
      fs: {
        exists: async () => true,
        readTextFileIfExists: async (p) => (p.replace(/\\/g, "/").includes("openspec/changes/my-change") ? "# Spec\nturinys\n" : undefined),
        listSubdirectories: async () => [],
      },
      isDirectory: async (p) => p.replace(/\\/g, "/").endsWith("openspec/changes/my-change"),
    },
    authorizeLlmCall: async () => auth(),
    generateChange: async () => null,
    writeTemplateChange: async () => null,
    resolveModel: async (tier) => `model-${tier}`,
    modelSelectionRules: "- MODELIO TAISYKLĖS",
    runHeadless: async (prompt) => (input.llm ? await input.llm(prompt) : { stdout: "{}", stderr: "", code: 0 }),
    parseDecision: (stdout) => {
      try {
        return JSON.parse(stdout) as PreflightDecision;
      } catch {
        return {};
      }
    },
    isUsageLimitOutput: (stdout) => stdout.includes("USAGE_LIMIT"),
    logTokenUsage: async (phase, model, stdout) => { usageLogs.push([phase, model, stdout]); },
    ensureFreshCodeIndex: async () => ({ kind: "skip" }),
    attempt: {
      writeDecision: async (decision) => { attemptDecisions.push(decision); },
      writeTask: async (body) => { attemptTasks.push(body); },
      appendPreflightInput: async (prompt) => { preflightInputs.push(prompt); },
    },
    files: {
      writeDecision: async (json) => { fileDecisions.push(JSON.parse(json) as PreflightDecision); },
      writeReformulated: async (body) => { reformulated.push(body); },
      writePreflightInput: async () => {},
      writeSupervisorLog: async () => {},
      dirExists: async () => true,
    },
    recordResumeCheckpoint: async (entry) => { checkpoints.push(`${entry.phase}:${entry.status}`); },
    agLog: async (line) => { agLines.push(line); },
    stderr: (line) => { errs.push(line); },
  };
  return { ports, fileDecisions, attemptDecisions, reformulated, attemptTasks, preflightInputs, usageLogs, agLines, errs, checkpoints };
}

test("preflight-fastpath taisyklė: Neįtraukta exempt, signalų vartai, grandinė su label'iu", () => {
  const base = {
    missingHardSections: [],
    missingSoftSections: ["## Neįtraukta"],
    sizeViolations: [],
    allowedPathCount: 1,
    backtickCheckCount: 1,
    agentaiSection: "Privaloma grandinė: readme-guard -> coder",
    knownAgents: ["readme-guard", "coder"],
  };
  const hit = evaluateDeterministicPreflight(base);
  assert.equal(hit.fastPath, true);
  assert.deepEqual(hit.chain, ["readme-guard", "coder"]);

  assert.equal(evaluateDeterministicPreflight({ ...base, missingHardSections: ["## Stop"] }).fastPath, false);
  assert.equal(evaluateDeterministicPreflight({ ...base, missingSoftSections: ["## Failai"] }).fastPath, false);
  assert.equal(evaluateDeterministicPreflight({ ...base, sizeViolations: ["lines 200 > 120"] }).fastPath, false);
  assert.equal(evaluateDeterministicPreflight({ ...base, allowedPathCount: 0 }).fastPath, false);
  assert.equal(evaluateDeterministicPreflight({ ...base, backtickCheckCount: 0 }).fastPath, false);
  assert.match(
    evaluateDeterministicPreflight({ ...base, agentaiSection: "readme-guard -> nezinomas" }).reason,
    /unknown agent tokens/,
  );
  assert.equal(extractChainFromAgentaiSection("").length, 0);
});

function preflightDecisionFixture(claudeTask: string): PreflightDecision {
  return {
    verdict: "delegate", task_id: "0042-demo", selected_model: "sonnet",
    target_agent_chain: ["readme-guard", "coder"], reason: "ok", claude_task: claudeTask, child_tasks: [],
  };
}

// CANONICAL_TASK deklaruoja `src/a.ts` be testo kelio — pažeidžia 000-etalonas.md ## Failai (2).
test("validatePreflightDecision: kanoniškumo pažeidimas → reformulate_delegate su citata; atitinkantis task'as nepakinta (070-b-03)", () => {
  const violating = validatePreflightDecision({
    decision: preflightDecisionFixture(CANONICAL_TASK),
    sourceChangeTask: false,
    availableAgentNames: ["readme-guard", "coder"],
    activeChangeDirs: [],
  });
  assert.equal(violating.decision.verdict, "reformulate_delegate", "pažeidimas → reformulate, ne dispatch");
  assert.match(violating.decision.reason ?? "", /000-etalonas\.md ## Failai \(2\)/, "žinutė cituoja pažeistą taisyklę");
  assert.equal(violating.validationErrors.length, 0, "pažeidimas neparkuoja į human_review");

  const compliantTask = CANONICAL_TASK.replace("- `src/a.ts`", "- `src/a.ts`\n- `src/a.test.ts`");
  const compliant = validatePreflightDecision({
    decision: preflightDecisionFixture(compliantTask),
    sourceChangeTask: false,
    availableAgentNames: ["readme-guard", "coder"],
    activeChangeDirs: [],
  });
  assert.equal(compliant.decision.verdict, "delegate", "be pažeidimo — verdiktas nepakitęs");
  assert.equal(compliant.decision.reason, "ok", "be pažeidimo — reason nepapildytas citata");
});

test("spec-source pagalbininkai: appendSpecSourceRef be dublikatinės antraštės; architecture-node validacija", async () => {
  const fresh = appendSpecSourceRef("# Task\n\n## Tikslas\nX.", "AG/openspec/changes/a/spec.md");
  assert.match(fresh, /## Spec source\nAG\/openspec\/changes\/a\/spec\.md\n$/);

  const existing = appendSpecSourceRef(
    "# Task\n\n## Spec source\nsenas.md\n\n## Tikslas\nX.\n",
    "naujas.md",
  );
  assert.equal((existing.match(/## Spec source/g) ?? []).length, 1, "antra antraštė NIEKADA nekuriama (1217)");
  assert.match(existing, /## Spec source\nsenas\.md\nnaujas\.md\n/);

  const ports = {
    runtimeRoot: path.join(ROOT, "vq"),
    readOptionalFile: async (p: string) =>
      p.endsWith("graph.json") ? JSON.stringify({ nodes: [{ id: "worker" }] }) : "",
  };
  assert.equal(await hasValidArchitectureNodeReference(ports, "zr. architecture-node/worker"), true);
  assert.equal(await hasValidArchitectureNodeReference(ports, "zr. architecture-node/nesamas"), false);
  assert.equal(await hasValidArchitectureNodeReference(ports, "jokios nuorodos"), false);
  assert.equal(
    await hasValidArchitectureNodeReference(
      { ...ports, readOptionalFile: async () => "ne json" },
      "architecture-node/worker",
    ),
    false,
  );
});

test("claudePreflight: usage/rezoliucijos klaidos → USAGE_ERROR_EXIT_CODE", async () => {
  const usage = makeHarness({ taskText: CANONICAL_TASK });
  assert.equal(await claudePreflight([], usage.ports), USAGE_ERROR_EXIT_CODE);
  assert.match(usage.errs[0] ?? "", /Usage: verqestra claude-preflight/);

  const missing = makeHarness({ taskText: CANONICAL_TASK });
  missing.ports.resolveExistingTaskFile = async () => {
    throw new Error("task file must exist");
  };
  assert.equal(await claudePreflight(["x.md"], missing.ports), USAGE_ERROR_EXIT_CODE);
  assert.equal(missing.errs[0], "task file must exist");
});

test("claudePreflight: fast-path — sprendimas į attempt PIRMA + globalus veidrodis, tier paskelbtas, preamble", async () => {
  const h = makeHarness({ taskText: CANONICAL_TASK });
  const code = await claudePreflight(["AG/tasks/queue/0042-demo.md"], h.ports);
  assert.equal(code, 0);

  assert.equal(h.fileDecisions.length, 1);
  const decision = h.fileDecisions[0]!;
  assert.equal(decision.verdict, "delegate");
  assert.deepEqual(decision.target_agent_chain, ["readme-guard", "coder"]);
  assert.match(decision.reason ?? "", /deterministic-fastpath/);
  assert.ok(decision.token_budget_tier, "task 0941: tier paskelbtas sprendime");
  assert.deepEqual(h.attemptDecisions[0], decision, "kanoninis attempt įrašas — tie patys laukai");

  assert.equal(h.reformulated.length, 1);
  assert.ok(h.reformulated[0]!.startsWith("## Žingsnis 0"), "VERIFICATION_PREAMBLE pridėtas");
  assert.equal((h.reformulated[0]!.match(/## Žingsnis 0/g) ?? []).length, 1, "tik viena preambulė");
  assert.deepEqual(h.attemptTasks, h.reformulated, "attempt task — tie patys baitai");
  assert.deepEqual(h.usageLogs[0], ["preflight-fastpath", "none", undefined]);
  assert.equal(h.checkpoints.at(-1), "preflight:finished");
  assert.equal(h.preflightInputs.length, 0, "fast-path be LLM — jokio prompt'o");
});

test("claudePreflight: fast-path perrenderina SENĄ preambulę šviežia, nesikaupia (task 046-a-02)", async () => {
  const h = makeHarness({ taskText: `${STALE_PREAMBLE}${CANONICAL_TASK}` });
  assert.equal(await claudePreflight(["AG/tasks/queue/0042-demo.md"], h.ports), 0);
  const body = h.reformulated[0]!;
  assert.equal((body.match(/## Žingsnis 0/g) ?? []).length, 1, "tik viena preambulė, sena nuimta");
  assert.doesNotMatch(body, /QWERTY/, "sena preambulė nebelieka");
  assert.match(body, /pnpm build/, "šviežia preambulė neša dabartines verificationCommands");
});

test("claudePreflight: rizikos vartai ir invalid OpenSpec ref → human_review sprendimas + exit 1", async () => {
  const risky = makeHarness({
    taskText: CANONICAL_TASK.replace("Padaryti X.", "Rotate jwt secrets.").replace("- `src/a.ts`", "- `src/auth/token.ts`"),
  });
  assert.equal(await claudePreflight(["t"], risky.ports), 1);
  assert.equal(risky.fileDecisions[0]?.verdict, "human_review");
  assert.match(risky.fileDecisions[0]?.reason ?? "", /Risk gate requires human review/);
  assert.equal(risky.checkpoints.at(-1), "preflight:failed");

  const archived = makeHarness({
    taskText: CANONICAL_TASK.replace("AG/openspec/changes/my-change/spec.md", "openspec/changes/archive/senas"),
  });
  assert.equal(await claudePreflight(["t"], archived.ports), 1);
  assert.match(archived.fileDecisions[0]?.reason ?? "", /Invalid OpenSpec reference: .*archived/);

  // Task 042: kūno CITATA (klaidos tekstas backtick'uose — 039/041 kritimo klasė) nebėra vartų
  // įvestis: parkuoja tik `## Spec source` DEKLARUOTOS nuorodos, o deklaruota čia tvarkinga.
  const cited = makeHarness({
    taskText: CANONICAL_TASK.replace("- nieko", "- krito 21:42 (`openspec/changes/auto- does not exist`)"),
  });
  assert.equal(await claudePreflight(["t"], cited.ports), 0);
  assert.equal(cited.fileDecisions[0]?.verdict, "delegate");
});

test("claudePreflight: LLM kelias — fastpath-miss, prompt'as su taisyklėmis, verdikto validacija ir readme-guard prepend", async () => {
  const seenPrompts: string[] = [];
  const llmDecision: PreflightDecision = {
    verdict: "delegate",
    task_id: "0042-demo",
    selected_model: "sonnet",
    target_agent_chain: ["coder"],
    reason: "ok",
    claude_task: LLM_CLAUDE_TASK.replace("readme-guard -> coder", "coder"),
    child_tasks: [],
  };
  const h = makeHarness({
    // nežinomas agentas grandinėje → fastpath miss → LLM kelias.
    taskText: CANONICAL_TASK.replace("readme-guard -> coder", "readme-guard -> nezinomas"),
    llm: (prompt) => {
      seenPrompts.push(prompt);
      return { stdout: JSON.stringify(llmDecision), stderr: "", code: 0 };
    },
  });
  const code = await claudePreflight(["t"], h.ports);
  assert.equal(code, 0);

  assert.ok(h.agLines.some((line) => line.includes("fastpath-miss")));
  assert.equal(seenPrompts.length, 1);
  assert.ok(seenPrompts[0]!.includes("- MODELIO TAISYKLĖS"), "modelSelectionRules per portą");
  assert.ok(seenPrompts[0]!.includes("coder, readme-guard, tester"), "žinomi agentai (rikiuoti) prompt'e");
  assert.deepEqual(h.preflightInputs, seenPrompts, "attempt input append-only kopija");

  // Source-change + chain be readme-guard → deterministinis prepend + ## Agentai sync.
  const written = h.fileDecisions[0]!;
  assert.deepEqual(written.target_agent_chain, ["readme-guard", "coder"]);
  assert.match(written.claude_task ?? "", /## Agentai\nreadme-guard -> coder\n/);
  assert.equal(h.usageLogs[0]?.[0], "preflight", "LLM kvietimo usage apskaita");
  assert.ok(h.reformulated[0]!.startsWith("## Žingsnis 0"));
  assert.equal((h.reformulated[0]!.match(/## Žingsnis 0/g) ?? []).length, 1, "tik viena preambulė");
});

test("claudePreflight: LLM claude_task su SENA preambule → reformulate perrenderina šviežia (task 046-a-02)", async () => {
  const llmDecision: PreflightDecision = {
    verdict: "delegate",
    task_id: "0042-demo",
    selected_model: "sonnet",
    target_agent_chain: ["coder"],
    reason: "ok",
    claude_task: `${STALE_PREAMBLE}${LLM_CLAUDE_TASK.replace("readme-guard -> coder", "coder")}`,
    child_tasks: [],
  };
  const h = makeHarness({
    // nežinomas agentas grandinėje → fastpath miss → LLM kelias.
    taskText: CANONICAL_TASK.replace("readme-guard -> coder", "readme-guard -> nezinomas"),
    llm: () => ({ stdout: JSON.stringify(llmDecision), stderr: "", code: 0 }),
  });
  assert.equal(await claudePreflight(["t"], h.ports), 0);
  const body = h.reformulated[0]!;
  assert.equal((body.match(/## Žingsnis 0/g) ?? []).length, 1, "tik viena preambulė, sena nuimta");
  assert.doesNotMatch(body, /QWERTY/, "sena preambulė nebelieka");
  assert.match(body, /pnpm build/, "šviežia preambulė neša dabartines verificationCommands");
});

test("claudePreflight: LLM claude_task ## Failai turi sugalvotą kelią → guard grąžina originalo sekciją + garsus log (task 045-a-02)", async () => {
  const llmDecision: PreflightDecision = {
    verdict: "delegate",
    task_id: "0042-demo",
    selected_model: "sonnet",
    target_agent_chain: ["coder"],
    reason: "ok",
    claude_task: LLM_CLAUDE_TASK.replace("readme-guard -> coder", "coder").replace(
      "- `src/a.ts`",
      "- `src/nera-tokio-katalogo/phantom.ts`",
    ),
    child_tasks: [],
  };
  const h = makeHarness({
    // nežinomas agentas grandinėje → fastpath miss → LLM kelias.
    taskText: CANONICAL_TASK.replace("readme-guard -> coder", "readme-guard -> nezinomas"),
    llm: () => ({ stdout: JSON.stringify(llmDecision), stderr: "", code: 0 }),
  });
  h.ports.files.dirExists = async (dir) => dir !== "src/nera-tokio-katalogo";

  const code = await claudePreflight(["t"], h.ports);
  assert.equal(code, 0);

  const written = h.fileDecisions[0]!;
  assert.match(written.claude_task ?? "", /- `src\/a\.ts`/, "sugalvotas kelias pakeistas originalo ## Failai sekcija");
  assert.doesNotMatch(written.claude_task ?? "", /nera-tokio-katalogo/, "sugalvotas kelias nebelieka claude_task'e");
  assert.ok(
    h.agLines.some((line) => line.includes("hallucinated-allowed-path")),
    "garsus log apie sugalvotą kelią",
  );
});

test("claudePreflight: LLM task_id (per ilgas/kitoks) visada antspauduojamas kanoniniu taskId (task 041)", async () => {
  const longModelTaskId = `0042-demo-${"x".repeat(60)}`; // > 50 simbolių, nesutampa su kanoniniu
  const llmDecision: PreflightDecision = {
    verdict: "delegate",
    task_id: longModelTaskId,
    selected_model: "sonnet",
    target_agent_chain: ["coder"],
    reason: "ok",
    claude_task: LLM_CLAUDE_TASK.replace("readme-guard -> coder", "coder"),
    child_tasks: [],
  };
  const h = makeHarness({
    // nežinomas agentas grandinėje → fastpath miss → LLM kelias.
    taskText: CANONICAL_TASK.replace("readme-guard -> coder", "readme-guard -> nezinomas"),
    llm: () => ({ stdout: JSON.stringify(llmDecision), stderr: "", code: 0 }),
  });
  const code = await claudePreflight(["t"], h.ports);

  // (b) Sprendimas RAŠOMAS (ne human_review/reject dėl neatitikimo) — tai antspaudavimas, ne atmetimas.
  assert.equal(code, 0);
  assert.notEqual(h.fileDecisions[0]?.verdict, "human_review");

  // (a) Ką faktiškai parašė failų ir attempt portai — kanoninis taskId, ne modelio reikšmė.
  const canonicalTaskId = "0042-demo";
  assert.equal(h.fileDecisions[0]?.task_id, canonicalTaskId);
  assert.notEqual(h.fileDecisions[0]?.task_id, longModelTaskId);
  assert.equal(h.attemptDecisions[0]?.task_id, canonicalTaskId);
  assert.notEqual(h.attemptDecisions[0]?.task_id, longModelTaskId);
});

test("claudePreflight: 429 → USAGE_LIMIT_EXIT_CODE; tuščias verdict du kartus → human-review; biudžetas išsemtas → human-review", async () => {
  const limited = makeHarness({
    taskText: CANONICAL_TASK.replace("readme-guard -> coder", "readme-guard -> nezinomas"),
    llm: () => ({ stdout: "USAGE_LIMIT reached", stderr: "", code: 0 }),
  });
  assert.equal(await claudePreflight(["t"], limited.ports), USAGE_LIMIT_EXIT_CODE);
  assert.ok(limited.errs.some((line) => line.includes("429")));

  const empty = makeHarness({
    taskText: CANONICAL_TASK.replace("readme-guard -> coder", "readme-guard -> nezinomas"),
    llm: () => ({ stdout: "{}", stderr: "", code: 0 }),
  });
  assert.equal(await claudePreflight(["t"], empty.ports), 1);
  assert.match(empty.fileDecisions[0]?.reason ?? "", /neparsinamą JSON .* du kartus/);

  const broke = makeHarness({
    taskText: CANONICAL_TASK.replace("readme-guard -> coder", "readme-guard -> nezinomas"),
  });
  broke.ports.authorizeLlmCall = async () => auth({ allowed: false, hard_reasons: ["LLM calls 9 > 8"] });
  assert.equal(await claudePreflight(["t"], broke.ports), 1);
  assert.match(broke.fileDecisions[0]?.reason ?? "", /Token budget exhausted before preflight: LLM calls 9 > 8/);
});

test("claudePreflight: max-turns du kartus → human-review su park priežastimi", async () => {
  const h = makeHarness({
    taskText: CANONICAL_TASK.replace("readme-guard -> coder", "readme-guard -> nezinomas"),
    llm: () => ({ stdout: '{"subtype":"error_max_turns"}', stderr: "", code: 1 }),
  });
  assert.equal(await claudePreflight(["t"], h.ports), 1);
  assert.match(h.fileDecisions[0]?.reason ?? "", /viršijo max-turns limitą .* du kartus/);
  assert.ok(h.agLines.filter((line) => line.includes("corrective no-tools retry")).length >= 1);
});
