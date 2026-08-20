// Architektūros kontrakto schema ir loader'is (etalono core/config.ts
// architectureContractSchema blokas — zod prie modulio, WBR VQ-501 3/5-b). Kontraktą
// generuoja `plan` use case'as (application/task-planning/plan.ts) ir skaito jo
// validacijos kelias; failas gyvena `vq/project/architecture-contract.json`.
// Klaidų tekstai — etalono loadJsonConfig 1:1 (label = failo kelias).

import { z } from "zod";
import { parseWithSchema } from "../../shared/schema.js";
import type { PolicyConfigFileSystemPort } from "./ports.js";

const architectureContractSchema = z
  .object({
    version: z.string().min(1),
    generated_from: z.string().min(1),
    boundaries: z.record(z.string().min(1), z.boolean()),
    dependency_direction: z.array(z.string().min(1)),
    security_rules: z.record(z.string().min(1), z.boolean()),
    checks: z.array(z.string().min(1)).default([]),
  })
  .passthrough();

export type ArchitectureContract = z.infer<typeof architectureContractSchema>;

export function parseArchitectureContract(value: unknown, label = "architecture contract"): ArchitectureContract {
  return parseWithSchema(architectureContractSchema, value, label);
}

export async function loadArchitectureContract(
  fs: PolicyConfigFileSystemPort,
  filePath: string,
): Promise<ArchitectureContract> {
  const raw = await fs.readTextFileIfExists(filePath);
  if (raw === undefined) {
    throw new Error(`${filePath} not found: ${filePath}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${filePath} is not valid JSON: ${message}`, { cause: error });
  }

  return parseWithSchema(architectureContractSchema, parsed, filePath);
}
