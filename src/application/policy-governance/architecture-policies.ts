// Architektūros stiliaus / kodavimo principų / enforcement politikos schemos ir loaderiai
// (etalono policy/{architecture-style,coding-principles,enforcement}-policy.ts + core/schema
// blokai — zod prie modulio, WBR VQ-305). Konfigai gyvena `vq/architecture/*.json`; trūkstamas
// failas — KODINIAI default'ai (schema.parse({})), nes šie policy failai yra neprivalomi
// (bootstrap projektas jų dar neturi), o jų default'ai saugūs.
//
// R2 inversija: domain vaizdas (`domain/policies/architecture-style.ts#ArchitectureStylePolicy`)
// apibrėžia tai, ką vartoja grynos taisyklės; čia esanti schema jį TENKINA (schema tikrina,
// tipas apibrėžia).
import path from "node:path";
import { z } from "zod";
import { parseWithSchema } from "../../shared/schema.js";
import type { PolicyConfigFileSystemPort } from "./ports.js";

const nonEmptyString = z.string().min(1);
const stringList = z.array(nonEmptyString);
const enforcementLevel = z.enum(["advisory", "warn", "block"]).default("advisory");

export const architectureStylePolicySchema = z
  .object({
    version: nonEmptyString.default("1.0"),
    style: nonEmptyString.default("layered"),
    strictness: enforcementLevel,
    layers: stringList.default([]),
    forbidden_dependencies: stringList.default([]),
    custom_mermaid_source: z.string().optional(),
  })
  .passthrough();

export const codingPrinciplesPolicySchema = z
  .object({
    version: nonEmptyString.default("1.0"),
    single_responsibility: enforcementLevel,
    open_closed: enforcementLevel,
    dependency_inversion: enforcementLevel,
    interface_segregation: enforcementLevel,
    dry: enforcementLevel,
    yagni: enforcementLevel,
  })
  .passthrough();

export const enforcementPolicySchema = z
  .object({
    version: nonEmptyString.default("1.0"),
    max_files_per_task: z.number().int().positive().default(10),
    max_lines_per_file: z.number().int().positive().default(500),
    max_responsibilities_per_task: z.number().int().positive().default(3),
    require_tests_for_code_changes: z.boolean().default(false),
    require_interface_contract_for_public_changes: z.boolean().default(false),
    broad_scope_requires_human_review: z.boolean().default(true),
    global_policy_changes_require_human_review: z.boolean().default(true),
  })
  .passthrough();

export type ArchitectureStylePolicyConfig = z.infer<typeof architectureStylePolicySchema>;
export type CodingPrinciplesPolicy = z.infer<typeof codingPrinciplesPolicySchema>;
export type EnforcementPolicy = z.infer<typeof enforcementPolicySchema>;

export function architectureStylePolicyPath(runtimeRoot: string): string {
  return path.join(runtimeRoot, "architecture", "architecture-style.json");
}

export function codingPrinciplesPolicyPath(runtimeRoot: string): string {
  return path.join(runtimeRoot, "architecture", "coding-principles.json");
}

export function enforcementPolicyPath(runtimeRoot: string): string {
  return path.join(runtimeRoot, "architecture", "enforcement-policy.json");
}

async function loadOptionalPolicy<T>(
  fs: PolicyConfigFileSystemPort,
  configPath: string,
  schema: z.ZodType<T>,
  label: string,
  defaults: T,
): Promise<T> {
  const raw = await fs.readTextFileIfExists(configPath);
  if (raw === undefined) return defaults;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} is not valid JSON: ${message}`, { cause: error });
  }
  return parseWithSchema(schema, parsed, label);
}

export async function loadArchitectureStylePolicy(
  fs: PolicyConfigFileSystemPort,
  runtimeRoot: string,
): Promise<ArchitectureStylePolicyConfig> {
  return await loadOptionalPolicy(
    fs,
    architectureStylePolicyPath(runtimeRoot),
    architectureStylePolicySchema,
    "architecture-style-policy",
    architectureStylePolicySchema.parse({}),
  );
}

export async function loadCodingPrinciplesPolicy(
  fs: PolicyConfigFileSystemPort,
  runtimeRoot: string,
): Promise<CodingPrinciplesPolicy> {
  return await loadOptionalPolicy(
    fs,
    codingPrinciplesPolicyPath(runtimeRoot),
    codingPrinciplesPolicySchema,
    "coding-principles-policy",
    codingPrinciplesPolicySchema.parse({}),
  );
}

// `version` ir `max_responsibilities_per_task` čia parse'inami/validuojami, bet jų neskaito
// nė vienas vartas — sąmoningas documentation-only sprendimas (etalono PC-ENF-01/02), ne
// spraga. Netylėk jų prijungti ar trinti neatnaujinęs README įrodymo.
export async function loadEnforcementPolicy(
  fs: PolicyConfigFileSystemPort,
  runtimeRoot: string,
): Promise<EnforcementPolicy> {
  return await loadOptionalPolicy(
    fs,
    enforcementPolicyPath(runtimeRoot),
    enforcementPolicySchema,
    "enforcement-policy",
    enforcementPolicySchema.parse({}),
  );
}
