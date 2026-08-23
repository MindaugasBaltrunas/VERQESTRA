// Politikų governance portų surišimas dashboard'ui (manual DI, LAY-2).
//
// KODĖL ATSKIRAI. Iki 2026-08-23 UI audito antro rato politikų maršrutai buvo prijungti prie
// ŽALIO append-only žurnalo (`appendPolicyProposal`), nors visas use-case sluoksnis
// (`policy-proposal-service`) jau egzistavo ir buvo nepanaudotas. Pasekmės buvo trys, ir nė viena
// nebuvo kosmetinė:
//
//   1. `approve`/`reject`/`apply` prirašydavo PASIŪLYMĄ su svetimu `verb` lauku. `strictObject`
//      jį atmesdavo, tad kiekvienas sprendimas grįždavo 500 — mygtukai buvo negyvi.
//   2. `apply` niekada nerašė politikos failo, o `ProposalNotApprovedError` ir
//      `HumanReviewApprovalRequiredError` vartai nebuvo APEINAMI — jų tiesiog nebuvo kelyje.
//   3. Pasiūlymo `routing` ateidavo IŠ KLIENTO. Suklastotas `routing: "queue"` panaikintų
//      human-review reikalavimą prie `apply`, t. y. vartus, kurie turi saugoti nuo pačios
//      sistemos.
//
// Dabar visi trys keliai eina per tą patį `policy-proposal-service`, kurį naudoja CLI.

import {
  buildPolicyProposal,
  decidePolicyProposal as decidePolicyProposalUseCase,
  listPolicyProposals as listPolicyProposalsUseCase,
  type PolicyDecisionVerb,
  type PolicyProposalServicePorts,
} from "../../application/policy-governance/policy-proposal-service.js";
import { appendPolicyProposal } from "../../application/policy-governance/policy-proposals-log.js";
import type { PolicyProposalGroup } from "../../application/policy-governance/policy-file-registry.js";
import type { PolicyDecisionRequest, PolicyProposalInput } from "../../interfaces/http/ui-router-model.js";
import { nodeFsAdapter } from "../../infrastructure/fs/node-fs-adapter.js";

/**
 * Sprendimo AUTORIUS, kurį serveris gali sąžiningai paliudyti.
 *
 * Klientas jo NESIUNČIA: front-end kadaise siųsdavo hardcoded „operator", tad append-only audito
 * žurnale bet kas galėjo pasirašyti bet kokiu vardu. Serveris žino tik tiek — sprendimas atėjo
 * per lokalų UI.
 */
const UI_ACTOR = "ui-local";

/** Governance portai: žurnalas, politikų konfigai, žymės patikra ir politikos failo įrašymas. */
const policyServicePorts: PolicyProposalServicePorts = {
  fs: {
    readTextFileIfExists: (absolutePath) => nodeFsAdapter.readTextFileIfExists(absolutePath),
    appendTextFile: (absolutePath, text) => nodeFsAdapter.appendTextFile(absolutePath, text),
    makeDirectory: (absoluteDir) => nodeFsAdapter.makeDirectory(absoluteDir),
    exists: (absolutePath) => nodeFsAdapter.exists(absolutePath),
    /**
     * Politikos failas rašomas ATOMIŠKAI: jį lygiagrečiai skaito ir loop'as, ir dashboard'as, o
     * pusiau įrašytas JSON ten virstų „konfigo nėra" — t. y. tyliu numatytųjų reikšmių grįžimu.
     */
    writeTextFile: (absolutePath, content) => nodeFsAdapter.writeTextFileAtomic(absolutePath, content),
  },
};

/** Visi pasiūlymai su sprendimų istorija: `{ proposals }` — būtent tai skaito `ui-app`. */
export function listPolicyProposals(runtimeRoot: string): Promise<unknown> {
  return listPolicyProposalsUseCase(policyServicePorts, runtimeRoot);
}

/**
 * Naujas pasiūlymas grupei. `old_value`, `timestamp` ir `routing` ateina iš politikų loaderių,
 * o ne iš kliento; reikšmė validuojama prieš failo schemą DAR PRIEŠ siūlant.
 */
export async function proposePolicyChange(
  runtimeRoot: string,
  group: PolicyProposalGroup,
  input: PolicyProposalInput,
): Promise<{ proposal: unknown }> {
  const proposal = await buildPolicyProposal(
    policyServicePorts,
    runtimeRoot,
    group,
    input.setting_id,
    input.requested_value,
    input.reason,
  );
  await appendPolicyProposal(policyServicePorts.fs, runtimeRoot, proposal);
  return { proposal };
}

/** approve/reject/apply per pilnus governance vartus; grąžina atnaujintą `{ proposals }`. */
export function decidePolicyProposal(
  runtimeRoot: string,
  verb: PolicyDecisionVerb,
  input: PolicyDecisionRequest,
): Promise<unknown> {
  return decidePolicyProposalUseCase(policyServicePorts, runtimeRoot, verb, {
    policy_file: input.policy_file,
    setting_id: input.setting_id,
    actor: UI_ACTOR,
    reason: input.reason,
  });
}
