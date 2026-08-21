// Tool-budget KONFIGO pusė: schema, loader'is su deprecation pranešimu ir profilio
// parinkimas. Behaviour etalon: AG_loop policy/tool-budget.ts (konfigo pusė) +
// core/schema.ts toolBudget blokas. Ledger'io vartai (enforceExecutionBudget,
// authorizeLlmCall, resets) — VQ-305 token-governance dalis, atvyks su token-usage
// žurnalo portais.

import path from "node:path";
import { z } from "zod";
import { parseWithSchema } from "../../shared/schema.js";
import type { PolicyConfigFileSystemPort } from "./ports.js";

const positiveLimit = z.number().int().positive();

/** Per-phase hard limits for one canonical task phase (task 1103, spec TOK-2). */
export const taskPhaseBudgetSchema = z
  .object({
    max_llm_calls: positiveLimit.optional(),
    /**
     * Fazės BILLABLE tokenų lubos: `input + output + cache_creation`, BE `cache_read`.
     * Kanoninis raktas nuo 0000-0a; RAW suma (su cache read) į kietą sprendimą nebeįeina.
     */
    max_billable_tokens: positiveLimit.optional(),
    /**
     * Legacy to paties limito vardas. Interpretuojamas kaip BILLABLE riba (reikšmė
     * nekeičiama, keičiasi MATAVIMO vienetas); pirmą kartą perskaitytas palieka WARNING
     * eilutę — žr. {@link deprecatedTokenCeilingKeys}. Abiem raktams esant laimi griežtesnis.
     */
    max_tokens: positiveLimit.optional(),
  })
  .passthrough();
export type TaskPhaseBudget = z.infer<typeof taskPhaseBudgetSchema>;

export const toolBudgetProfileSchema = z
  .object({
    browser: z.boolean().default(false),
    scraper: z.boolean().default(false),
    mcp: z.boolean().default(false),
    // Migracijos kontraktas (task 1103): `max_llm_calls` ir toliau yra implementacijos
    // (dispatch + repair dispatch) kvietimų riba vienam task_id. Whole-task valdymas —
    // ŠALIA jos naujais optional laukais.
    max_llm_calls: positiveLimit.optional(),
    /** Visų fazių LLM kvietimų riba vienam task'ui. */
    max_total_llm_calls: positiveLimit.optional(),
    /** Visų fazių BILLABLE tokenų riba vienam task'ui (kanoninis raktas nuo 0000-0a). */
    max_total_billable_tokens: positiveLimit.optional(),
    /** Legacy to paties limito vardas — žr. {@link deprecatedTokenCeilingKeys}. */
    max_total_tokens: positiveLimit.optional(),
    /**
     * Fazių limitai. Raktas — canonical arba legacy fazės vardas. `z.record(z.string(), …)`
     * sąmoningai: zod 4 enum-raktų record'as reikalauja VISŲ raktų, o fazių limitai daliniai.
     */
    phase_limits: z.record(z.string(), taskPhaseBudgetSchema).optional(),
    max_context_chars: positiveLimit.optional(),
    max_files: positiveLimit.optional(),
    max_pages: positiveLimit.optional(),
  })
  .passthrough();
export type ToolBudgetProfile = z.infer<typeof toolBudgetProfileSchema>;

export const toolBudgetSchema = z
  .object({
    default: toolBudgetProfileSchema,
    research: toolBudgetProfileSchema.optional(),
    security: toolBudgetProfileSchema.optional(),
  })
  .passthrough();
export type ToolBudget = z.infer<typeof toolBudgetSchema>;

export type ToolBudgetName = "default" | "research" | "security";

export function toolBudgetConfigPath(runtimeRoot: string): string {
  return path.join(runtimeRoot, "config", "tool-budget.json");
}

/** Legacy token-lubų raktų pranešimų kanalas. */
export type ToolBudgetDeprecationSink = (message: string) => void;

/**
 * Kurie profiliai vis dar naudoja legacy raktus, deterministine tvarka
 * (`<profilis>.max_total_tokens`, `<profilis>.phase_limits.<raktas>.max_tokens`).
 * Tikrinamas rakto BUVIMAS, ne reikšmės truthiness.
 */
