// Context budget konfigo schema + loader'is. Behaviour etalon: AG_loop
// policy/context-budget.ts + core/schema.ts contextBudgetSchema blokas (schema prie
// modulio — WBR E3). Konfigo kelias — VERQESTRA runtime šaknis (`vq/config`).

import path from "node:path";
import { z } from "zod";
import { parseWithSchema } from "../../shared/schema.js";
import type { PolicyConfigFileSystemPort } from "./ports.js";

// Vienintelė context-budget tiesa: raktai, default'ai ir griežtumas gyvena čia. Visi
// laukai — teigiami sveikieji skaičiai; trūkstamas raktas užpildomas default'u,
// negaliojanti reikšmė (0, neigiama, ne sveikas) atmetama.
export const DEFAULT_CONTEXT_BUDGET = {
  // 12000 dera su tool-budget execution riba (abu vartai tikrina tą patį pack'ą).
  // Ribos kėlimas neveikia kaip fix: assembler pildo fragmentus iki ribos, o tilpimą
  // garantuoja assemble fragmentų shrink ciklas.
  max_context_chars: 12000,
  max_spec_fragments: 8,
  max_file_fragments: 8,
  max_files: 8,
} as const;

const contextBudgetField = z.number().int().positive();

export const contextBudgetSchema = z
  .object({
    max_context_chars: contextBudgetField.default(DEFAULT_CONTEXT_BUDGET.max_context_chars),
    max_spec_fragments: contextBudgetField.default(DEFAULT_CONTEXT_BUDGET.max_spec_fragments),
    max_file_fragments: contextBudgetField.default(DEFAULT_CONTEXT_BUDGET.max_file_fragments),
    max_files: contextBudgetField.default(DEFAULT_CONTEXT_BUDGET.max_files),
  })
  .passthrough();

export type ContextBudgetSettings = z.infer<typeof contextBudgetSchema>;

export function contextBudgetConfigPath(runtimeRoot: string): string {
  return path.join(runtimeRoot, "config", "context-budget.json");
}

/**
 * Nuskaito ir validuoja context-budget konfigą per bendrą schemą.
 *
 * - failo nėra / tuščias → numatytieji DEFAULT_CONTEXT_BUDGET;
 * - dalinės reikšmės → trūkstami raktai užpildomi default'ais;
 * - negaliojantis JSON arba griežtumą pažeidžianti reikšmė → klaida (fail-fast).
 */
export async function loadContextBudget(
  fs: PolicyConfigFileSystemPort,
  runtimeRoot: string,
): Promise<ContextBudgetSettings> {
  const raw = (await fs.readTextFileIfExists(contextBudgetConfigPath(runtimeRoot))) ?? "";
  if (!raw.trim()) {
    return contextBudgetSchema.parse({ ...DEFAULT_CONTEXT_BUDGET });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`context budget is not valid JSON: ${message}`, { cause: error });
  }

  return parseWithSchema(contextBudgetSchema, parsed, "context budget");
}
