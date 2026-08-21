// `claude-preflight` CLI adapteris (etalonas: interfaces/cli/claude-preflight/index.ts,
// 1004 eil. — suskaidyta pagal 500 gate: portai preflight-ports.ts, spec-source vartai
// spec-source.ts, LLM pusė preflight-llm.ts). Vartų SEKA 1:1 su etalonu: OpenSpec
// validacija → sekcijos → risk gates (CV-03) → policy gates (873) → code-index (975) →
// size gate + token biudžetas → deterministinis fast-path (TOK-01) → LLM su koreguojančiais
// retry (max-turns / tuščias verdict / skaldymas / patikra) → validacija → artefaktai.
// Visi efektai — per ClaudePreflightPorts (kompozicija VQ-504); handler'is grąžina exit kodą.

import path from "node:path";
import { USAGE_ERROR_EXIT_CODE } from "../../../../shared/exit-codes.js";
import {
  VERIFICATION_PREAMBLE,
  ensureReadmeGuardFirst,
  evaluateArchitectureAndPolicyGates,
  extractSpecSources,
  isEmptyVerdict,
  isSourceChangeTask,
  missingTaskSections,
  needsPatikraChecksRetry,
  normalizeLegacyTaskSections,
  parseBacktickChecks,
  syncAgentsSection,
} from "../../../../application/quality-gates/preflight-rules.js";
import {
  allowedPaths,
  analyzeHumanReviewGates,
  classifyTask,
  evaluateDeterministicPreflight,
  exceedsLimits,
  extractSection,
  measureTaskSize,
  taskLedgerKey,
} from "../../../../application/quality-gates/preflight-fastpath.js";
import { validatePreflightDecision, wrapClaudeTask } from "./preflight-validate.js";
import {
  loadArchitectureStylePolicy,
  loadEnforcementPolicy,
} from "../../../../application/policy-governance/architecture-policies.js";
import { loadTaskClassificationPolicy } from "../../../../application/policy-governance/task-classification-policy.js";
import { loadContextBudget } from "../../../../application/policy-governance/context-budget.js";
import {
  loadPreflightLimits,
  type PreflightLimits,
} from "../../../../application/policy-governance/preflight-limits-policy.js";
import { analyzeOpenSpecReferences, buildOpenSpecContext } from "../../../../application/task-planning/openspec-context.js";
import { optimizeTokenBudget } from "../../../../application/token-governance/token-budget-optimizer.js";
import { resolveMaxTurns } from "../../../../application/token-governance/turn-budget.js";
import { DECISION_TOKEN_BUDGET_TIER_KEY, type TokenBudgetTier } from "../../../../application/token-governance/tiers.js";
import { ensureSpecSource } from "./spec-source.js";
import {
  EMPTY_VERDICT_DIRECTIVE,
  NO_TOOLS_DIRECTIVE,
  PATIKRA_DIRECTIVE,
  buildBasePrompt,
  createPreflightLlmRunner,
  maxTurnsParkReason,
  splitDirective,
  type PromptScale,
} from "./preflight-llm.js";
import type { ClaudePreflightPorts, PreflightDecision } from "./preflight-ports.js";

