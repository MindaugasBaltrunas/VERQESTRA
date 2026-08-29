// Quality policy (`vq/config/quality-policy.json`) schema, resolveriai ir loaderis
// (etalono policy/quality-policy.ts + core/schema quality blokas — zod prie modulio, WBR VQ-305).
//
// Bangos vartų schema NEdubliuojama: `waveGatePolicySchema` ir `WAVE_COMMAND_GATE_NAMES`
// kanoniškai gyvena `application/integration/wave-gates-schema.ts` (VQ-305 1/3) — čia jie tik
// importuojami, kad `wave` sekcija reikštų TĄ PATĮ abiejose pusėse (FQC-12).
import path from "node:path";
import { z } from "zod";
import {
  WAVE_COMMAND_GATE_NAMES,
  waveGatePolicySchema,
  type WaveGatePolicy,
} from "../integration/wave-gates-schema.js";
import {
  checkStacksForLanguage,
  type CheckCommandContext,
  type CheckStack,
  type SpawnCheckCommand,
} from "../../domain/policies/check-command-allowlist.js";
import { parseWithSchema } from "../../shared/schema.js";
import type { PolicyConfigFileSystemPort } from "./ports.js";

const nonEmptyString = z.string().min(1);
const stringList = z.array(nonEmptyString);
const qualityCheckSchema = z.union([
  nonEmptyString,
  z
    .object({
      cmd: nonEmptyString,
      args: stringList.default([]),
      /**
       * Per-check timeout ms (1s..2h). Be jo galioja runner'io numatytasis (30 min).
       * Reikalingas lėtoms suite'ėms (GeoGravity apps/web pilnas vitest ~25+ min šaltu turbo
       * cache — 30 min gate ribą kirsdavo 124 ir loop'as korektiškai, bet amžinai abort'uodavo).
       */
      timeoutMs: z.number().int().min(1000).max(7_200_000).optional(),
    })
    .passthrough(),
]);
const qualityCheckList = z.array(qualityCheckSchema);

export const qualityPolicySchema = z
  .object({
    task: z.object({ checks: qualityCheckList.default([]) }).passthrough(),
    feature: z.object({ checks: qualityCheckList.default([]) }).passthrough(),
    milestone: z.object({ checks: qualityCheckList.default([]) }).passthrough(),
    /** Bangos vartai. Nėra sekcijos = nė vienas bangos vartas nesukonfigūruotas. */
    wave: waveGatePolicySchema.optional(),
  })
  .passthrough();

export type QualityPolicy = z.infer<typeof qualityPolicySchema>;

export type QualityScope = "task" | "feature" | "milestone";
export type StructuredQualityCommand = {
  cmd: string;
  args: string[];
};
export type ResolvedQualityCheck =
  | { kind: "shell"; display: string }
  | { kind: "spawn"; display: string; cmd: string; args: string[]; timeoutMs?: number };

export function qualityPolicyPath(runtimeRoot: string): string {
  return path.join(runtimeRoot, "config", "quality-policy.json");
}

/**
 * Konfigo skaitymas per portą (etalono `loadJsonConfig` semantika be `defaultOnMissing`):
 * trūkstamas failas — KLAIDA, blogas JSON / schema — klaida. PolicyConfigError klasifikaciją
 * (infrastruktūra, ne vieno task'o parkas) uždeda composition root per `withPolicyConfigErrors`.
 */
