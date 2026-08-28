// Policy governance pasiūlymų application use-case'ai: orkestruoja loaderius + append-only
// žurnalą nepriklausomai nuo UI/HTTP transporto. Elgesio etalonas: AG_loop
// application/policy-governance/policy-proposal-service.ts (su 2026-08-06 UI audito
// human-review vartų pataisa). IO — per PolicyProposalServicePorts.

import path from "node:path";
import { toPrettyJson } from "../../shared/json.js";
import { toPosixPath } from "../../shared/paths.js";
import {
  applyPolicyProposal,
  approvePolicyProposal,
  readResolvedProposals,
  rejectPolicyProposal,
  type PolicyDecisionInput,
  type PolicyProposal,
  type PolicyProposalsFsPort,
  type ResolvedProposal,
} from "./policy-proposals-log.js";
import {
  requirePolicyFileEntry,
  requirePolicyGroupEntry,
  type PolicyProposalGroup,
} from "./policy-file-registry.js";
import type { PolicyConfigFileSystemPort } from "./ports.js";

export type PolicyProposalServicePorts = {
  fs: PolicyProposalsFsPort &
    PolicyConfigFileSystemPort & {
      exists(absolutePath: string): Promise<boolean>;
      /** Policy failo įrašymas; atomiškumas — adapterio atsakomybė (etalono writeJsonAtomic). */
      writeTextFile(absolutePath: string, content: string): Promise<void>;
    };
};

export type PolicyDecisionVerb = "approve" | "reject" | "apply";

/** Domain klaida: apply bandytas pasiūlymui, kuris nebuvo patvirtintas. */
export class ProposalNotApprovedError extends Error {
  constructor(readonly policyFile: string, readonly settingId: string) {
    super(`Policy proposal must be approved before apply: ${policyFile}/${settingId}`);
    this.name = "ProposalNotApprovedError";
  }
}

/**
 * Domain klaida: į `human-review` nukreiptas pasiūlymas taikytas be out-of-band žmogaus
 * patvirtinimo. Iki 2026-08-06 UI audito `routing` buvo tik įrašomas į audito žurnalą ir
 * NIEKUR neužtikrinamas: tas pats dashboard'as, kuris sukuria pasiūlymą, jį iškart
 * „patvirtindavo" ir pritaikydavo — vartai, kurie patys save galėjo išjungti.
 */
export class HumanReviewApprovalRequiredError extends Error {
  /**
   * Žymės kelias REPO-RELIATYVUS, ne absoliutus.
   *
   * Ši žinutė yra vienintelė šios klaidos klasės, kuri realiai pasiekia naršyklę (`ui-error-mapping`
   * ją perduoda kaip 403 kūną). Absoliutus kelias ten nešė disko raidę, vartotojo vardą ir įdiegimo
   * vietą — tą patį, ką `free-text-redaction` sąmoningai kerpa iš bangų vaizdo, o
   * `ui-error-mapping` antraštė vadina „vidinėmis detalėmis, liekančiomis serverio pusėje"
   * (2026-08-24 auditas, penktas ratas).
   *
   * Aklas redagavimas į `<path>` čia netiktų: žinutės VISA prasmė yra pasakyti, KUR sukurti failą.
   * Repo-reliatyvus kelias išsaugo veiksmą (operatorius savo šaknį mato Header'yje) ir nieko
   * neatskleidžia — būtent todėl `free-text-redaction` santykinius kelius palieka matomus.
   */
  constructor(readonly policyFile: string, readonly settingId: string, readonly markerRef: string) {
    super(
      `Policy proposal is routed to human-review and cannot be applied from the UI: ${policyFile}/${settingId}. ` +
        `A human must create the approval marker out-of-band: ${markerRef}`,
    );
    this.name = "HumanReviewApprovalRequiredError";
  }
}

/**
 * Out-of-band patvirtinimo žymės vardas. Žymė gyvena po `vq/state/`, kurį agentų rašymo
 * guard'as saugo — jos negali sukurti nei UI, nei vykdymo agentas, tik žmogus savo
 * terminale. Būtent tai daro ją tikrais vartais, o ne dar viena vėliava, kurią ta pati
 * sistema gali sau išrašyti.
 */
export function humanReviewApprovalMarkerName(policyFile: string, settingId: string): string {
  const flatten = (value: string): string => value.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "");
  return `${flatten(policyFile)}__${flatten(settingId)}.approved`;
}

/** Pilnas žymės kelias — juo tikrinamas egzistavimas. Į klientą jis NEIŠEINA. */
export function humanReviewApprovalMarkerPath(runtimeRoot: string, policyFile: string, settingId: string): string {
  return path.join(runtimeRoot, "state", "policy-approvals", humanReviewApprovalMarkerName(policyFile, settingId));
}

/**
 * Tas pats kelias REPO-RELIATYVIA posix forma — tai, ką rodo žinutė.
 *
 * Šaknis išvedama taip pat, kaip `applyApprovedProposal`: `runtimeRoot` yra `<root>/vq`, tad jo
 * tėvas yra projekto šaknis. Antros kelio aritmetikos čia neatsiranda.
 */
