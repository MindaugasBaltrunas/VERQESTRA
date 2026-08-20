// Model policy (`vq/config/model-policy.json`) schema ir loaderis (etalono policy/model-policy.ts
// IO pusė + core/schema modelPolicySchema — zod prie modulio, WBR VQ-305). Grynos taisyklės
// (ModelPolicy tipas, DEPRECATED laukai, modelAllowed, routing sekcijos cast'as) gyvena
// domain/policies/model-policy-rules.ts (VQ-203, FQC-12) — čia tik failo skaitymas ir
// deprecation sink default'as (domain'e console default'o būti negali).
import path from "node:path";
import { z } from "zod";
import { parseWithSchema } from "../../shared/schema.js";
import {
  deprecatedModelPolicyFields,
  type ModelPolicy,
  type ModelPolicyDeprecationSink,
} from "../../domain/policies/model-policy-rules.js";
import type { PolicyConfigFileSystemPort } from "./ports.js";

export const modelPolicySchema = z
  .object({
    tiers: z.array(z.string().min(1)),
  })
  .passthrough();

export function modelPolicyPath(runtimeRoot: string): string {
  return path.join(runtimeRoot, "config", "model-policy.json");
}

/**
 * Įkelia `model-policy.json`. Trūkstamas failas — KLAIDA (install šablono dalis).
 *
 * `modelPolicySchema` yra passthrough, todėl SENI target'ų konfigai su legacy blokais lieka
 * validūs — jie tik ignoruojami ir apie juos pranešama per `onDeprecated`. Sink'as
 * injektuojamas, kad testai jo neturėtų gaudyti iš stdout.
 */
export async function loadModelPolicy(
  fs: PolicyConfigFileSystemPort,
  runtimeRoot: string,
  onDeprecated: ModelPolicyDeprecationSink = reportDeprecatedModelPolicyFields,
): Promise<ModelPolicy> {
  const configPath = modelPolicyPath(runtimeRoot);
  const raw = await fs.readTextFileIfExists(configPath);
  if (raw === undefined) {
    throw new Error(`model policy not found: ${configPath}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`model policy is not valid JSON: ${message}`, { cause: error });
  }
  const policy: ModelPolicy = parseWithSchema(modelPolicySchema, parsed, "model policy");
  const deprecated = deprecatedModelPolicyFields(policy);
  if (deprecated.length > 0) {
    onDeprecated(
      `AG model-policy: ${configPath} turi pasenusius laukus (${deprecated.join(", ")}) — ` +
        `nuo task 1185 jie ignoruojami; modelio parinkimas gyvena "routing" bloke. Pašalink juos.`,
    );
  }
  return policy;
}

function reportDeprecatedModelPolicyFields(message: string): void {
  console.error(message);
}
