// Vykdymo adapterių galimybių deklaracijos (etalonas: AG_loop orchestrator/adapters/
// adapter-capabilities.ts 1:1). Deklaracijos yra dokumentuojamas kontraktas — jos leidžia
// kvietėjui (ir operatoriui) matyti, ką adapteris realiai daro, o ko dar ne, be kodo skaitymo.

import type { ExecutionAdapterKind } from "../../domain/agents/execution-port.js";

export type AdapterFeature =
  | "deterministic-noop"
  | "context-pack-input"
  | "policy-model-selection"
  | "external-agent-execution"
  | "structured-output";

export type AdapterCapabilityStatus = "implemented" | "future";

export type AdapterFeatureCapability = {
  feature: AdapterFeature;
  status: AdapterCapabilityStatus;
  notes: string;
};

export type AdapterCapabilityDeclaration = {
  adapter: ExecutionAdapterKind;
  summary: string;
  implemented: AdapterFeatureCapability[];
  future: AdapterFeatureCapability[];
};

function implemented(feature: AdapterFeature, notes: string): AdapterFeatureCapability {
  return { feature, status: "implemented", notes };
}

function future(feature: AdapterFeature, notes: string): AdapterFeatureCapability {
  return { feature, status: "future", notes };
}

export const adapterCapabilities: Record<ExecutionAdapterKind, AdapterCapabilityDeclaration> = {
  "dry-run": {
    adapter: "dry-run",
    summary: "Deterministic local adapter used for tests, previews, and safe workflow validation.",
    implemented: [
      implemented("deterministic-noop", "Completes without invoking an external agent or mutating product files."),
    ],
    future: [
      future("context-pack-input", "Does not currently inspect context-pack content beyond the shared request shape."),
      future("policy-model-selection", "Does not use model policy because no model is executed."),
      future("external-agent-execution", "Intentionally does not execute an external agent."),
      future("structured-output", "Returns a simple execution result without agent-produced structured output."),
    ],
  },
  codex: {
    adapter: "codex",
    summary: "Codex execution adapter for context-pack-driven implementation work when explicitly enabled.",
    implemented: [
      implemented("context-pack-input", "Requires context-pack content and passes it to the Codex CLI through stdin."),
      implemented("external-agent-execution", "Can run the Codex CLI when the adapter is explicitly enabled."),
    ],
    future: [
      future("deterministic-noop", "Disabled mode is inert, but enabled Codex execution is not a no-op."),
      future("policy-model-selection", "The current Codex invocation does not pass a policy-selected model."),
      future("structured-output", "No Codex-specific structured output contract is parsed yet."),
    ],
  },
  claude: {
    adapter: "claude",
    summary: "Claude execution adapter for model-policy-selected agent runs when explicitly enabled.",
    implemented: [
      implemented("context-pack-input", "Requires context-pack content and passes it to the Claude CLI through stdin."),
      implemented("policy-model-selection", "Requires the caller to provide a selected model."),
      implemented("external-agent-execution", "Can run the Claude CLI when the adapter is explicitly enabled."),
      implemented("structured-output", "Parses JSON stdout into structuredOutput when the agent returns valid JSON."),
    ],
    future: [
      future("deterministic-noop", "Disabled mode is inert, but enabled Claude execution is not a no-op."),
    ],
  },
};

export function listAdapterCapabilityDeclarations(): AdapterCapabilityDeclaration[] {
  return Object.keys(adapterCapabilities)
    .sort()
    .map((adapter) => adapterCapabilities[adapter as ExecutionAdapterKind]);
}

export function getAdapterCapabilityDeclaration(adapter: ExecutionAdapterKind): AdapterCapabilityDeclaration {
  return adapterCapabilities[adapter];
}
