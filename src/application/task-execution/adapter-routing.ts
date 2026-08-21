// Dispatch adapter routing decision: given a task's `## Agentai` block and the agent
// policy, resolves which execution adapter (dry-run/codex/claude) a dispatch may use.
//
// This is the ONE canonical routing service for both dispatch paths (etalono task 889):
// the manual dispatch CLI resolves its `--adapter` value through `resolveDispatchAdapter`,
// and the production loop gates every claude-dispatch through `resolveLoopDispatchAdapter`
// before launching. Adapterio tipas yra domain/policies `AgentAdapterKind` — atskiro
// execution-port tipo VERQESTRA nedubliuoja (dubliai jungiami, ne kopijuojami).
import {
  ADAPTERS,
  effectiveAgentRole,
  parseAgentBlock,
  type AgentAdapterKind,
  type AgentPolicy,
} from "../../domain/policies/agent-selection.js";

export type DispatchAdapterDecision = {
  role: string;
  allowedAdapters: AgentAdapterKind[];
  adapter: AgentAdapterKind;
};

/**
 * Resolves the execution adapter for a dispatch request. `requestedAdapter` is the
 * caller's raw `--adapter` value (already defaulted to "dry-run" by the CLI when
 * absent); `"auto"` resolves to the task role's first allowed adapter. Throws when the
 * requested adapter is unknown, or when the task declares an `## Agentai` block and
 * requests a non-dry-run adapter the resolved role does not allow.
 */
export function resolveDispatchAdapter(
  taskText: string,
  policy: AgentPolicy,
  requestedAdapter: string,
): DispatchAdapterDecision {
  const role = effectiveAgentRole(parseAgentBlock(taskText), policy);
  const allowedAdapters = policy.roles[role]?.allowed_adapters ?? ["claude"];
  const hasAgentBlock = /^##\s*Agentai\b/im.test(taskText);

  let adapter = requestedAdapter;
  if (adapter === "auto") adapter = allowedAdapters[0] ?? "claude";
  if (!isAgentAdapterKind(adapter)) {
    throw new Error("Unknown execution adapter: " + adapter);
  }
  if (adapter !== "dry-run" && hasAgentBlock && !allowedAdapters.includes(adapter)) {
    throw new Error(
      `Adapteris '${adapter}' neleistinas vaidmeniui '${role}' (leistini: ${allowedAdapters.join(", ")})`,
    );
  }
  return { role, allowedAdapters, adapter };
}

/**
 * Loop-path routing gate (etalono task 889): the production loop always executes through
 * `claude-dispatch`, so the requested adapter is fixed to "claude". Throws when the
 * task's `## Agentai` role does not allow the claude adapter — the caller routes
 * that task to human-review instead of dispatching it with a forbidden adapter.
 * Today every configured role allows "claude", so this is a guard against future
 * policy drift, not a behavior change.
 */
export function resolveLoopDispatchAdapter(taskText: string, policy: AgentPolicy): DispatchAdapterDecision {
  return resolveDispatchAdapter(taskText, policy, "claude");
}

function isAgentAdapterKind(value: string): value is AgentAdapterKind {
  return (ADAPTERS as string[]).includes(value);
}
