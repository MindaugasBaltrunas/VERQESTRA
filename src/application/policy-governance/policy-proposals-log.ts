// Policy pasiūlymų append-only žurnalas (`vq/state/policy/{proposals,decisions}.jsonl`).
// Elgesio etalonas: AG_loop policy/policy-proposals.ts + core/schema proposal/decision
// blokai (zod prie modulio). IO — per PolicyProposalsFsPort; apply čia įrašo TIK
// lifecycle perėjimą — realus policy failo mutavimas gyvena policy-proposal-service.

import path from "node:path";
import { z } from "zod";
import { parseWithSchema } from "../../shared/schema.js";

export type PolicyProposalsFsPort = {
  /** Failo tekstas arba `undefined`, kai failo nėra. */
  readTextFileIfExists(absolutePath: string): Promise<string | undefined>;
  appendTextFile(absolutePath: string, text: string): Promise<void>;
  makeDirectory(absoluteDir: string): Promise<void>;
};

export const POLICY_ROUTINGS = ["queue", "human-review"] as const;
export type PolicyRouting = (typeof POLICY_ROUTINGS)[number];

export const policyProposalSchema = z.strictObject({
  policy_file: z.string().min(1),
  setting_id: z.string().min(1),
  old_value: z.unknown().optional(),
  requested_value: z.unknown(),
  reason: z.string(),
  timestamp: z.string().min(1),
  routing: z.enum(POLICY_ROUTINGS),
});

export type PolicyProposal = z.infer<typeof policyProposalSchema>;

export const POLICY_PROPOSAL_STATUSES = ["pending", "approved", "rejected", "applied", "cancelled"] as const;
export type PolicyProposalStatus = (typeof POLICY_PROPOSAL_STATUSES)[number];

export const policyDecisionSchema = z.strictObject({
  policy_file: z.string().min(1),
  setting_id: z.string().min(1),
  actor: z.string().min(1),
  reason: z.string(),
  timestamp: z.string().min(1),
  decision: z.enum(["approved", "rejected", "applied", "cancelled"]),
  /**
   * Pasiūlymo, kuriam šis sprendimas priklauso, `timestamp` — pasiūlymo tapatybė.
   *
   * NEPRIVALOMAS, nes `decisions.jsonl` yra append-only: seni įrašai lauko neturi ir atgal
   * jo neįgyja. Naujos rašymo operacijos (`decidePolicyProposal`) jį užpildo VISADA, kai
   * pasiūlymas tam nustatymui egzistuoja; seniems įrašams tapatybę atstato laiko langas
   * (`decisionBelongsToProposal`).
   */
  proposal_timestamp: z.string().min(1).optional(),
});

export type PolicyDecision = z.infer<typeof policyDecisionSchema>;

const PROPOSALS_FILE = "proposals.jsonl";
const DECISIONS_FILE = "decisions.jsonl";

export function policyProposalsDir(runtimeRoot: string): string {
  return path.join(runtimeRoot, "state", "policy");
}

async function appendJsonl(
  fs: PolicyProposalsFsPort,
  runtimeRoot: string,
  fileName: string,
  record: unknown,
): Promise<void> {
  const dir = policyProposalsDir(runtimeRoot);
  await fs.makeDirectory(dir);
  await fs.appendTextFile(path.join(dir, fileName), `${JSON.stringify(record)}\n`);
}

