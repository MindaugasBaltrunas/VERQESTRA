// Model policy grynos taisyklės. Domain-savas tipas (R2: vėlesnio sluoksnio zod schema
// jį tenkina); config IO, deprecation sink default'as ir load — E3 (domain'e pranešimų
// kanalas NEturi console default'o). Behaviour etalon: AG_loop policy/model-policy.ts.

/** Passthrough forma: `tiers` yra vienintelis produkto vartojamas laukas (PC-MODEL-01). */
export type ModelPolicy = {
  tiers: string[];
} & Record<string, unknown>;

/**
 * `model-policy.json` laukai, kurie nebeturi JOKIO efekto: legacy fazė→pakopa žemėlapis
 * ir root `escalation` blokas — kanoninis maršrutizavimas skaito ATSKIRĄ `routing` bloką.
 */
export const DEPRECATED_MODEL_POLICY_FIELDS = ["compound_project", "escalation"] as const;

/** Deprecation pranešimų kanalas — E3 privalo jį PADUOTI (jokio console default'o domain'e). */
export type ModelPolicyDeprecationSink = (message: string) => void;

/**
 * Kurie DEPRECATED laukai vis dar yra konfige, konstantos tvarka. Tikrinamas rakto
 * BUVIMAS, ne truthiness: `"escalation": {}` yra toks pat pasenęs likutis.
 */
export function deprecatedModelPolicyFields(policy: ModelPolicy): string[] {
  const raw = policy as Record<string, unknown>;
  return DEPRECATED_MODEL_POLICY_FIELDS.filter((field) => Object.hasOwn(raw, field));
}

export function modelAllowed(policy: ModelPolicy, model: string): boolean {
  return policy.tiers.includes(model.trim());
}

/**
 * `routing` blokas kaip neapdorota reikšmė: jo validacija priklauso maršrutizatoriui —
 * čia tik cast'as, kad kvietėjui nereikėtų žinoti, jog konfigas ateina laisvu objektu.
 * Trūkstant bloko — `undefined`: maršrutizatorius dirba su numatytąja politika.
 */
export function modelPolicyRoutingSection(policy: ModelPolicy): unknown {
  return (policy as Record<string, unknown>)["routing"];
}
