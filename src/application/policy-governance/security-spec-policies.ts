// Security ir spec politikos schemos bei loaderiai (etalono policy/{security,spec}-policy.ts +
// core/schema blokai — zod prie modulio, WBR VQ-305). Trūkstamas failas — KLAIDA (etalono
// `loadJsonConfig` be `defaultOnMissing`): abu konfigai yra `install` šablono dalis, jų
// nebuvimas reiškia sugadintą diegimą, o ne „be politikos".
import path from "node:path";
import { z } from "zod";
import { parseWithSchema } from "../../shared/schema.js";
import type { PolicyConfigFileSystemPort } from "./ports.js";

const nonEmptyString = z.string().min(1);
const stringList = z.array(nonEmptyString);

export const securityPolicySchema = z
  .object({
    blocked_file_patterns: stringList.default([]),
    dangerous_code_patterns: stringList.default([]),
    no_secrets_in_repo: z.boolean().default(true),
  })
  .passthrough();

export type SecurityPolicy = z.infer<typeof securityPolicySchema>;

// `required`/`optional` yra DARBO kategorijų proza („new features", „typo fixes"), ne failų
// scope glob'ai (etalono PC-SPEC-01/924-03 sprendimas) — jų negalima lieti į spec-drift
// scope lyginimą; loaderis spec-drift kelyje veikia kaip egzistavimo/schemos vartas.
export const specPolicySchema = z
  .object({
    required: stringList.default([]),
    optional: stringList.default([]),
  })
  .passthrough();

export type SpecPolicy = z.infer<typeof specPolicySchema>;

export function securityPolicyPath(runtimeRoot: string): string {
  return path.join(runtimeRoot, "config", "security-policy.json");
}

export function specPolicyPath(runtimeRoot: string): string {
  return path.join(runtimeRoot, "config", "spec-policy.json");
}

async function loadRequiredPolicy<T>(
  fs: PolicyConfigFileSystemPort,
  configPath: string,
  schema: z.ZodType<T>,
  label: string,
): Promise<T> {
  const raw = await fs.readTextFileIfExists(configPath);
  if (raw === undefined) {
    throw new Error(`${label} not found: ${configPath}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} is not valid JSON: ${message}`, { cause: error });
  }
  return parseWithSchema(schema, parsed, label);
}

export async function loadSecurityPolicy(fs: PolicyConfigFileSystemPort, runtimeRoot: string): Promise<SecurityPolicy> {
  return await loadRequiredPolicy(fs, securityPolicyPath(runtimeRoot), securityPolicySchema, "security-policy");
}

export async function loadSpecPolicy(fs: PolicyConfigFileSystemPort, runtimeRoot: string): Promise<SpecPolicy> {
  return await loadRequiredPolicy(fs, specPolicyPath(runtimeRoot), specPolicySchema, "spec-policy");
}
