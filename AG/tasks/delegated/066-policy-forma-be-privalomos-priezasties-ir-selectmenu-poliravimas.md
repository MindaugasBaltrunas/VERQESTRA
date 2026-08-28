## Žingsnis 0 — ar jau įgyvendinta?
Prieš keisdamas kodą patikrink, ar ## Tikslas ir ## Patikra jau tenkinami esamame kode.
Jei taip — NEDARYK jokių pakeitimų ir galutinę ataskaitą pradėk atskira eilute:
ALREADY_IMPLEMENTED: <failai/eilutės, įrodančios kad darbas jau padarytas>

## Sandbox taisyklės (privaloma — taupo turns)
- Po BET KOKIO `src` pakeitimo `dist` pasensta ir hook'ai blokuoja bash komandas. Pirma perbuild'ink TIKSLIA forma be pipe/redirect: `pnpm build`
- Patikroms naudok tik: `pnpm build` ir `pnpm test` (be `--`, be pipe į kitas komandas).
- `echo`, `sed`, `node -e` ir kompound komandos su neleistinais segmentais VISADA atmetamos — nekartok jų kitomis formomis; failams skaityti naudok Read/Grep tools.
- Rašymo darbą atlik PATS šioje sesijoje (Write/Edit) ir neatidėk jo vėlesniam laikui: headless sesija po paskutinio tavo žingsnio baigiasi, o bėgimas be nė vieno Write/Edit parkuojamas human-review. `## Agentai` grandinė yra orkestratoriaus maršruto metaduomuo — jei subagentas negrąžina rezultato šiame bėgime, įgyvendink pakeitimą tiesiogiai.

# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Tikslas
Policy pasiūlymo `reason` tampa neprivalomas application sluoksnyje: nepaduotas → `""`. Laukas žurnalo schemoje LIEKA (seni įrašai validūs), tik nebereikalauja ne tuščio teksto. Kontrakto pakeitimas operatoriaus užsakytas ir patvirtintas (HUMAN-REVIEW-APPROVED, 2026-08-28).
Jei `policyProposalSchema.reason` jau leidžia tuščią eilutę ir `buildPolicyProposal` veikia be `reason` — ALREADY_IMPLEMENTED, nieko nekeisk.

## Agentai
Privaloma grandinė (nenukrypti): readme-guard -> coder -> reviewer -> tester.

## Failai
Leidžiama:
- `src/application/policy-governance/policy-proposals-log.ts`
- `src/application/policy-governance/policy-proposal-service.ts`
- `src/tests/policy-proposals.test.ts`

Draudžiama:
- `src/interfaces/http/ui-router-mutations.ts`
- `ui-app/src/view/components/PolicyControlsPanel.tsx`
- `dist/**`
- `node_modules/**`

## Veiksmas
- `policyProposalSchema`: `reason: z.string().min(1)` → `z.string()`; laukas neišimamas, kiti laukai ir `policyDecisionSchema` nekeičiami.
- `buildPolicyProposal`: `reason` parametras neprivalomas, nepaduotas/`undefined` → `""` (laikytis `exactOptionalPropertyTypes`).
- `src/tests/policy-proposals.test.ts`: testai, kad pasiūlymas be `reason` sukuriamas ir įrašomas su `reason: ""`, o senas įrašas su tekstu lieka validus.

## Patikra
- `pnpm typecheck`
- `pnpm test`

## Stop
Commit'ink, kai abi patikros žalios. Sustok ir klausk, jei schemą reikėtų keisti plačiau nei `reason` min(1) atlaisvinimas arba jei prireiktų liesti neleistiną failą.

## Neįtraukta
HTTP propose endpoint, UI forma, SelectMenu poliravimas — atskiros nuoseklios užduotys. Decisions kelio `reason`. Pasiūlymų atšaukimas (067).
