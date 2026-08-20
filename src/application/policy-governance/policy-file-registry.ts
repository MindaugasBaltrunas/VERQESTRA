// Vienintelis šaltinis, KURIE policy failai valdomi per proposal lifecycle. Ir pasiūlymo
// kūrimas/validacija, ir apply kelias policy failą sprendžia per šį registrą, tad
// gamintojas ir taikytojas negali išsiskirti: pasiūlymą galima sukurti tik failui, kurį
// taikytojas moka užkrauti, schema-validuoti ir įrašyti. Naujas valdomas failas — vienas
// įrašas čia, ne dar viena hardcoded šaka. Elgesio etalonas: AG_loop
// application/policy-governance/policy-file-registry.ts; VERQESTRA keliai — vq/….

import type { ZodType } from "zod";
import {
  architectureStylePolicySchema,
  codingPrinciplesPolicySchema,
  enforcementPolicySchema,
  loadArchitectureStylePolicy,
  loadCodingPrinciplesPolicy,
  loadEnforcementPolicy,
} from "./architecture-policies.js";
import { preflightLimitsFileSchema, readPreflightLimitsFile } from "./preflight-limits-policy.js";
import type { PolicyConfigFileSystemPort } from "./ports.js";
import type { PolicyRouting } from "./policy-proposals-log.js";

export type PolicyProposalGroup = "architecture-style" | "coding-principles" | "enforcement";

export interface PolicyFileEntry {
  /** Project-root-relative valdomo policy failo kelias. */
  readonly policy_file: string;
  /** UI grupavimo raktas — tik failams, adresuojamiems per `/set` UI kelią. */
  readonly group?: PolicyProposalGroup;
  /** Schema, validuojanti siūlomą reikšmę kūrimo metu ir re-validuojanti apply metu. */
  readonly schema: ZodType;
  /** Užkrauna dabartinį policy objektą (old-value fiksavimui ir merge-on-apply). */
  readonly load: (fs: PolicyConfigFileSystemPort, runtimeRoot: string) => Promise<unknown>;
  /** Išsprendžia human-review routing'ą UI grupės keliui. */
  readonly resolveRouting: (fs: PolicyConfigFileSystemPort, runtimeRoot: string) => Promise<PolicyRouting>;
}

// Globalūs policy pakeitimai eina į human-review tik kai enforcement politika to reikalauja.
async function routingFromEnforcementGuard(
  fs: PolicyConfigFileSystemPort,
  runtimeRoot: string,
): Promise<PolicyRouting> {
  const enforcement = await loadEnforcementPolicy(fs, runtimeRoot);
  return enforcement.global_policy_changes_require_human_review ? "human-review" : "queue";
}

const POLICY_FILE_REGISTRY: readonly PolicyFileEntry[] = [
  {
    policy_file: "vq/architecture/architecture-style.json",
    group: "architecture-style",
    schema: architectureStylePolicySchema,
    load: loadArchitectureStylePolicy,
    resolveRouting: () => Promise.resolve("human-review"),
  },
  {
    policy_file: "vq/architecture/coding-principles.json",
    group: "coding-principles",
    schema: codingPrinciplesPolicySchema,
    load: loadCodingPrinciplesPolicy,
    resolveRouting: routingFromEnforcementGuard,
  },
  {
    policy_file: "vq/architecture/enforcement-policy.json",
    group: "enforcement",
    schema: enforcementPolicySchema,
    load: loadEnforcementPolicy,
    resolveRouting: routingFromEnforcementGuard,
  },
  {
    policy_file: "vq/config/preflight-limits.json",
    // Be UI grupės: preflight-limits pasiūlymai adresuojami failu (CLI `policy propose`).
    // Routing default'as — human-review, saugusis governance kelias programinei kūrybai.
    // `load` grąžina tai, ką FAILAS deklaruoja (readPreflightLimitsFile.values), ne su
    // default'ais sulietą lentelę: old_value privalo atspindėti failą, o apply įrašo tik
    // failo formos reikšmes — kitaip pirmas pasiūlymas užrakintų visus default'us faile.
    schema: preflightLimitsFileSchema,
    load: async (fs, runtimeRoot) => (await readPreflightLimitsFile(fs, runtimeRoot)).values,
    resolveRouting: () => Promise.resolve("human-review"),
  },
];

/** Domain klaida: pasiūlymas rodo į policy failą už palaikomo registro ribų. */
export class UnsupportedPolicyFileError extends Error {
  constructor(readonly policyFile: string) {
    super(`Unsupported policy file: ${policyFile}. Supported: ${supportedPolicyFiles().join(", ")}`);
    this.name = "UnsupportedPolicyFileError";
  }
}

/** Policy failai, valdomi per proposal lifecycle. */
export function supportedPolicyFiles(): string[] {
  return POLICY_FILE_REGISTRY.map((entry) => entry.policy_file);
}

export function findPolicyFileEntry(policyFile: string): PolicyFileEntry | undefined {
  return POLICY_FILE_REGISTRY.find((entry) => entry.policy_file === policyFile);
}

/** Registro įrašas pagal policy failą; {@link UnsupportedPolicyFileError}, kai nežinomas. */
export function requirePolicyFileEntry(policyFile: string): PolicyFileEntry {
  const entry = findPolicyFileEntry(policyFile);
  if (!entry) {
    throw new UnsupportedPolicyFileError(policyFile);
  }
  return entry;
}

/** Registro įrašas pagal UI grupę; {@link UnsupportedPolicyFileError}, kai nežinoma. */
export function requirePolicyGroupEntry(group: PolicyProposalGroup): PolicyFileEntry {
  const entry = POLICY_FILE_REGISTRY.find((candidate) => candidate.group === group);
  if (!entry) {
    throw new UnsupportedPolicyFileError(group);
  }
  return entry;
}