export async function claudePreflight(args: string[], ports: ClaudePreflightPorts): Promise<number> {
  await ports.ensureDirs();

  const taskFileArg = args[0];
  if (!taskFileArg) {
    ports.stderr("Usage: verqestra claude-preflight <task-file>");
    return USAGE_ERROR_EXIT_CODE;
  }

  let taskFile: string;
  try {
    taskFile = await ports.resolveExistingTaskFile(taskFileArg);
  } catch (error) {
    ports.stderr(error instanceof Error ? error.message : String(error));
    return USAGE_ERROR_EXIT_CODE;
  }
  const taskId = taskLedgerKey(taskFile);

  const agentFiles = await ports.listAgentFiles();
  const agentPolicy = await ports.loadAgentPolicy();
  const availableAgentNames = agentFiles
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.replace(/\.md$/, ""))
    .filter((name) => agentPolicy.roles[name]?.enabled !== false && Boolean(agentPolicy.roles[name]))
    .sort();
  const availableAgents = availableAgentNames.join(", ");

  const out = path.join(ports.runtimeRoot, "supervisor", "decision.json");
  const inputPath = path.join(ports.runtimeRoot, "supervisor", "preflight-input.md");
  const supervisorLogPath = path.join(ports.runtimeRoot, "logs", "supervisor-last.log");

  // Kanoninis attempt įrašas PIRMAS, globalus decision.json veidrodis ANTRAS (task 1117a);
  // task 0941: preflight PASKELBIA token biudžeto tier'ą sprendime, kad dispatch turn langą
  // skaičiuotų iš tos pačios reikšmės, o ne perklasifikuotų iš naujo.
  const writeDecision = async (decision: PreflightDecision, tokenBudgetTier?: TokenBudgetTier): Promise<void> => {
    const published: PreflightDecision =
      tokenBudgetTier === undefined ? decision : { ...decision, [DECISION_TOKEN_BUDGET_TIER_KEY]: tokenBudgetTier };
    await ports.attempt.writeDecision(published);
    await ports.files.writeDecision(`${JSON.stringify(published, null, 2)}\n`);
  };

  // `task` artefaktas write-once (bandymo ĮVESTIS); rašomi TIE PATYS baitai kaip į
  // reformulated-task.md.
  const writeReformulatedTask = async (body: string): Promise<void> => {
    await ports.attempt.writeTask(body);
    await ports.files.writeReformulated(body);
  };

  const writeHumanReviewDecision = async (reason: string): Promise<number> => {
    const fallback: PreflightDecision = {
      verdict: "human_review",
      task_id: taskId,
      selected_model: "haiku",
      target_agent_chain: [],
      reason,
      claude_task: "",
      child_tasks: [],
    };
    await writeDecision(fallback);
    await ports.recordResumeCheckpoint({
      actor: "supervisor",
      phase: "preflight",
      status: "failed",
      task_id: taskId,
      task_file: taskFile,
      log_file: out,
      next_action: "Preflight validation failed — human review required",
    });
    // Priežastis PRIVALO likti bendrame žurnale: decision.json ir supervisor-last.log
    // perrašomi kito task'o per kelias sekundes (etalono 861/868-02/869-02 pamoka).
    await ports.agLog(`CLAUDE PREFLIGHT: task=${taskId} human-review reason: ${reason}`);
    ports.stderr(reason);
    return 1;
  };

  const taskText = await ports.readOptionalFile(taskFile);
  // Legacy/near-kanoninių sekcijų deterministinis normalizavimas PRIEŠ bet kokį gate'ą
  // (task 882); activeText toliau gali būti papildytas auto-OpenSpec nuoroda.
  let activeText = normalizeLegacyTaskSections(taskText);
  const configuredLimits = await loadPreflightLimits(ports.policyFs, ports.runtimeRoot);
  const contextBudget = await loadContextBudget(ports.policyFs, ports.runtimeRoot);
  const limits: PreflightLimits = {
    ...configuredLimits,
    maxAllowedPaths: Math.min(configuredLimits.maxAllowedPaths, contextBudget.max_files),
  };
  let openSpecRefs = await analyzeOpenSpecReferences(ports.openSpec, ports.projectRoot, activeText);
  // Trūkstamas/sugadintas profilis (švieži target install'ai) → saugūs numatytieji (task 888).
  const projectProfile = await ports.loadProjectProfile().catch(() => undefined);
  const sourceChangeTask = isSourceChangeTask(activeText, projectProfile?.source_roots);
  let openSpecContext = await buildOpenSpecContext(ports.openSpec, ports.projectRoot, activeText);

  const specSourceGate = await ensureSpecSource(ports, {
    taskId,
    activeText,
    openSpecRefs,
    openSpecContext,
    sourceChangeTask,
    autoOpenSpec: limits.autoOpenSpec,
  });
  if (!specSourceGate.ok) {
    return await writeHumanReviewDecision(specSourceGate.reason);
  }
  activeText = specSourceGate.activeText;
  openSpecRefs = specSourceGate.openSpecRefs;
  openSpecContext = specSourceGate.openSpecContext;

  const inputMissing = missingTaskSections(activeText);
  if (inputMissing.hard.length > 0) {
    return await writeHumanReviewDecision(`Task is missing required sections: ${inputMissing.hard.join(", ")}`);
  }

  // CV-03: rizikos patikra PRIEŠ size gate ir PRIEŠ LLM kvietimą — rizikingam task'ui
  // neeikvojamas LLM bandymas, o dispatch nevyksta.
  const humanReview = analyzeHumanReviewGates(activeText, allowedPaths(activeText));
  if (humanReview.requires_human_review) {
    const categories = humanReview.gates.map((gate) => gate.category).join(", ");
    await ports.agLog(`CLAUDE PREFLIGHT: task=${taskId} human-review risk gates: ${categories}`);
    return await writeHumanReviewDecision(
      `Risk gate requires human review before dispatch (${categories}): ${humanReview.reasons.join("; ")}`,
    );
  }
  if (humanReview.approved_marker) {
    await ports.agLog(
      `CLAUDE PREFLIGHT: task=${taskId} risk gates suppressed by HUMAN-REVIEW-APPROVED: ${humanReview.approved_marker}`,
    );
  }

  // Task 873: architecture-style ir enforcement vartai — tos pačios grynos taisyklės kaip
  // rankiniame preflight; fatal → human_review, advisory — tik žurnalas.
  const policyGateAllowedFiles = allowedPaths(activeText);
  const policyGateClassification = classifyTask(
    activeText,
    policyGateAllowedFiles,
    await loadTaskClassificationPolicy(ports.policyFs, ports.runtimeRoot),
  );
  const policyGates = evaluateArchitectureAndPolicyGates({
    taskText: activeText,
    allowedFiles: policyGateAllowedFiles,
    checks: parseBacktickChecks(activeText),
    specSources: extractSpecSources(activeText),
    classification: policyGateClassification,
    architectureStylePolicy: await loadArchitectureStylePolicy(ports.policyFs, ports.runtimeRoot),
    enforcementPolicy: await loadEnforcementPolicy(ports.policyFs, ports.runtimeRoot),
  });
  if (policyGates.reviewReasons.length > 0) {
    await ports.agLog(
      `CLAUDE PREFLIGHT: task=${taskId} policy gate advisory (non-fatal): ${policyGates.reviewReasons.join("; ")}`,
    );
  }
  if (policyGates.invalidReasons.length > 0) {
    await ports.agLog(`CLAUDE PREFLIGHT: task=${taskId} policy gate fatal: ${policyGates.invalidReasons.join("; ")}`);
    return await writeHumanReviewDecision(
      `Policy gate requires human review before dispatch: ${policyGates.invalidReasons.join("; ")}`,
    );
  }

  // Task 975: existing-code task'ai niekada tyliai nepraranda code graph konteksto —
  // pirma deterministinis rebuild, human review tik kai rebuild pats negali.
  const codeIndexReadiness = await ports.ensureFreshCodeIndex(policyGateAllowedFiles);
  if (codeIndexReadiness.kind === "blocked") {
    await ports.agLog(`CLAUDE PREFLIGHT: task=${taskId} code-index blocked: ${codeIndexReadiness.reason}`);
    return await writeHumanReviewDecision(`Existing-code task requires a fresh code index: ${codeIndexReadiness.reason}`);
  }
  if (codeIndexReadiness.kind === "rebuilt") {
    await ports.agLog(`CLAUDE PREFLIGHT: task=${taskId} code-index was stale and was deterministically rebuilt`);
  }

  // A funkcija: deterministinis size gate + vienas biudžeto verdiktas (TOK-3).
  const sizeMetrics = measureTaskSize(activeText, projectProfile?.source_roots);
  const sizeViolations = exceedsLimits(sizeMetrics, limits);
  const mustSplit = sizeViolations.length > 0;
  const optimizedBudget = optimizeTokenBudget({
    metrics: sizeMetrics,
    classification: policyGateClassification,
    baseBudget: contextBudget,
    splitRequired: mustSplit,
  });
  const optimizedTier = optimizedBudget.model_policy_hint;
  // Aktyvus OpenSpec darbas lieka bent Sonnet; rutininiai bounded task'ai gali gauti Haiku
  // ir remtis retry eskalacija, jei quality gates nepraeis.
  const preflightTier = openSpecRefs.activeChangeDirs.length > 0 && optimizedTier === "haiku" ? "sonnet" : optimizedTier;
  const model = await ports.resolveModel(preflightTier);
  await ports.agLog(
    `CLAUDE PREFLIGHT: task=${taskId} token-budget tier=${optimizedBudget.tier} model=${preflightTier} ` +
      `max_turns=${optimizedBudget.max_turns || "none"} reasons=${optimizedBudget.reasons.join("; ")}`,
  );

  // TOK-01: deterministinis fast-path — kanoninis task'as dispatch'inamas be LLM.
  if (limits.fastPath && !mustSplit) {
    const fast = evaluateDeterministicPreflight({
      missingHardSections: inputMissing.hard,
      missingSoftSections: inputMissing.soft,
      sizeViolations,
      allowedPathCount: allowedPaths(activeText).length,
      backtickCheckCount: parseBacktickChecks(activeText).length,
      agentaiSection: extractSection(activeText, "## Agentai"),
      knownAgents: availableAgentNames,
    });
    if (fast.fastPath) {
      let chain = fast.chain;
      let claudeTask = activeText;
      if (sourceChangeTask && chain[0] !== "readme-guard") {
        chain = ensureReadmeGuardFirst(chain);
        claudeTask = syncAgentsSection(claudeTask, chain);
        await ports.agLog(`CLAUDE PREFLIGHT: task=${taskId} auto-prepend readme-guard (fast-path chain normalized)`);
      }
      const decision: PreflightDecision = {
        verdict: "delegate",
        task_id: taskId,
        selected_model: preflightTier,
        target_agent_chain: chain,
        reason: `deterministic-fastpath: ${fast.reason}`,
        claude_task: claudeTask,
        child_tasks: [],
      };
      await writeDecision(decision, optimizedBudget.tier);
      // Requeue'inti delegated failai preamble jau turi — antrą kartą nepridedam.
      const reformulatedBody = claudeTask.includes("## Žingsnis 0") ? claudeTask : `${VERIFICATION_PREAMBLE}${claudeTask}`;
      await writeReformulatedTask(`${reformulatedBody.trimEnd()}\n`);
      await ports.recordResumeCheckpoint({
        actor: "supervisor",
        phase: "preflight",
        status: "finished",
        task_id: taskId,
        task_file: taskFile,
        log_file: out,
        next_action: "Delegate task to Claude (deterministic fast-path, no LLM)",
      });
      await ports.logTokenUsage("preflight-fastpath", "none");
      await ports.agLog(
        `CLAUDE PREFLIGHT (deterministic): task=${taskId} verdict=delegate model=${preflightTier} reason=${fast.reason}`,
      );
      return 0;
    }
    // Miss priežastis be pėdsako neleistų matuoti, kurie signalai varo task'us į brangų LLM kelią.
    await ports.agLog(`CLAUDE PREFLIGHT: task=${taskId} fastpath-miss: ${fast.reason}`);
  }

  const architectureRules = await ports.readOptionalFile(path.join(ports.runtimeRoot, "config", "architecture-rules.md"));
  const buildPrompt = (scale: PromptScale): string =>
    buildBasePrompt(
      {
        taskId,
        activeText,
        openSpecContext,
        architectureRules,
        availableAgents,
        modelSelectionRules: ports.modelSelectionRules,
      },
      scale,
    );

  const firstSuffix = mustSplit ? splitDirective(sizeViolations, limits, false) : "";
  await ports.recordResumeCheckpoint({
    actor: "supervisor",
    phase: "preflight",
    status: "started",
    task_id: taskId,
    task_file: taskFile,
    log_file: inputPath,
    next_action: "Run Claude preflight and write vq/supervisor/decision.json",
  });

  // TOK-3: preflight yra semantinė peržiūra — savo turn lentelės eilutė, llmMaxTurns lieka
  // operatoriaus lubos virš jos.
  const semanticReviewMaxTurns = resolveMaxTurns({
    phase: "semantic-review",
    tier: optimizedBudget.tier,
    ...(limits.turnLimits === undefined ? {} : { limits: limits.turnLimits }),
    ceiling: limits.llmMaxTurns,
  });
  const runPreflightAttempt = createPreflightLlmRunner(ports, {
    taskId,
    taskFile,
    model,
    tier: preflightTier,
    maxTurns: semanticReviewMaxTurns,
    buildPrompt,
  });

  // Skaldymas pavyko, jei yra bent vienas child task IR claude_task pats nebeviršija ribų.
  const splitSatisfied = (candidate: PreflightDecision): boolean => {
    if ((candidate.child_tasks?.length ?? 0) === 0) {
      return false;
    }
    return exceedsLimits(measureTaskSize(candidate.claude_task ?? "", projectProfile?.source_roots), limits).length === 0;
  };

  // Bandymų orkestracija (etalono seka 1:1). Kiekviena šaka max_turns atveju gauna vieną
  // no-tools/koreguojantį retry; pakartotinis viršijimas — human-review su aiškia priežastimi.
  type Settled = { done: number } | { decision: PreflightDecision };
  const settle = async (suffix: string): Promise<Settled> => {
    const outcome = await runPreflightAttempt(suffix);
    if (outcome.kind === "max_turns") {
      return { done: await writeHumanReviewDecision(maxTurnsParkReason(semanticReviewMaxTurns)) };
    }
    if (outcome.kind === "human-review") {
      return { done: await writeHumanReviewDecision(outcome.reason) };
    }
    if (outcome.kind === "halt") {
      return { done: outcome.exitCode };
    }
    return { decision: outcome.decision };
  };

  let firstAttempt = await runPreflightAttempt(firstSuffix);
  if (firstAttempt.kind === "max_turns") {
    const retried = await settle(`${firstSuffix}${NO_TOOLS_DIRECTIVE}`);
    if ("done" in retried) return retried.done;
    firstAttempt = { kind: "ok", decision: retried.decision };
  }
  if (firstAttempt.kind === "human-review") {
    return await writeHumanReviewDecision(firstAttempt.reason);
  }
  if (firstAttempt.kind === "halt") {
    return firstAttempt.exitCode;
  }
  let decision = firstAttempt.decision;

  // Tuščias verdict = neparsinamas LLM atsakymas (dažniausiai neescape'inta kabutė
  // claude_task'e) — vienas koreguojantis retry, tada human-review (bounded).
  if (isEmptyVerdict(decision)) {
    const emptyRetry = await settle(`${firstSuffix}${EMPTY_VERDICT_DIRECTIVE}`);
    if ("done" in emptyRetry) return emptyRetry.done;
    decision = emptyRetry.decision;
    if (isEmptyVerdict(decision)) {
      return await writeHumanReviewDecision(
        "Preflight grąžino neparsinamą JSON (tuščią verdict) du kartus — tikėtina neescape'inta kabutė claude_task'e. Reikia rankinio peržiūrėjimo arba task teksto supaprastinimo (vengti „...\" kabučių).",
      );
    }
  }

  if (mustSplit && !splitSatisfied(decision)) {
    // Vienas griežtesnis retry; jei vis tiek per didelis — human_review (jokio ciklo).
    const retryAttempt = await settle(splitDirective(sizeViolations, limits, true));
    if ("done" in retryAttempt) return retryAttempt.done;
    decision = retryAttempt.decision;
    if (!splitSatisfied(decision)) {
      return await writeHumanReviewDecision(
        `Task exceeds size limits and could not be auto-split: ${sizeViolations.join("; ")}`,
      );
    }
  }

  // Task 926: delegate be ## Patikra backtick komandų gauna vieną koreguojantį retry;
  // nepavykus — parkuoja žemiau esanti validacija su ta pačia aiškia priežastimi.
  if (needsPatikraChecksRetry(decision)) {
    const patikraRetry = await settle(`${firstSuffix}${PATIKRA_DIRECTIVE}`);
    if ("done" in patikraRetry) return patikraRetry.done;
    decision = patikraRetry.decision;
  }

  const validated = validatePreflightDecision({
    decision,
    sourceChangeTask,
    availableAgentNames,
    activeChangeDirs: openSpecRefs.activeChangeDirs,
  });
  decision = validated.decision;
  if (validated.readmeGuardPrepended) {
    await ports.agLog(`CLAUDE PREFLIGHT: task=${taskId} auto-prepend readme-guard (source-change chain normalized)`);
  }
  if (validated.softMissing.length > 0) {
    await ports.agLog(
      `CLAUDE PREFLIGHT: task=${taskId} claude_task missing advisory sections (non-fatal): ${validated.softMissing.join(", ")}`,
    );
  }
  if (validated.validationErrors.length > 0) {
    return await writeHumanReviewDecision(`Invalid preflight decision: ${validated.validationErrors.join("; ")}`);
  }

  await writeDecision(decision, optimizedBudget.tier);

  let claudeTask = decision.claude_task ?? "";
  if (!claudeTask) {
    ports.stderr("Missing claude_task in Claude preflight response — routing to human review");
    const fallback: PreflightDecision = {
      verdict: "human_review",
      task_id: taskId,
      selected_model: "haiku",
      target_agent_chain: [],
      reason: "Preflight returned empty claude_task. Raw output logged to vq/logs/supervisor-last.log.",
      claude_task: "",
      child_tasks: [],
    };
    await writeDecision(fallback);
    await ports.recordResumeCheckpoint({
      actor: "supervisor",
      phase: "preflight",
      status: "failed",
      task_id: taskId,
      task_file: taskFile,
      log_file: supervisorLogPath,
      next_action: "Preflight returned empty claude_task — human review required",
    });
    await ports.agLog(`CLAUDE PREFLIGHT: task=${taskId} human-review reason: ${fallback.reason}`);
    return 1;
  }

  claudeTask = wrapClaudeTask(claudeTask, decision.target_agent_chain ?? []);

  await writeReformulatedTask(`${VERIFICATION_PREAMBLE}${claudeTask.trimEnd()}\n`);
  await ports.recordResumeCheckpoint({
    actor: "supervisor",
    phase: "preflight",
    status: "finished",
    task_id: taskId,
    task_file: taskFile,
    log_file: supervisorLogPath,
    next_action: "Delegate reformulated task to Claude",
  });
  await ports.agLog(
    `CLAUDE PREFLIGHT: task=${taskId} verdict=${decision.verdict ?? ""} model=${decision.selected_model ?? ""}`,
  );
  return 0;
}
