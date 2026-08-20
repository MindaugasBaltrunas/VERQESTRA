// Vienas provider-neutralus maršruto sprendimas + jo modelio atvaizdavimas (etalonas:
// interfaces/cli/claude-dispatch/dispatch-routing-plan.ts). `routeModel` gryna
// (application); provider vertimas (tier -> Claude modelio ID) ateina per portus —
// kompozicija juos suriša su infrastructure claude-model-env.

import { measureTaskSize } from "../../../../application/quality-gates/preflight-fastpath.js";
import {
  loadRoutingPolicy,
  routeModel,
  type RoutingTier,
} from "../../../../application/token-governance/route-model.js";
import type { LlmCallAuthorization } from "../../../../application/token-governance/tool-budget-gates.js";
import type { PolicyConfigFileSystemPort } from "../../../../application/policy-governance/ports.js";

export type DispatchRoutingModelPorts = {
  /** Supervisor `selected_model` → neutrali pakopa (claude-model-env routingTierOfSelection). */
  routingTierOfSelection(selected: string): RoutingTier;
  /** Neutrali pakopa → provider pakopos vardas žurnalui (modelTierOfRoutingTier). */
  modelTierOfRoutingTier(tier: RoutingTier): string;
  /** Neutrali pakopa → realus modelio ID su saugos validacija (resolveRoutedModel). */
  resolveRoutedModel(tier: RoutingTier): Promise<string>;
};

export type ResolveDispatchRoutingPlanInput = {
  runtimeRoot: string;
  taskId: string;
  taskText: string;
  phase: "implementation" | "repair";
  decision: { selected_model?: string };
  selectedModel: string;
  failedAttempts: number;
  authorization: LlmCallAuthorization;
  policyFs: PolicyConfigFileSystemPort;
  models: DispatchRoutingModelPorts;
  /** Persist'intas projekto profilis (source_roots dydžio metrikoms) arba undefined. */
  projectProfile?: { source_roots?: string[] } | undefined;
  logDispatch(line: string): Promise<void>;
};

/** Sudaro vieną provider-neutralų maršruto sprendimą ir jo Claude modelio atvaizdavimą. */
export async function resolveDispatchRoutingPlan(input: ResolveDispatchRoutingPlanInput) {
  const taskMetrics = measureTaskSize(input.taskText, input.projectProfile?.source_roots);
  const routingPolicy = await loadRoutingPolicy(input.policyFs, input.runtimeRoot);
  const routing = routeModel({
    phase: input.phase,
    taskText: input.taskText,
    // Default'inis logų `selectedModel` nėra explicit supervisor pasirinkimas.
    ...(input.decision.selected_model
      ? { selectedTier: input.models.routingTierOfSelection(input.decision.selected_model) }
      : {}),
    failedAttempts: input.failedAttempts,
    size: {
      lines: taskMetrics.lines,
      allowedPaths: taskMetrics.allowedPaths,
      domains: taskMetrics.domains,
      actionBullets: taskMetrics.actionBullets,
    },
    budget: {
      reduceContext: input.authorization.reduce_context,
      remainingTotalLlmCalls: input.authorization.remaining_total_llm_calls,
      remainingTotalTokens: input.authorization.remaining_total_tokens,
      totalLlmCalls: input.authorization.total_llm_calls,
    },
    policy: routingPolicy,
  });
  const effectiveTier = input.models.modelTierOfRoutingTier(routing.tier);
  const claudeModel = await input.models.resolveRoutedModel(routing.tier);
  await input.logDispatch(
    `MODEL ROUTING: task=${input.taskId} phase=${input.phase} selected=${input.selectedModel} ` +
      `base=${routing.base_tier} tier=${routing.tier} model=${claudeModel} ` +
      `failed_attempts=${input.failedAttempts} reason=${routing.reason} policy=${routing.policy_hash}`,
  );
  if (routing.tier !== routing.base_tier) {
    await input.logDispatch(
      `MODEL ESCALATION: task=${input.taskId} selected=${input.selectedModel} ` +
        `failed_attempts=${input.failedAttempts} escalated_to=${effectiveTier}`,
    );
  }
  return { taskMetrics, routing, effectiveTier, claudeModel };
}
