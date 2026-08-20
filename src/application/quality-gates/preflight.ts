// Preflight quality-gate use case (etalono application/quality-gates/preflight.ts, WBR VQ-305):
// validuoja dispatch task failą prieš task-size, klasifikacijos, human-review, token-budget,
// agentų, architecture-style ir enforcement politikas ir persistuoja sprendimą
// (`vq/supervisor/preflight-decision.json`) per portą. CLI argv/render — E5 adapteris; FS,
// code-index freshness ir policy loaderiai ateina per `PreflightPorts` (loaderių kompozicija —
// policy-governance moduliai).
import path from "node:path";
import { extractSection } from "../../shared/markdown.js";
import { resolveProjectPath } from "../../shared/paths.js";
import { taskFileStem } from "../../domain/tasks/identity.js";
import { allowedPaths } from "../../domain/tasks/allowed-paths.js";
import { analyzeHumanReviewGates, type HumanReviewGateResult } from "../../domain/tasks/index.js";
import { validateTaskSize, type TaskSizeMetrics } from "../../domain/tasks/size.js";
import {
  effectiveAgentRole,
  parseAgentBlock,
  validateAgentSelection,
  type AgentPolicy,
  type AgentSelection,
} from "../../domain/policies/agent-selection.js";
import { classifyTask, type TaskClassification, type TaskClassificationPolicy } from "../../domain/policies/task-classification.js";
import { buildTaskSplitPlan, type TaskSplitPlan } from "../task-execution/task-splitting.js";
import { optimizeTokenBudget, type TokenBudgetDecision } from "../token-governance/token-budget-optimizer.js";
import type { ContextBudgetSettings } from "../policy-governance/context-budget.js";
import type { PreflightLimits } from "../policy-governance/preflight-limits-policy.js";
import type {
  ArchitectureStylePolicyConfig,
  CodingPrinciplesPolicy,
  EnforcementPolicy,
} from "../policy-governance/architecture-policies.js";
import { ALL_REQUIRED_HEADINGS, evaluateArchitectureAndPolicyGates, parseBacktickChecks } from "./preflight-rules.js";

export type PreflightVerdict = "pass" | "review-needed" | "invalid";
export type PreflightDecision = {
  task_id: string;
  verdict: PreflightVerdict;
  reasons: string[];
  allowed_files: string[];
  checks: string[];
  spec_sources: string[];
  metrics: TaskSizeMetrics;
  classification?: TaskClassification;
  human_review?: HumanReviewGateResult;
  split_plan?: TaskSplitPlan;
  token_budget: TokenBudgetDecision;
  agents?: AgentSelection;
  policy_rules?: {
    architecture_style: ArchitectureStylePolicyConfig;
    coding_principles: CodingPrinciplesPolicy;
    enforcement: EnforcementPolicy;
  };
};

/** Visos preflight sprendimui reikalingos politikos — loaderių kompozicija (E4/E5). */
export type PreflightPolicies = {
  limits: PreflightLimits;
  budget: ContextBudgetSettings;
  classificationPolicy: TaskClassificationPolicy;
  agentPolicy: AgentPolicy;
  architectureStylePolicy: ArchitectureStylePolicyConfig;
  codingPrinciplesPolicy: CodingPrinciplesPolicy;
  enforcementPolicy: EnforcementPolicy;
};

export type PreflightPorts = {
  /** Task failo rezoliucija bucket'uose + turinys; meta klaidą, kai failo nėra. */
  resolveTaskFile(taskArg: string): Promise<{ filePath: string; text: string }>;
  loadPolicies(): Promise<PreflightPolicies>;
  /** `file` | `directory` | `absent` — spec source kandidatų patikra. */
  statPathKind(absolutePath: string): Promise<"file" | "directory" | "absent">;
  /** Code-index šviežumo patikra (code-intelligence store per FS portą). */
  codeIndexFreshness(): Promise<{ ok: boolean; reason?: string }>;
  /** Persistuoja sprendimą į `vq/supervisor/preflight-decision.json`. */
  writeDecision(decision: PreflightDecision): Promise<void>;
};

const requiredHeadings = ALL_REQUIRED_HEADINGS;