export async function loadQualityPolicy(fs: PolicyConfigFileSystemPort, runtimeRoot: string): Promise<QualityPolicy> {
  const configPath = qualityPolicyPath(runtimeRoot);
  const raw = await fs.readTextFileIfExists(configPath);
  if (raw === undefined) {
    throw new Error(`quality-policy not found: ${configPath}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`quality-policy is not valid JSON: ${message}`, { cause: error });
  }
  return parseWithSchema(qualityPolicySchema, parsed, "quality-policy");
}

export function isQualityScope(value: string): value is QualityScope {
  return value === "task" || value === "feature" || value === "milestone";
}

export function formatQualityCommand(command: StructuredQualityCommand): string {
  return [command.cmd, ...command.args].join(" ");
}

export function resolveQualityChecks(policy: QualityPolicy, scope: QualityScope): ResolvedQualityCheck[] {
  return policy[scope].checks.map((check) => {
    if (typeof check === "string") {
      return { kind: "shell", display: check };
    }
    return {
      kind: "spawn",
      display: formatQualityCommand(check),
      cmd: check.cmd,
      args: check.args.slice(),
      ...(check.timeoutMs === undefined ? {} : { timeoutMs: check.timeoutMs }),
    };
  });
}

/**
 * Wave-level gate commands (etalono task 1115, spec IVER-2). A gate that is absent here is
 * `missing`, never "skipped": the wave verifier reports an unconfigured gate as a
 * non-pass, so this resolver never invents a default command. Guessing one would mean a
 * gate that verifies nothing while reporting green — strictly worse than a visible gap.
 */
export function resolveWaveGateCommands(policy: QualityPolicy): WaveGatePolicy {
  const configured = policy.wave;
  if (!configured) return {};
  const resolved: WaveGatePolicy = {};
  for (const gate of WAVE_COMMAND_GATE_NAMES) {
    const command = configured[gate];
    if (command) resolved[gate] = { cmd: command.cmd, args: command.args.slice() };
  }
  return resolved;
}

/** Collects every spawn-form check declared across all scopes, so a check configured under any
 * scope is recognized as configured regardless of which scope is being run. Wave gates are
 * included: they are spawn-form commands the project declared, and the spawn command policy
 * must recognize them as configured for exactly the same reason the scoped checks are. */
export function collectConfiguredSpawnChecks(policy: QualityPolicy): SpawnCheckCommand[] {
  const checks: SpawnCheckCommand[] = [];
  for (const scope of ["task", "feature", "milestone"] as const) {
    for (const check of policy[scope].checks) {
      if (typeof check !== "string") checks.push({ cmd: check.cmd, args: check.args.slice() });
    }
  }
  const waveGates = resolveWaveGateCommands(policy);
  for (const gate of WAVE_COMMAND_GATE_NAMES) {
    const command = waveGates[gate];
    if (command) checks.push({ cmd: command.cmd, args: command.args.slice() });
  }
  return checks;
}

/** Projekto profilio vaizdas, kurio reikia aktyvių stack'ų išvedimui — pilnas profilis nereikalingas. */
export type CheckContextProfileView = {
  language?: string | null;
  selectedLanguage?: string | null;
};

/**
 * Sudaro {@link CheckCommandContext}, kurio reikia abiem komandų politikos sluoksniams:
 * deklaruotos spawn formos patikros iš quality-policy ir projekto aktyvūs stack'ai (iš
 * profilio kalbos ir stack sprendimo). GRYNA funkcija — fail-safe pusę (trūkstamas
 * policy/profilis → tuščia atitinkama pusė) užtikrina kvietėjas, paduodamas `undefined`.
 * Etalone tą patį darė `resolveCheckCommandContext` su vidiniais catch'ais; profilio
 * skaitymas VERQESTRA'oje yra project-bootstrap klasterio (VQ-305 3/3) / E4 darbas.
 */
export function resolveCheckCommandContext(
  policy: QualityPolicy | undefined,
  profile: CheckContextProfileView | undefined,
): CheckCommandContext {
  const configuredSpawnChecks = policy ? collectConfiguredSpawnChecks(policy) : [];

  const stacks = new Set<CheckStack>();
  for (const stack of checkStacksForLanguage(profile?.language)) stacks.add(stack);
  for (const stack of checkStacksForLanguage(profile?.selectedLanguage)) stacks.add(stack);

  return { configuredSpawnChecks, activeStacks: [...stacks] };
}
