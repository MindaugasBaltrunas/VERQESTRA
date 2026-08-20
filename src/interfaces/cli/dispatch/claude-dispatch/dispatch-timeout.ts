// Kanoninis Claude dispatch timeout šaltinis (etalonas: interfaces/cli/claude-dispatch/
// dispatch-timeout.ts; task 0033 — aritmetika gyvena application resolveDispatchTimeoutMs,
// čia tik env override sluoksnis ir „plačiausias langas, kai tier dar nežinomas").
// Non-Windows CLI argumentų builder'is persikėlė į infrastructure/adapters/
// claude-dispatch-delivery (ten gimsta realūs CLI argumentai).

import {
  resolveDispatchTimeoutMs,
  type DispatchTimeoutInput,
} from "../../../../application/token-governance/turn-budget.js";

/** Plačiausias langas, naudojamas, kai dispatch tier dar nežinomas. */
export const DEFAULT_CLAUDE_DISPATCH_TIMEOUT_MS = resolveDispatchTimeoutMs({ tier: "large" });

/** Vienintelis kanoninis Claude dispatch timeout šaltinis. */
export function claudeDispatchTimeoutMs(
  env: NodeJS.ProcessEnv = process.env,
  budget?: DispatchTimeoutInput,
): number {
  const raw = env["CLAUDE_DISPATCH_TIMEOUT_MS"];
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return budget ? resolveDispatchTimeoutMs(budget) : DEFAULT_CLAUDE_DISPATCH_TIMEOUT_MS;
}