export async function evaluatePreflight(
  ports: PreflightPorts,
  args: string[],
  projectRoot = process.cwd(),
): Promise<PreflightDecision> {
  const taskArg = args[0]?.trim();
  if (!taskArg) throw new Error("Usage: ag preflight <task-file>");

  const root = path.resolve(projectRoot);
  const { filePath: taskPath, text: taskText } = await ports.resolveTaskFile(taskArg);
  const policies = await ports.loadPolicies();
  const taskId = taskFileStem(taskPath);
  const size = validateTaskSize(taskText, policies.limits);
  const splitPlan = size.ok ? undefined : buildTaskSplitPlan(taskText, taskId, policies.limits);
  const allowedFiles = allowedPaths(taskText);
  const checks = parseBacktickChecks(taskText);
  const specSources = nonEmptyLines(extractSection(taskText, "## Spec source"));
  const classification = classifyTask(taskText, allowedFiles, policies.classificationPolicy);
  const agents = parseAgentBlock(taskText);
  const humanReview = analyzeHumanReviewGates(taskText, allowedFiles);
  const tokenBudget = optimizeTokenBudget({
    metrics: size.metrics,
    classification,
    baseBudget: policies.budget,
    ...(humanReview.requires_human_review ? { humanReview } : {}),
    splitRequired: splitPlan?.required ?? false,
  });
  const invalidReasons: string[] = [];

  for (const heading of requiredHeadings) {
    if (!hasHeading(taskText, heading)) invalidReasons.push(`missing required heading: ${heading}`);
  }
  if (!firstNonEmptyLine(extractSection(taskText, "## Tikslas"))) invalidReasons.push("goal is empty");
  if (allowedFiles.length === 0) invalidReasons.push("allowed files are missing");
  if (checks.length === 0) invalidReasons.push("checks are missing");
  if (specSources.length === 0) invalidReasons.push("spec source is missing");
  for (const source of specSources) {
    if (!(await specSourceExists(ports, root, source))) invalidReasons.push(`spec source not found: ${source}`);
  }

  // Agentų kontraktas: jei task'as turi `## Agentai` — vaidmenys validuojami pagal
  // agents.json registrą (nežinomas role → invalid). Jei sekcijos nėra — numatytasis
  // vaidmuo (default_role) taikomas tyliai (ne-lūžtantis suderinamumas).
  if (hasHeading(taskText, "## Agentai")) {
    invalidReasons.push(...validateAgentSelection(agents, policies.agentPolicy));
  }

  if (requiresFreshCodeIndex(taskText)) {
    const freshness = await ports.codeIndexFreshness();
    if (!freshness.ok) invalidReasons.push(`code index not fresh: ${freshness.reason}`);
  }

  // Architecture-style ir enforcement vartai: tos pačios taisyklės, kurias vykdo ir
  // gamybinis loop preflight (etalono task 873) — task'as negali būti fatal čia, bet tyliai
  // deleguojamas loop'e. VERQESTRA vartai GRYNI — politikos jau įkeltos aukščiau.
  const policyGates = evaluateArchitectureAndPolicyGates({
    taskText,
    allowedFiles,
    checks,
    specSources,
    classification,
    architectureStylePolicy: policies.architectureStylePolicy,
    enforcementPolicy: policies.enforcementPolicy,
  });
  invalidReasons.push(...policyGates.invalidReasons);

  const reviewReasons = [...size.violations, ...humanReview.reasons, ...policyGates.reviewReasons];

  if (splitPlan?.required) {
    reviewReasons.push(`split plan generated: ${splitPlan.parts} parts`);
  }
  if (taskText.length > tokenBudget.max_context_chars) {
    reviewReasons.push(`context chars ${taskText.length} > ${tokenBudget.max_context_chars}`);
  }
  if (allowedFiles.length > tokenBudget.max_files) {
    reviewReasons.push(`context files ${allowedFiles.length} > ${tokenBudget.max_files}`);
  }

  const decision: PreflightDecision = {
    task_id: taskId,
    verdict: invalidReasons.length > 0 ? "invalid" : reviewReasons.length > 0 ? "review-needed" : "pass",
    reasons: invalidReasons.length > 0 ? invalidReasons : reviewReasons,
    allowed_files: allowedFiles,
    checks,
    spec_sources: specSources,
    metrics: size.metrics,
    classification,
    ...(humanReview.requires_human_review ? { human_review: humanReview } : {}),
    ...(splitPlan?.required ? { split_plan: splitPlan } : {}),
    token_budget: tokenBudget,
    agents: { ...agents, primary: effectiveAgentRole(agents, policies.agentPolicy) },
    policy_rules: {
      architecture_style: policies.architectureStylePolicy,
      coding_principles: policies.codingPrinciplesPolicy,
      enforcement: policies.enforcementPolicy,
    },
  };
  await ports.writeDecision(decision);
  return decision;
}

function hasHeading(text: string, heading: string): boolean {
  return text.split(/\r?\n/).some((line) => line.trim() === heading);
}

function nonEmptyLines(text: string): string[] {
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function firstNonEmptyLine(text: string): string {
  return nonEmptyLines(text)[0] ?? "";
}

async function specSourceExists(ports: PreflightPorts, projectRoot: string, source: string): Promise<boolean> {
  for (const candidate of specSourceCandidates(projectRoot, source)) {
    if ((await ports.statPathKind(candidate)) !== "absent") return true;
  }
  return false;
}

/**
 * Spec source kandidatai: normalizuotas santykinis kelias projekto šaknyje ir (openspec/
 * atveju) AG/ prefikso variantas — openspec katalogas VERQESTRA supervizuojamame projekte,
 * kaip ir etalone, gyvena `AG/openspec`. Absoliutūs, tušti ir `..` traversal keliai atmetami.
 */
export function specSourceCandidates(projectRoot: string, source: string): string[] {
  const normalized = source.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized) || normalized.split("/").includes("..")) return [];
  const candidates = [path.resolve(projectRoot, normalized)];
  if (normalized.startsWith("openspec/")) candidates.push(path.resolve(projectRoot, "AG", normalized));
  return candidates.filter((candidate) => isInside(projectRoot, candidate));
}

function isInside(root: string, candidate: string): boolean {
  // Kanoninė „santykinis kelias išeina iš šaknies" patikra per shared/paths:
  // resolveProjectPath meta, kai kandidatas išeina iš root ARBA lygus pačiam root
  // (spec source niekada nėra šaknis), tad švarus resolve reiškia griežtai viduje.
  try {
    resolveProjectPath(root, candidate);
    return true;
  } catch {
    return false;
  }
}

export function requiresFreshCodeIndex(taskText: string): boolean {
  const requestsGraphContext = /--with-code-graph|code graph context|code graph kontekst/i.test(taskText);
  const buildsIndex = /code-index storage|code-index build/i.test(taskText);
  return requestsGraphContext && !buildsIndex;
}
