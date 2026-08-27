// Agentų politikos KONFIGO pusė: zod schema + loader'is. Grynos taisyklės ir defaults
// gyvena domain/policies (VQ-203). Behaviour etalon: AG_loop policy/agent-policy.ts.

import path from "node:path";
import { z } from "zod";
import { parseWithSchema } from "../../shared/schema.js";
import {
  ADAPTERS,
  MODEL_HINTS,
  type AgentAdapterKind,
  type AgentModelHint,
  type AgentPolicy,
} from "../../domain/policies/agent-selection.js";
import { defaultAgentPolicy } from "../../domain/policies/agent-policy-defaults.js";
import type { PolicyConfigFileSystemPort } from "./ports.js";

// E5 VQ-501 (2/5-d): dispatch tool profilio GRINDYS virš DISPATCH_BASELINE_TOOLS —
// agentų maršrutizavimo įrankiai niekada nepatenka į `--disallowed-tools` kandidatus
// (etalono policy/agent-policy.ts konstanta 1:1; be jų grandinės vykdytojas negalėtų
// paleisti sub-agentų).
export const AGENT_ROUTING_TOOLS: readonly string[] = ["Task", "Skill", "SlashCommand", "TodoWrite"];

// 2026-08-27 incidentas: keturi taskai iš eilės (041, 041-a, 042, 042-a) parkuoti
// „executor made no write-tool calls" — worker'is grandinę paleido fone ir sesiją užbaigė
// „laukdamas" per ScheduleWakeup (3–11 turns, nė vieno Write/Edit). Vienkartiniame headless
// dispatch bėgime sesijos stabdymo/atidėjimo įrankiai neturi jokio teisėto panaudojimo:
// ScheduleWakeup atideda darbą turn'ui, kuris niekada neateis; CronCreate kuria darbus už
// bėgimo ribų; EnterPlanMode laukia patvirtinimo, kurio headless režime nėra kam duoti.
// Draudimas galioja VISADA, nepriklausomai nuo dispatch_tool_schema A/B — tai korektiškumo,
// ne kompresijos politika (abi kohortos jį gauna vienodai, tad A/B palyginimo neiškreipia).
export const DISPATCH_SESSION_PACING_TOOLS: readonly string[] = ["CronCreate", "EnterPlanMode", "ScheduleWakeup"];

// Built-in roles remain a documented compatibility vocabulary. Project-local agents are
// intentionally dynamic and use the same safe identifier format as their
// `.claude/agents/<role>.md` file name.
export const agentRoleIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]*$/, "agent role must start with a lowercase letter and contain only lowercase letters, digits, or hyphens");

const agentRoleConfigSchema = z.object({
  allowed_adapters: z.array(z.enum(ADAPTERS as [AgentAdapterKind, ...AgentAdapterKind[]])).min(1),
  default_model_hint: z.enum(MODEL_HINTS as [AgentModelHint, ...AgentModelHint[]]),
  can_write_code: z.boolean(),
  enabled: z.boolean().optional(),
  max_attempts: z.number().int().positive().optional(),
  requires_human_review_for_global_changes: z.boolean().optional(),
});

const agentPolicySchema = z.object({
  version: z.string().refine((value) => value.trim().length > 0, "version is required"),
  default_role: z.unknown().transform((value) => (typeof value === "string" ? value : "coder")),
  // Roles are project-local extensions; built-ins are not a closed vocabulary.
  roles: z.record(z.string(), agentRoleConfigSchema).superRefine((roles, ctx) => {
    const invalid = Object.keys(roles).filter((role) => !agentRoleIdSchema.safeParse(role).success);
    if (invalid.length > 0) {
      ctx.addIssue({ code: "custom", message: `invalid agent role id(s): ${invalid.join(", ")}` });
    }
  }),
});

export function parseAgentPolicy(value: unknown, label = "agent policy"): AgentPolicy {
  const parsed = parseWithSchema(agentPolicySchema, value, label);
  if (!Object.prototype.hasOwnProperty.call(parsed.roles, parsed.default_role)) {
    throw new Error(`Invalid ${label}: default_role '${parsed.default_role}' not in roles`);
  }
  if (parsed.roles[parsed.default_role]?.enabled === false) {
    throw new Error(`Invalid ${label}: default_role '${parsed.default_role}' cannot be disabled`);
  }
  return parsed;
}

export function agentPolicyConfigPath(runtimeRoot: string): string {
  return path.join(runtimeRoot, "config", "agents.json");
}

export async function loadAgentPolicy(fs: PolicyConfigFileSystemPort, runtimeRoot: string): Promise<AgentPolicy> {
  const policyPath = agentPolicyConfigPath(runtimeRoot);
  const raw = await fs.readTextFileIfExists(policyPath);
  if (raw === undefined) {
    return defaultAgentPolicy;
  }
  return parseAgentPolicy(JSON.parse(raw), policyPath);
}
