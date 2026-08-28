# Task

HUMAN-REVIEW-APPROVED: mindebaltru 2026-08-28 operatoriaus nurodymas — „Sprendimų eilė / Politikų pakeitimai: galima atšaukti"

## Spec source
openspec/changes/verqestra-backlog-v1

## Priklausomybės
- 066-policy-forma-be-privalomos-priezasties-ir-selectmenu-poliravimas

## Žingsnis 0 — ar jau įgyvendinta?
Jei „Policy changes" (Decision queue) bloke prie pending/approved pasiūlymo
yra „Atšaukti" veiksmas, o serveris turi `cancel` verb'ą su `cancelled`
statusu žurnale — ALREADY_IMPLEMENTED.

## Tikslas
Sprendimų eilėje pasiūlymą šiandien galima tik approve/reject/apply —
operatorius, apsigalvojęs dėl SAVO pasiūlymo, negali jo atsiimti ir turi
naudoti „reject", kuris semantiškai reiškia svetimo pasiūlymo atmetimą.

Pridėti atšaukimą:

- **Serveris**: naujas sprendimo verb'as `cancel` greta approve/reject/apply
  (`PolicyDecisionVerb`, `decidePolicyProposal`, HTTP route regex
  `/api/policies/proposals/(approve|reject|apply|cancel)`). Append-only
  žurnale — naujas statusas `cancelled`. Atšaukti galima `pending` ir
  `approved` (dar nepritaikytą) pasiūlymą; `applied`/`rejected` — 409 su
  paaiškinimu. Žurnalas lieka append-only — atšaukimas yra naujas įrašas,
  ne trynimas.
- **UI** (`PolicyProposalsPanel`, `ui-app/src/App.tsx`): prie
  pending/approved pasiūlymo — mygtukas „Atšaukti" su dviejų žingsnių
  patvirtinimu (kaip HumanReviewPanel); atšauktas pasiūlymas keliauja į
  History skirtuką su `cancelled` ženkleliu. `PolicyControlsPanel` kortelės
  „Pending proposal" blokas atšauktų neberodo.

## Agentai
readme-guard -> architect -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/application/policy-governance/policy-proposal-service.ts`
- `src/application/policy-governance/policy-proposals-log.ts`
- `src/interfaces/http/ui-router-mutations.ts`
- `src/tests/interfaces-http-router.test.ts`
- `src/tests/policy-governance-proposals.test.ts` (numatomas; jei testas
  gyvena kitame faile — tas failas vietoje šio, įrašyti į ataskaitą)
- `ui-app/src/App.tsx`
- `ui-app/src/App.test.tsx`
- `ui-app/src/model/api.ts`
- `ui-app/src/model/types.ts`
- `ui-app/src/i18n/I18nContext.tsx`
- `ui-app/src/view/styles/dashboard.css`

Draudžiama:
- Žurnalo įrašų trynimas ar perrašymas (append-only invariantas)
- `dist/**`
- `node_modules/**`

## Patikra
- `pnpm build`
- `pnpm test`
- `pnpm --dir ui-app build`

## Stop
Commit'ink, kai patikros žalios.

## Neįtraukta
Jau PRITAIKYTŲ (`applied`) pakeitimų atstatymas — tai daroma pasiūlant
seną reikšmę atgal, ne „undo" mygtuku (audito grandinė lieka tiesi).
Masinis atšaukimas. Kitų Reviews blokų keitimai.
