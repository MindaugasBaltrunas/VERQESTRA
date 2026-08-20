// LLM sprendimo validacija ir deterministinis normalizavimas (etalono claude-preflight
// validacijos blokas 1:1, iškeltas iš index.ts dėl 500 eilučių gate).

import {
  ensureReadmeGuardFirst,
  hasFatalSectionGap,
  missingTaskSections,
  parseBacktickChecks,
  syncAgentsSection,
} from "../../../../application/quality-gates/preflight-rules.js";
import { allowedPaths, serializeAgentChain } from "../../../../application/quality-gates/preflight-fastpath.js";
import type { PreflightDecision } from "./preflight-ports.js";

export type PreflightValidationInput = {
  decision: PreflightDecision;
  sourceChangeTask: boolean;
  availableAgentNames: string[];
  activeChangeDirs: string[];
};

export type PreflightValidationResult = {
  decision: PreflightDecision;
  delegateVerdict: boolean;
  validationErrors: string[];
  /** Advisory SOFT sekcijos claude_task'e — žurnalui, niekada ne blokas. */
  softMissing: string[];
  /** True, kai readme-guard įterptas deterministiškai (source-change grandinės normalizavimas). */
  readmeGuardPrepended: boolean;
};

/**
 * Deterministinis readme-guard normalizavimas + etalono validacijos sąrašas: verdiktų
 * žodynas, grandinės buvimas/žinomumas, HARD sekcijos, netušti backtick scope/checks
 * (task 872) ir aktyvios OpenSpec nuorodos išsaugojimas.
 */
export function validatePreflightDecision(input: PreflightValidationInput): PreflightValidationResult {
  const decision = input.decision;
  const verdict = decision.verdict ?? "";
  let chain = decision.target_agent_chain ?? [];
  const delegateVerdict = verdict === "delegate" || verdict === "reformulate_delegate";

  // Source-change task'ui readme-guard PRIVALO būti pirmas; LLM jį prideda nepatikimai,
  // tad įterpiame deterministiškai IR suderiname claude_task ## Agentai. Tuščia grandinė
  // nesutvarkoma (tikra klaida) — ją pagauna validacija žemiau.
  let readmeGuardPrepended = false;
  if (delegateVerdict && input.sourceChangeTask && chain.length > 0 && chain[0] !== "readme-guard") {
    chain = ensureReadmeGuardFirst(chain);
    decision.target_agent_chain = chain;
    decision.claude_task = syncAgentsSection(decision.claude_task ?? "", chain);
    readmeGuardPrepended = true;
  }

  const availableAgentSet = new Set(input.availableAgentNames);
  const invalidAgents = chain.filter((agent) => !availableAgentSet.has(agent));
  const validationErrors: string[] = [];
  const outputMissing = missingTaskSections(decision.claude_task);

  if (!["delegate", "reformulate_delegate", "human_review", "reject"].includes(verdict)) {
    validationErrors.push(`invalid verdict '${verdict || "<empty>"}'`);
  }
  if (delegateVerdict && chain.length === 0) {
    validationErrors.push("target_agent_chain is required for delegation");
  }
  if (invalidAgents.length > 0) {
    validationErrors.push(`unknown agents: ${invalidAgents.join(", ")}`);
  }
  // Tik HARD sekcijos privalomos; SOFT — žurnalas, niekada ne blokas.
  if (delegateVerdict && hasFatalSectionGap(decision.claude_task)) {
    validationErrors.push(`claude_task is missing required sections: ${outputMissing.hard.join(", ")}`);
  }
  // Task 872: sekcijų ANTRAŠTĖS advisory, bet TURINYS ne — context-pack ir biudžeto
  // enforcement reikalauja netuščių backtick allowed_paths ir checks.
  if (delegateVerdict && allowedPaths(decision.claude_task ?? "").length === 0) {
    validationErrors.push("claude_task has no parseable ## Failai / Leidžiama: backtick paths");
  }
  if (delegateVerdict && parseBacktickChecks(decision.claude_task ?? "").length === 0) {
    validationErrors.push("claude_task has no parseable ## Patikra backtick checks");
  }
  if (
    delegateVerdict &&
    input.activeChangeDirs.length > 0 &&
    !input.activeChangeDirs.some((ref) => decision.claude_task?.includes(ref))
  ) {
    validationErrors.push("claude_task must preserve the active OpenSpec source reference");
  }

  return {
    decision,
    delegateVerdict,
    validationErrors,
    softMissing: delegateVerdict ? outputMissing.soft : [],
    readmeGuardPrepended,
  };
}

/** Etalono „be # Task antraštės" apvyniojimas 1:1. */
export function wrapClaudeTask(claudeTask: string, chain: string[]): string {
  if (claudeTask.includes("# Task")) {
    return claudeTask;
  }
  const formattedChain = serializeAgentChain(chain);
  return `# Task

## Tikslas
Vykdyk tik vieną žemiau aprašytą darbą.

## Agentai
Privaloma agentų grandinė: ${formattedChain}

${claudeTask}`;
}
