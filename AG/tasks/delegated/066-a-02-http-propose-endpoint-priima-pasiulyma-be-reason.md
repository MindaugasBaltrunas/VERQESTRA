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
`POST` policy propose endpoint'as priima pasiūlymą be `reason` (arba su tuščiu) ir įrašo `reason: ""`. Prieš tai application sluoksnis jau atlaisvintas. Operatoriaus patvirtintas kontrakto pakeitimas (2026-08-28).
Jei endpoint'as jau priima kūną be `reason` — ALREADY_IMPLEMENTED, nieko nekeisk.

## Agentai
Privaloma grandinė (nenukrypti): readme-guard -> coder -> reviewer -> tester.

## Failai
Leidžiama:
- `src/interfaces/http/ui-router-mutations.ts`
- `src/tests/composition-ui-policy-governance.test.ts`
- `src/tests/interfaces-http-router-contracts.test.ts` (HUMAN-REVIEW-APPROVED:
  mindebaltru 2026-08-29 — kontraktų testas privalo atspindėti nebeprivalomą reason, legalizuota)

Draudžiama:
- `src/application/policy-governance/policy-proposals-log.ts`
- `ui-app/src/model/api.ts`
- `dist/**`
- `node_modules/**`

## Veiksmas
- Propose šakoje `reason` nebeprivalomas: trūkstamas ar tuščias virsta `""`; 400 lieka tik dėl `setting_id`, klaidos tekstas atitinkamai patikslinamas; JSDoc apie klientą atnaujinamas.
- Decision (approve/reject/apply) šaka NEKEIČIAMA — ten `reason` lieka kaip buvo.
- `src/tests/composition-ui-policy-governance.test.ts`: testas, kad kūnas be `reason` grąžina sėkmę ir įrašo `reason: ""`, o kūnas be `setting_id` toliau 400.

## Patikra
- `pnpm typecheck`
- `pnpm test`

## Stop
Commit'ink, kai abi patikros žalios. Sustok, jei tektų keisti application schemą ar decision kelio kontraktą.

## Neįtraukta
UI forma ir SelectMenu. Decisions `reason`. Pasiūlymų atšaukimas (067).