async function readJsonl<T>(
  fs: PolicyProposalsFsPort,
  runtimeRoot: string,
  fileName: string,
  schema: z.ZodType<T>,
  label: string,
): Promise<T[]> {
  const raw = await fs.readTextFileIfExists(path.join(policyProposalsDir(runtimeRoot), fileName));
  const records: T[] = [];
  for (const line of (raw ?? "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    records.push(parseWithSchema(schema, JSON.parse(line), label));
  }
  return records;
}

export async function appendPolicyProposal(
  fs: PolicyProposalsFsPort,
  runtimeRoot: string,
  proposal: PolicyProposal,
): Promise<void> {
  // Validuojam prieš rašant — invalid routing ar trūkstami laukai atmetami čia,
  // o ne tyliai įrašomi į proposals.jsonl.
  const validated = parseWithSchema(policyProposalSchema, proposal, "policy proposal");
  await appendJsonl(fs, runtimeRoot, PROPOSALS_FILE, validated);
}

export async function readPolicyProposals(fs: PolicyProposalsFsPort, runtimeRoot: string): Promise<PolicyProposal[]> {
  return await readJsonl(fs, runtimeRoot, PROPOSALS_FILE, policyProposalSchema, "policy proposal");
}

/** Nuoroda, kuria sprendimų helperiai rodo atgal į egzistuojantį pasiūlymą. */
export interface PolicyDecisionInput {
  policy_file: string;
  setting_id: string;
  actor: string;
  reason: string;
  timestamp: string;
  /** Pasiūlymo `timestamp`; praleidžiamas tik kai sprendimas priimamas be jokio pasiūlymo. */
  proposal_timestamp?: string;
}

export async function appendPolicyDecision(
  fs: PolicyProposalsFsPort,
  runtimeRoot: string,
  decision: PolicyDecision,
): Promise<void> {
  const validated = parseWithSchema(policyDecisionSchema, decision, "policy decision");
  await appendJsonl(fs, runtimeRoot, DECISIONS_FILE, validated);
}

export async function readPolicyDecisions(fs: PolicyProposalsFsPort, runtimeRoot: string): Promise<PolicyDecision[]> {
  return await readJsonl(fs, runtimeRoot, DECISIONS_FILE, policyDecisionSchema, "policy decision");
}

export async function approvePolicyProposal(
  fs: PolicyProposalsFsPort,
  runtimeRoot: string,
  input: PolicyDecisionInput,
): Promise<void> {
  await appendPolicyDecision(fs, runtimeRoot, { ...input, decision: "approved" });
}

export async function rejectPolicyProposal(
  fs: PolicyProposalsFsPort,
  runtimeRoot: string,
  input: PolicyDecisionInput,
): Promise<void> {
  await appendPolicyDecision(fs, runtimeRoot, { ...input, decision: "rejected" });
}

/** Apply čia įrašo tik lifecycle perėjimą; realus policy failo mutavimas — service sluoksnyje. */
export async function applyPolicyProposal(
  fs: PolicyProposalsFsPort,
  runtimeRoot: string,
  input: PolicyDecisionInput,
): Promise<void> {
  await appendPolicyDecision(fs, runtimeRoot, { ...input, decision: "applied" });
}

/** Atšaukimas — NAUJAS append-only įrašas; jokio esamo įrašo trynimo ar perrašymo. */
export async function cancelPolicyProposal(
  fs: PolicyProposalsFsPort,
  runtimeRoot: string,
  input: PolicyDecisionInput,
): Promise<void> {
  await appendPolicyDecision(fs, runtimeRoot, { ...input, decision: "cancelled" });
}

function matchesRef(
  record: { policy_file: string; setting_id: string },
  ref: { policy_file: string; setting_id: string },
): boolean {
  return record.policy_file === ref.policy_file && record.setting_id === ref.setting_id;
}

/**
 * Statusas iš PADUOTŲ sprendimų: paskutinis append'intas, arba "pending", kai jų nėra.
 *
 * Tai (policy_file, setting_id) lygio SUTRUMPINIMAS: nuoroda į nustatymą nėra nuoroda į
 * pasiūlymą, o tam pačiam nustatymui pasiūlymų būna daug. Paduodant visą žurnalą, ši funkcija
 * atsako „koks paskutinis sprendimas šiam nustatymui", o ne „kokia šio pasiūlymo būsena".
 * Tikroji per-pasiūlymo tiesa — `resolveProposals`, kuri istoriją pirma susiaurina iki vieno
 * pasiūlymo tapatybės ir tik tada kviečia šitą.
 */
export function resolveProposalStatus(
  decisions: PolicyDecision[],
  ref: { policy_file: string; setting_id: string },
): PolicyProposalStatus {
  let status: PolicyProposalStatus = "pending";
  for (const decision of decisions) {
    if (matchesRef(decision, ref)) {
      status = decision.decision;
    }
  }
  return status;
}

export interface ResolvedProposal {
  proposal: PolicyProposal;
  status: PolicyProposalStatus;
  history: PolicyDecision[];
}

/**
 * Ar sprendimas priklauso BŪTENT šitam pasiūlymui (nuoroda jau patikrinta `matchesRef`).
 *
 * Dvi tapatybės pakopos:
 * 1. `proposal_timestamp` — tikslus ryšys, kurį rašo visos naujos operacijos.
 * 2. Laiko langas — fallback seniems įrašams be lauko: sprendimas priklauso pasiūlymui, kurio
 *    `timestamp <= decision.timestamp < kito to paties ref pasiūlymo timestamp`.
 *
 * Žinomas lango limitas: du to paties ref pasiūlymai, sukurti tą pačią milisekundę, duoda
 * tuščią langą pirmajam — `timestamp` tada tapatybės nebeskiria. UUID `proposal_id` tai
 * uždarytų, bet kainuotų `policyProposalSchema` ir visų rašytojų (HTTP/CLI) keitimą; naujiems
 * įrašams pakopa 1 šios spragos neturi, tad langas lieka tik istorijos skaitytuvu.
 */
function decisionBelongsToProposal(
  decision: PolicyDecision,
  proposal: PolicyProposal,
  nextProposalTimestamp: string | undefined,
): boolean {
  if (decision.proposal_timestamp !== undefined) return decision.proposal_timestamp === proposal.timestamp;
  if (decision.timestamp < proposal.timestamp) return false;
  return nextProposalTimestamp === undefined || decision.timestamp < nextProposalTimestamp;
}

// Kiekvienas pasiūlymas prieš sprendimų žurnalą: ir dabartinis statusas, ir pilna
// append-only istorija, kad kvietėjai (pvz. final audit) atskirtų pending nuo nuspręstų.
// Istorija rišama prie PASIŪLYMO, ne prie nustatymo: kitaip „propose X → reject → propose Y"
// paverstų Y iškart atmestu, nors jo niekas nematė.
export function resolveProposals(proposals: PolicyProposal[], decisions: PolicyDecision[]): ResolvedProposal[] {
  return proposals.map((proposal, index) => {
    // Kitas TO PATIES ref pasiūlymas append tvarka — jis uždaro šio pasiūlymo laiko langą.
    const next = proposals.slice(index + 1).find((candidate) => matchesRef(candidate, proposal));
    const history = decisions.filter(
      (decision) => matchesRef(decision, proposal) && decisionBelongsToProposal(decision, proposal, next?.timestamp),
    );
    return {
      proposal,
      history,
      status: resolveProposalStatus(history, proposal),
    };
  });
}

export async function readResolvedProposals(
  fs: PolicyProposalsFsPort,
  runtimeRoot: string,
): Promise<ResolvedProposal[]> {
  const [proposals, decisions] = await Promise.all([
    readPolicyProposals(fs, runtimeRoot),
    readPolicyDecisions(fs, runtimeRoot),
  ]);
  return resolveProposals(proposals, decisions);
}

/** Neišspręstų pasiūlymų kiekis — FinalAuditPorts.pendingProposalCount tiekėjas. */
export async function countPendingProposals(fs: PolicyProposalsFsPort, runtimeRoot: string): Promise<number> {
  return (await readResolvedProposals(fs, runtimeRoot)).filter((entry) => entry.status === "pending").length;
}
