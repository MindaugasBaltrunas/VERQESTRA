// Dispatch pristatymo pusė (etalonai: interfaces/cli/claude-dispatch/dispatch-timeout.ts
// argumentų builder'is + execution-context.ts resolveDispatchPromptDelivery +
// dispatch-tool-schema.ts profilis). Infrastructure, nes čia gimsta realūs Claude CLI
// argumentai ir `--disallowed-tools` interpoliacija — application žino tik gate/prompt
// turinį (task-execution/execution-context-gate).

import {
  buildDispatchDisallowedTools,
  claudeDispatchDisallowedToolsArgs,
  claudeMaxTurnsArgs,
  dispatchDisallowedToolCandidates,
  type DispatchToolPolicyDecision,
} from "./claude-tool-schema.js";
import type { DispatchMcpCapabilities } from "../../application/context-pack/mcp-capability-registry.js";
import { AGENT_ROUTING_TOOLS } from "../../application/policy-governance/agent-policy.js";
import { loadToolBudget, selectToolBudget } from "../../application/policy-governance/tool-budget-config.js";
import type { PolicyConfigFileSystemPort } from "../../application/policy-governance/ports.js";

/** Grynas non-Windows Claude CLI argumentų konstruktorius; prompt perduodamas per stdin. */
export function nonWindowsClaudeDispatchArgs(
  model: string,
  maxTurns?: number,
  disallowedTools: readonly string[] = [],
): string[] {
  return [
    "-p",
    "--verbose",
    "--permission-mode",
    "auto",
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--include-hook-events",
    "--model",
    model,
    ...claudeMaxTurnsArgs(maxTurns),
    ...claudeDispatchDisallowedToolsArgs(disallowedTools),
  ];
}

/**
 * Kaip kanoninis prompt'as pasiekia workerį konkrečioje platformoje. Abi šakos neša TĄ PATĮ
 * `prompt` lauką — platform parity įrodymas: prompt'as niekada nekeliauja argv masyve, o
 * Windows kelias jį perduoda per failą, kurį launcher'is skaito `Get-Content -Raw`.
 */
export type DispatchPromptDelivery =
  | {
      platform: "windows";
      transport: "prompt-file";
      shell: string;
      promptPath: string;
      prompt: string;
      /** Task 0005: profilis matomam paleidikliui; tuščias = komanda nepakitusi. */
      disallowedTools: readonly string[];
    }
  | { platform: "posix"; transport: "stdin"; command: string; args: string[]; prompt: string };

export function resolveDispatchPromptDelivery(input: {
  powerShellCommand?: string;
  promptPath: string;
  model: string;
  maxTurns?: number;
  prompt: string;
  /** Task 0028: `--disallowed-tools` profilis; tuščias = argumentai nepakitę. */
  disallowedTools?: readonly string[];
}): DispatchPromptDelivery {
  if (input.powerShellCommand) {
    return {
      platform: "windows",
      transport: "prompt-file",
      shell: input.powerShellCommand,
      promptPath: input.promptPath,
      prompt: input.prompt,
      disallowedTools: input.disallowedTools ?? [],
    };
  }
  return {
    platform: "posix",
    transport: "stdin",
    command: "claude",
    args: nonWindowsClaudeDispatchArgs(input.model, input.maxTurns, input.disallowedTools ?? []),
    prompt: input.prompt,
  };
}

// ---------------------------------------------------------------------------
// Task 0028: dispatch tool schemų profilis — sprendimas VIENOJE grynoje funkcijoje.
// ---------------------------------------------------------------------------

export type DispatchToolSchemaMode =
  /** `dispatch_tool_schema` išjungtas — CLI argumentai baitas į baitą kaip iki 0028. */
  | "off"
  /** Profilis sudarytas ir pritaikytas CLI argumentuose. */
  | "applied"
  /** Flag'as įjungtas, bet biudžeto politika nieko nedraudžia (arba viską dengia grindys). */
  | "no-candidates"
  /** Transportas savybės neperduoda — profilis tik apskaičiuotas (būsimoms savybėms). */
  | "unsupported-transport"
  /** CLI flag'o nepalaikė — kvietimas pakartotas be jo. */
  | "cli-fallback";

export type DispatchToolSchemaProfile = {
  mode: DispatchToolSchemaMode;
  /** Ką politika sudarė (net jei transport'as nepritaikė) — A/B įrodymui. */
  candidates: string[];
  /** Ką REALIAI gavo CLI. Tuščias visur, išskyrus `applied`. */
  applied: string[];
  reason: string;
};

/**
 * Task 0041: kai biudžetas MCP šeimą draudžia, bet pjūvis nežinomas — SĄMONINGAS fail-open
 * su įvardinta priežastimi, ne tyliai tuščias sąrašas.
 */
function mcpFailOpenNote(policy: DispatchToolPolicyDecision, mcp: DispatchMcpCapabilities): string {
  return policy.mcp === false && !mcp.known ? `; mcp schemas left uncompressed (${mcp.source})` : "";
}

export function resolveDispatchToolSchemaProfile(input: {
  enabled: boolean;
  platform: "windows" | "posix";
  policy: DispatchToolPolicyDecision;
  /** Deterministinis, task-lokalus MCP pjūvis (registras/snapshot — ne praeitos sesijos log'as). */
  mcp: DispatchMcpCapabilities;
  /** Grindys virš DISPATCH_BASELINE_TOOLS; numatytai — agentų maršrutizavimo įrankiai. */
  protectedTools?: readonly string[];
}): DispatchToolSchemaProfile {
  if (!input.enabled) {
    return { mode: "off", candidates: [], applied: [], reason: "dispatch_tool_schema disabled" };
  }
  const candidates = buildDispatchDisallowedTools({
    candidates: dispatchDisallowedToolCandidates(input.policy, input.mcp),
    protectedTools: input.protectedTools ?? AGENT_ROUTING_TOOLS,
  });
  const mcpNote = mcpFailOpenNote(input.policy, input.mcp);
  if (candidates.length === 0) {
    return {
      mode: "no-candidates",
      candidates,
      applied: [],
      reason: `tool budget forbids no removable tool family${mcpNote}`,
    };
  }
  // Task 0005: abu keliai (`createVisibleClaudeLauncher` ir POSIX args) `--disallowed-tools`
  // perduoda — platforma profilio taikymui įtakos nebeturi.
  return {
    mode: "applied",
    candidates,
    applied: candidates,
    reason: `policy-backed dispatch tool profile${mcpNote}`,
  };
}

/** Biudžeto profilio sprendimas apie web/research/MCP šeimas. Klaida → nieko nedraudžiame. */
export async function loadDispatchToolPolicyDecision(
  fs: PolicyConfigFileSystemPort,
  runtimeRoot: string,
): Promise<DispatchToolPolicyDecision> {
  try {
    const profile = selectToolBudget(await loadToolBudget(fs, runtimeRoot), "default");
    return { browser: profile.browser, scraper: profile.scraper, mcp: profile.mcp };
  } catch {
    // Trūkstamas/sugadintas biudžetas negali NIEKO uždrausti: fail-safe kryptis —
    // „palikti visas schemas", o ne spėti politiką.
    return {};
  }
}
