// Vienoje vietoje suderinti turn, wall-clock ir mid-dispatch tokenų biudžetai (etalonas:
// interfaces/cli/claude-dispatch/dispatch-budget-plan.ts). Konfigai skaitomi per
// PolicyConfigFileSystemPort; failas skaitomas VIENĄ kartą — `values` yra tai, ką konfigas
// realiai deklaravo (legacy sluoksniui), o mergePreflightLimits prideda default'us.

import {
  mergePreflightLimits,
  readPreflightLimitsFile,
} from "../../../../application/policy-governance/preflight-limits-policy.js";
import type { PolicyConfigFileSystemPort } from "../../../../application/policy-governance/ports.js";
import {
  loadTokenBudgetConfig,
  resolveMidDispatchTokenLimit,
} from "../../../../application/token-governance/token-budget-config.js";
import { resolveDispatchTurnTier } from "../../../../application/token-governance/token-budget-optimizer.js";
import { resolveMaxTurns, type TurnBudgetPhase } from "../../../../application/token-governance/turn-budget.js";
import {
  publishedTokenBudgetTier,
  type PublishedTierDecision,
} from "../../../../application/task-execution/execution-context-gate.js";
import { claudeDispatchTimeoutMs } from "./dispatch-timeout.js";

type TaskMetrics = Parameters<typeof resolveDispatchTurnTier>[0]["metrics"];

export type DispatchBudgetPlanInput = {
  runtimeRoot: string;
  taskId: string;
  decision: PublishedTierDecision;
  taskMetrics: TaskMetrics;
  phase: TurnBudgetPhase;
  reduceContextReasons: readonly string[];
  remainingTaskTokens: number | null;
  policyFs: PolicyConfigFileSystemPort;
  env?: NodeJS.ProcessEnv;
};

/** Vienoje vietoje suderina turn, wall-clock ir mid-dispatch tokenų biudžetus. */
export async function resolveDispatchBudgetPlan(input: DispatchBudgetPlanInput) {
  const preflightLimitsFile = await readPreflightLimitsFile(input.policyFs, input.runtimeRoot);
  const preflightLimits = mergePreflightLimits(preflightLimitsFile.values);
  const tokenBudget = await loadTokenBudgetConfig(input.policyFs, input.runtimeRoot, {
    ...(preflightLimitsFile.values.turnLimits === undefined
      ? {}
      : { legacyTurnLimits: preflightLimitsFile.values.turnLimits }),
  });
  const publishedTier = publishedTokenBudgetTier(input.decision, input.taskId);
  const turnTier = resolveDispatchTurnTier({
    ...(publishedTier === undefined ? {} : { publishedTier }),
    metrics: input.taskMetrics,
    reduceContextReasons: input.reduceContextReasons,
  });
  const dispatchMaxTurns = resolveMaxTurns({
    phase: input.phase,
    tier: turnTier.tier,
    limits: tokenBudget.turnLimits,
    ceiling: preflightLimits.dispatchMaxTurns,
  });
  const dispatchTimeoutMs = claudeDispatchTimeoutMs(input.env ?? process.env, {
    tier: turnTier.tier,
    phase: input.phase,
    limits: tokenBudget.turnLimits,
    perTurnAllowanceMs: tokenBudget.perTurnWallclockAllowanceMs,
    overheadMs: tokenBudget.dispatchTimeoutOverheadMs,
  });
  const midDispatchLimit = resolveMidDispatchTokenLimit({
    maxDispatchBillableTokens: tokenBudget.maxDispatchBillableTokens,
    remainingTaskTokens: input.remainingTaskTokens,
  });

  return {
    tokenBudget,
    dispatchMaxTurns,
    dispatchTimeoutMs,
    midDispatchLimit,
    turnLog:
      `DISPATCH TURN BUDGET: task=${input.taskId} phase=${input.phase} tier=${turnTier.tier} source=${turnTier.sourceLabel} ` +
      (turnTier.source === "reduced" ? `base_tier=${turnTier.baseTier} base_source=${turnTier.baseSource} ` : "") +
      `max_turns=${dispatchMaxTurns || "none"} timeout_ms=${dispatchTimeoutMs} ` +
      `budget_source=${turnTier.tier}:${tokenBudget.sources[turnTier.tier]},` +
      `perTurn:${tokenBudget.sources.perTurnWallclockAllowanceMs},` +
      `overhead:${tokenBudget.sources.dispatchTimeoutOverheadMs}`,
    tokenLog:
      `DISPATCH TOKEN BUDGET: task=${input.taskId} phase=${input.phase} limit=${midDispatchLimit.limit} ` +
      `limit_source=${midDispatchLimit.source} ` +
      `budget_source=maxDispatchBillableTokens:${tokenBudget.sources.maxDispatchBillableTokens} ` +
      `raw_ceiling=${tokenBudget.maxDispatchTokens} ` +
      `raw_ceiling_source=${tokenBudget.sources.maxDispatchTokens} ` +
      `remaining_task_tokens=${input.remainingTaskTokens ?? "none"}`,
  };
}