export function humanReviewApprovalMarkerRef(runtimeRoot: string, policyFile: string, settingId: string): string {
  const absolute = humanReviewApprovalMarkerPath(runtimeRoot, policyFile, settingId);
  return toPosixPath(path.relative(path.dirname(path.resolve(runtimeRoot)), absolute));
}

/**
 * Sukonstruoja (bet NEpersistina) policy pakeitimo pasiūlymą duotam nustatymui,
 * dabartinę reikšmę ir human-review routing'ą imdamas iš policy loaderių.
 */
export async function buildPolicyProposal(
  ports: PolicyProposalServicePorts,
  runtimeRoot: string,
  group: PolicyProposalGroup,
  setting_id: string,
  requested_value: unknown,
  reason?: string,
): Promise<PolicyProposal> {
  const entry = requirePolicyGroupEntry(group);
  const current = (await entry.load(ports.fs, runtimeRoot)) as Record<string, unknown>;
  // Suliejama reikšmė validuojama prieš failo schemą DAR PRIEŠ siūlant.
  entry.schema.parse({ ...current, [setting_id]: requested_value });

  return {
    policy_file: entry.policy_file,
    setting_id,
    old_value: current[setting_id],
    requested_value,
    reason: reason ?? "",
    timestamp: new Date().toISOString(),
    routing: await entry.resolveRouting(ports.fs, runtimeRoot),
  };
}

async function applyApprovedProposal(
  ports: PolicyProposalServicePorts,
  runtimeRoot: string,
  proposal: PolicyProposal,
): Promise<void> {
  // Sprendžiama per bendrą registrą; nepalaikomas failas — tipizuota domain klaida,
  // kurią HTTP sluoksnis paverčia 400 (ne 500).
  const entry = requirePolicyFileEntry(proposal.policy_file);
  const current = (await entry.load(ports.fs, runtimeRoot)) as Record<string, unknown>;
  const nextPolicy = entry.schema.parse({ ...current, [proposal.setting_id]: proposal.requested_value });

  // policy_file yra project-root-relative ("vq/..."), o runtimeRoot = <root>/vq — tėvas
  // yra projekto šaknis (etalono path.dirname(agRoot) atitikmuo).
  const policyPath = path.join(path.dirname(runtimeRoot), ...proposal.policy_file.split("/"));
  await ports.fs.makeDirectory(path.dirname(policyPath));
  await ports.fs.writeTextFile(policyPath, toPrettyJson(nextPolicy));
}

/** Visi pasiūlymai su sprendimų istorija iš append-only žurnalo. */
export async function listPolicyProposals(
  ports: PolicyProposalServicePorts,
  runtimeRoot: string,
): Promise<{ proposals: ResolvedProposal[] }> {
  return { proposals: await readResolvedProposals(ports.fs, runtimeRoot) };
}

/** Įrašo approve/reject/apply sprendimą ir grąžina atnaujintą resolved sąrašą. */
export async function decidePolicyProposal(
  ports: PolicyProposalServicePorts,
  runtimeRoot: string,
  verb: PolicyDecisionVerb,
  input: Omit<PolicyDecisionInput, "timestamp">,
): Promise<{ proposals: ResolvedProposal[] }> {
  // Kiekvienas verbas validuoja policy failą per tą patį registrą. Anksčiau tikrino tik
  // `apply`, tad į append-only sprendimų žurnalą buvo galima prirašyti sprendimų
  // neegzistuojantiems policy failams — audito įrašai, kurių niekas negali nei
  // pritaikyti, nei paneigti.
  requirePolicyFileEntry(input.policy_file);

  const decisionInput: PolicyDecisionInput = { ...input, timestamp: new Date().toISOString() };
  if (verb === "approve") {
    await approvePolicyProposal(ports.fs, runtimeRoot, decisionInput);
  } else if (verb === "reject") {
    await rejectPolicyProposal(ports.fs, runtimeRoot, decisionInput);
  } else {
    const resolved = await readResolvedProposals(ports.fs, runtimeRoot);
    const approved = [...resolved]
      .reverse()
      .find(
        ({ proposal, status }) =>
          proposal.policy_file === input.policy_file && proposal.setting_id === input.setting_id && status === "approved",
      );
    if (!approved) {
      throw new ProposalNotApprovedError(input.policy_file, input.setting_id);
    }
    if (approved.proposal.routing === "human-review") {
      // Tikrinama ABSOLIUČIU keliu, o pranešama REPO-RELIATYVIU: patikrai reikia tikslaus kelio,
      // o žinutė keliauja į naršyklę.
      const markerPath = humanReviewApprovalMarkerPath(runtimeRoot, input.policy_file, input.setting_id);
      if (!(await ports.fs.exists(markerPath))) {
        throw new HumanReviewApprovalRequiredError(
          input.policy_file,
          input.setting_id,
          humanReviewApprovalMarkerRef(runtimeRoot, input.policy_file, input.setting_id),
        );
      }
    }
    await applyApprovedProposal(ports, runtimeRoot, approved.proposal);
    await applyPolicyProposal(ports.fs, runtimeRoot, decisionInput);
  }
  return await listPolicyProposals(ports, runtimeRoot);
}
