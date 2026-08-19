// Agent policy DEFAULTS — grynas vaidmenų registro etalonas. Parse su zod schema
// (parseAgentPolicy) lieka E3 config sluoksnyje (domain be zod; WBR pataisa: defaults
// atskirti nuo parse). Behaviour etalon: AG_loop policy/agent-policy.ts.

import type { AgentPolicy } from "./agent-selection.js";

export const defaultAgentPolicy: AgentPolicy = {
  version: "1.0.0",
  default_role: "coder",
  roles: {
    "readme-guard": { allowed_adapters: ["claude"], default_model_hint: "haiku", can_write_code: false },
    architect: { allowed_adapters: ["claude"], default_model_hint: "opus", can_write_code: false, requires_human_review_for_global_changes: true },
    "data-model": { allowed_adapters: ["claude", "codex"], default_model_hint: "sonnet", can_write_code: true },
    migrator: { allowed_adapters: ["claude"], default_model_hint: "sonnet", can_write_code: true, requires_human_review_for_global_changes: true },
    "schedule-domain": { allowed_adapters: ["claude", "codex"], default_model_hint: "sonnet", can_write_code: true },
    coder: { allowed_adapters: ["claude", "codex"], default_model_hint: "sonnet", can_write_code: true },
    reviewer: { allowed_adapters: ["claude"], default_model_hint: "sonnet", can_write_code: false },
    security: { allowed_adapters: ["claude"], default_model_hint: "opus", can_write_code: false },
    tester: { allowed_adapters: ["claude", "codex"], default_model_hint: "sonnet", can_write_code: true },
    i18n: { allowed_adapters: ["claude"], default_model_hint: "haiku", can_write_code: true },
    performance: { allowed_adapters: ["claude"], default_model_hint: "sonnet", can_write_code: true },
    debugger: { allowed_adapters: ["claude"], default_model_hint: "sonnet", can_write_code: true },
    documenter: { allowed_adapters: ["claude"], default_model_hint: "haiku", can_write_code: false },
    supervisor: { allowed_adapters: ["claude"], default_model_hint: "opus", can_write_code: false },
    repairer: { allowed_adapters: ["claude", "codex"], default_model_hint: "sonnet", can_write_code: true, max_attempts: 3 },
    "audit-director": { allowed_adapters: ["claude"], default_model_hint: "opus", can_write_code: true, max_attempts: 3 },
  },
};

/**
 * Įrankiai, kurių reikia PAČIAM agentų maršrutizavimui, ne konkrečiam agento darbui.
 * Sąrašas yra APSAUGA, ne leidimas: jis nieko neįjungia, tik neleidžia jokiam schemų
 * mažinimo profiliui šių įrankių pašalinti (ypač `Task` — vieno cohorto telemetrija,
 * kurioje jis nepanaudotas, NĖRA įrodymas, kad grandinei jo nereikia).
 */
export const AGENT_ROUTING_TOOLS: readonly string[] = ["Task", "Skill", "SlashCommand", "TodoWrite"];
