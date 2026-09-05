# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Žingsnis 0 — ar jau įgyvendinta?
Jei `src/application/policy-governance/policy-proposals-log.ts` `resolveProposals` (181-190 eil.)
sprendimus filtruoja ne vien per `matchesRef`, o pagal pasiūlymo tapatybę (sprendimo laukas
`proposal_timestamp`/`proposal_id` ARBA laiko langas tarp šio ir kito to paties `(policy_file,
setting_id)` pasiūlymo), ir `src/tests/policy-proposals.test.ts` tvirtina „propose X → reject →
propose Y → Y yra `pending`" — ALREADY_IMPLEMENTED: cituok filtrą ir testą.

## Tikslas
Pilnas auditas 2026-09-05 (`docs/audits/full-audit-2026-09-05.md`, A2 ✓; application PG-1).
`policy-proposals-log.ts:151-190`: `resolveProposalStatus` = PASKUTINIS sprendimas `(policy_file,
setting_id)` nuorodai; `resolveProposals` istoriją filtruoja tik `matchesRef`, be pasiūlymo tapatybės.
Scenarijai: (a) propose X → reject → propose Y: Y iškart `rejected`, `cancel` meta
`ProposalCancelConflictError` (`policy-proposal-service.ts:241-251`); (b) propose A → approve
(nepritaikyta) → propose B: B iškart `approved`, o `apply` (254-263 eil., `reverse().find(status ===
"approved")`) pritaiko B be niekieno sprendimo. `countPendingProposals` (204 eil., final-audit
`unresolved-proposal`) nuvertina. Testas `policy-proposals.test.ts:219-224` pina tik ref lygio semantiką.
Kryptis: sprendimas rišamas prie pasiūlymo. Schemoje `policyDecisionSchema` — naujas neprivalomas
laukas `proposal_timestamp` (pasiūlymo `timestamp` yra jo vienintelis stabilus id, nes `proposals.jsonl`
append-only); naujos rašymo operacijos jį VISADA užpildo; seniems įrašams be lauko — fallback:
sprendimas priklauso pasiūlymui, kurio `timestamp <= decision.timestamp < kito to paties ref
pasiūlymo timestamp`. `apply` ima paskutinį `approved` pagal TĄ PAČIĄ tapatybę. Atmesta alternatyva
„naujas `proposal_id` UUID": jis reikalautų keisti `policyProposalSchema` ir visus rašytojus per
HTTP/CLI (svetimas scope); `timestamp` jau yra.

## Agentai
readme-guard -> architect -> schedule-domain -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/application/policy-governance/policy-proposals-log.ts` (`policyDecisionSchema` 35-42, `PolicyDecisionInput` 96-102, `resolveProposalStatus`/`resolveProposals` 158-190, `countPendingProposals` 204 eil.)
- `src/application/policy-governance/policy-proposal-service.ts` (verbų kelias 225-263 eil.: sprendimas užpildo `proposal_timestamp`; `apply`/`cancel` ieško pagal tapatybę)
- `src/tests/policy-proposals.test.ts`

Draudžiama:
- `src/interfaces/**` (HTTP/CLI kontraktai nekinta — laukas neprivalomas ir užpildomas service viduje)
- `src/composition/quality/final-audit-adapters.ts` (kvietėjas `countPendingProposals`, nekinta)
- `ui-app/**`
- `dist/**`
- `node_modules/**`

## Veiksmas
- `policy-proposals-log.ts`: `policyDecisionSchema` + `proposal_timestamp: z.string().min(1).optional()`;
  `resolveProposals` kiekvienam pasiūlymui istoriją renka per `decisionBelongsToProposal(decision,
  proposal, nextProposalTimestamp)`; `resolveProposalStatus` viešas kontraktas išlieka, bet doc'as
  sako, kad tai ref lygio sutrumpinimas, o tikroji tiesa — `resolveProposals`. `countPendingProposals`
  skaičiuoja per `resolveProposals`.
- `policy-proposal-service.ts`: `approve`/`reject`/`cancel`/`apply` prieš rašydami suranda NAUJAUSIĄ
  pasiūlymą tam ref'ui ir įrašo jo `timestamp` į sprendimą; `apply` renkasi `approved` tik su tapatybe.
- Testai: (a) X reject → Y pending, Y cancel leidžiamas; (b) A approve → B pending, `apply` be B
  sprendimo meta `ProposalNotApprovedError`; (c) senas žurnalas be `proposal_timestamp` — laiko lango
  fallback duoda tą patį rezultatą kaip iki šiol vieno pasiūlymo atveju; (d) `countPendingProposals`
  po (a) = 1. Esami `policy-proposals.test.ts:219-224` ref lygio testai lieka žali.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei `interfaces-http-router-contracts.test.ts` ar
`interfaces-cli-admin.test.ts` nudažomi raudonai dėl `PolicyDecision` formos (kontraktų testai ne
šio scope) — tada laukas turi likti nematomas kontrakte, o tapatybė spręsti tik laiko langu.

## Neįtraukta
- UI `PolicyProposalsPanel` dvigubas Apply (`inFlight`) — UI P2, kitas autorius.
- Serverio no-op pasiūlymo atmetimas (task 103, done) — nekinta.
- `human-review` routing'o marker'io logika (`humanReviewApprovalMarkerPath`) — nekinta.
