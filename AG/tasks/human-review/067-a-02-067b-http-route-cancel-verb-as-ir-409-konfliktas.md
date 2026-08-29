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
openspec/changes/verqestra-backlog-v1 (task 067, 2/3 dalis; priklauso nuo 067 1/3)

## Tikslas
Atverti 'cancel' sprendima per HTTP: route regex `/api/policies/proposals/(approve|reject|apply|cancel)`, o application sluoksnio konfliktas ('applied' arba 'rejected' pasiulymas) grazinamas kaip 409 su paaiskinimu.

## Agentai
Privaloma naudoti butent sia grandine: readme-guard -> coder -> reviewer -> tester

## Failai
Leidziama:
- `src/interfaces/http/ui-router-mutations.ts`
- `src/tests/interfaces-http-router.test.ts`

Draudziama:
- `src/application/policy-governance/policy-proposal-service.ts`
- `ui-app/src/App.tsx`
- `dist/**`
- `node_modules/**`

## Veiksmas
- Prideti 'cancel' i sprendimo route regex ir verb'o validacija; efektas gaunamas per esama porta, jokios naujos business logikos interfaces sluoksnyje.
- Application konflikto rezultata atvaizduoti i HTTP 409 su paaiskinimo tekstu; sekmingas atsaukimas - kaip kiti verb'ai.
- Testai: cancel grazina sekme pending/approved atveju, 409 applied/rejected atveju, nezinomas verb'as lieka atmestas.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai abi patikros zalios. Sustok, jei paaisketu, kad application sluoksnyje 'cancel' dar nera - tada blokuok, nes 1/3 dalis nebaigta.

## Neitraukta
Application logika ir zurnalo statusas (1/3 dalis). UI mygtukas, i18n, CSS, History zenklelis (3/3 dalis). Masinis atsaukimas.