export function deprecatedTokenCeilingKeys(budget: ToolBudget): string[] {
  const found: string[] = [];
  for (const [profileName, profile] of Object.entries(budget as Record<string, unknown>)) {
    if (!profile || typeof profile !== "object") continue;
    const raw = profile as Record<string, unknown>;
    if (Object.hasOwn(raw, "max_total_tokens")) found.push(`${profileName}.max_total_tokens`);
    const phaseLimits = raw["phase_limits"];
    if (!phaseLimits || typeof phaseLimits !== "object") continue;
    for (const [phaseKey, limit] of Object.entries(phaseLimits as Record<string, unknown>)) {
      if (limit && typeof limit === "object" && Object.hasOwn(limit, "max_tokens")) {
        found.push(`${profileName}.phase_limits.${phaseKey}.max_tokens`);
      }
    }
  }
  return found;
}

/**
 * Numatytasis kanalas: `console.error` VIENĄ kartą per procesą — biudžeto vartai kviečiami
 * kelis kartus per dispatch'ą, o pakartota deprecation eilutė paskęstų loguose. Testai
 * injektuoja savo sink'ą, tad ši dedupikacija jų neveikia.
 */
const reportedDeprecations = new Set<string>();

function reportDeprecatedTokenCeilingKeys(message: string): void {
  if (reportedDeprecations.has(message)) return;
  reportedDeprecations.add(message);
  console.error(message);
}

/**
 * Konfigo skaitymas: trūkstamas failas — KLAIDA (etalono `loadJsonConfig` semantika be
 * `defaultOnMissing`); blogas JSON / schema — klaida; legacy raktai — WARNING per sink'ą.
 */
export async function loadToolBudget(
  fs: PolicyConfigFileSystemPort,
  runtimeRoot: string,
  onDeprecated: ToolBudgetDeprecationSink = reportDeprecatedTokenCeilingKeys,
): Promise<ToolBudget> {
  const configPath = toolBudgetConfigPath(runtimeRoot);
  const raw = await fs.readTextFileIfExists(configPath);
  if (raw === undefined) {
    throw new Error(`tool budget not found: ${configPath}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`tool budget is not valid JSON: ${message}`, { cause: error });
  }
  const budget = parseWithSchema(toolBudgetSchema, parsed, "tool budget");
  const deprecated = deprecatedTokenCeilingKeys(budget);
  if (deprecated.length > 0) {
    onDeprecated(
      `WARNING: tool-budget: ${configPath} naudoja pervadintus token lubų raktus ` +
        `(${deprecated.join(", ")}) — jų reikšmė interpretuojama kaip BILLABLE ` +
        `(input+output+cache_creation, BE cache_read) riba, ne RAW. Pervadink į ` +
        `\`max_total_billable_tokens\` / \`phase_limits.<fazė>.max_billable_tokens\`.`,
    );
  }
  return budget;
}

export function selectToolBudget(budget: ToolBudget, name: ToolBudgetName): ToolBudgetProfile {
  const selected = budget[name];
  if (!selected) throw new Error(`Tool budget profile is not configured: ${name}`);
  return selected;
}

/**
 * Context pack'o budget.browser/scraper/mcp flag'ai iš tool-budget "default" profilio
 * (task 880). Trūkstamas failas → all-disabled (minimalus target projektas), kaip kiti
 * adapter policy loader'iai su ENOENT default'u.
 */
export async function loadContextPackToolFlags(
  fs: PolicyConfigFileSystemPort,
  runtimeRoot: string,
): Promise<{ browser: boolean; scraper: boolean; mcp: boolean }> {
  const raw = await fs.readTextFileIfExists(toolBudgetConfigPath(runtimeRoot));
  if (raw === undefined) {
    return { browser: false, scraper: false, mcp: false };
  }
  const { browser, scraper, mcp } = selectToolBudget(await loadToolBudget(fs, runtimeRoot), "default");
  return { browser, scraper, mcp };
}
