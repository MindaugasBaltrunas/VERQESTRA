// Dispatch pristatymo pusė (etalonai: interfaces/cli/claude-dispatch/dispatch-timeout.ts
// argumentų builder'is + execution-context.ts resolveDispatchPromptDelivery +
// dispatch-tool-schema.ts profilis). Infrastructure, nes čia gimsta realūs Claude CLI
// argumentai ir `--disallowed-tools` interpoliacija — application žino tik gate/prompt
// turinį (task-execution/execution-context-gate).

import {
  buildDispatchDisallowedTools,
  claudeDispatchDisallowedToolsArgs,
  claudeMaxTurnsArgs,
  DISPATCH_BASELINE_TOOLS,
  dispatchDisallowedToolCandidates,
  type DispatchToolPolicyDecision,
} from "./claude-tool-schema.js";
import type { DispatchMcpCapabilities } from "../../application/context-pack/mcp-capability-registry.js";
import { AGENT_ROUTING_TOOLS, DISPATCH_SESSION_PACING_TOOLS } from "../../application/policy-governance/agent-policy.js";
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
  /** `dispatch_tool_schema` išjungtas — jokių biudžeto kandidatų (pacing draudimas lieka). */
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
  /** Ką BIUDŽETO politika sudarė (be visada galiojančio pacing draudimo) — A/B įrodymui. */
  candidates: string[];
  /**
   * Ką REALIAI gavo CLI: biudžeto kandidatai + DISPATCH_SESSION_PACING_TOOLS. Pacing dalis
   * yra kiekviename režime (2026-08-27 „no write-tool calls" incidentas), tad tuščias
   * `applied` lieka tik `cli-fallback` atveju.
   */
  applied: string[];
  reason: string;
  /**
   * Task 036-c-04: shadow matavimas — kiek `--disallowed-tools` KEISTŲ schemos dydį, jei
   * profilis būtų pritaikytas. Skaičiuojama VISIEMS režimams (net `mode: "off"`), kad
   * matavimas gyventų nepriklausomai nuo to, ar dispatch_tool_schema faktiškai įjungtas.
   * `candidates`/`applied` šis laukas NEKEIČIA nė vienu simboliu — grynai stebėjimas.
   */
  shadow?: { fullChars: number; reducedChars: number };
};

/**
 * Task 0041: kai biudžetas MCP šeimą draudžia, bet pjūvis nežinomas — SĄMONINGAS fail-open
 * su įvardinta priežastimi, ne tyliai tuščias sąrašas.
 */
function mcpFailOpenNote(policy: DispatchToolPolicyDecision, mcp: DispatchMcpCapabilities): string {
  return policy.mcp === false && !mcp.known ? `; mcp schemas left uncompressed (${mcp.source})` : "";
}

/**
 * Task 036-c-04: shadow pora (pilnos vs sumažintos schemos dydis). VARDAIS grįstas proxy —
 * registre schemų KŪNŲ nėra, tad dydis matuojamas iš įrankių vardų inventoriaus
 * (`DISPATCH_BASELINE_TOOLS` ∪ šio dispatch'o MCP pjūvis), ne iš realių JSON schemų.
 * `known === false` reiškia „MCP pjūvis neautoritetingas" — pora lieka `undefined`,
 * niekada apsimestinis `0`.
 */
function dispatchToolSchemaShadow(
  mcp: DispatchMcpCapabilities,
  applied: readonly string[],
): { fullChars: number; reducedChars: number } | undefined {
  if (!mcp.known) return undefined;
  const inventory = sortedUniqueTools([...DISPATCH_BASELINE_TOOLS, ...mcp.tools]);
  const appliedSet = new Set(applied);
  const reduced = inventory.filter((tool) => !appliedSet.has(tool));
  return { fullChars: JSON.stringify(inventory).length, reducedChars: JSON.stringify(reduced).length };
}

function sortedUniqueTools(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
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
  const protectedTools = input.protectedTools ?? AGENT_ROUTING_TOOLS;
  // Visada galiojanti dalis: sesijos pacing įrankiai (žr. DISPATCH_SESSION_PACING_TOOLS).
  // Ji eina per tą patį floor filtrą, kad grindų kontraktas liktų vienas.
  const pacingBan = buildDispatchDisallowedTools({ candidates: DISPATCH_SESSION_PACING_TOOLS, protectedTools });
  if (!input.enabled) {
    const shadow = dispatchToolSchemaShadow(input.mcp, pacingBan);
    return {
      mode: "off",
      candidates: [],
      applied: pacingBan,
      reason: "dispatch_tool_schema disabled; session pacing tools still disallowed",
      ...(shadow !== undefined ? { shadow } : {}),
    };
  }
  const candidates = buildDispatchDisallowedTools({
    candidates: dispatchDisallowedToolCandidates(input.policy, input.mcp),
    protectedTools,
  });
  const mcpNote = mcpFailOpenNote(input.policy, input.mcp);
  if (candidates.length === 0) {
    const shadow = dispatchToolSchemaShadow(input.mcp, pacingBan);
    return {
      mode: "no-candidates",
      candidates,
      applied: pacingBan,
      reason: `tool budget forbids no removable tool family${mcpNote}`,
      ...(shadow !== undefined ? { shadow } : {}),
    };
  }
  // Task 0005: abu keliai (`createVisibleClaudeLauncher` ir POSIX args) `--disallowed-tools`
  // perduoda — platforma profilio taikymui įtakos nebeturi.
  const appliedTools = buildDispatchDisallowedTools({ candidates: [...candidates, ...pacingBan], protectedTools });
  const shadow = dispatchToolSchemaShadow(input.mcp, appliedTools);
  return {
    mode: "applied",
    candidates,
    applied: appliedTools,
    reason: `policy-backed dispatch tool profile${mcpNote}`,
    ...(shadow !== undefined ? { shadow } : {}),
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
