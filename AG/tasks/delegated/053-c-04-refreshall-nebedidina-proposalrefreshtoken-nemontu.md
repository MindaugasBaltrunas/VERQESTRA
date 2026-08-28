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
`DashboardPage.tsx:53-56` `refreshAll` visada didina `proposalRefreshToken`, nors `PolicyProposalsPanel` montuojamas tik `#/reviews` maršrute (`DashboardPage.tsx:240`). Kituose maršrutuose tai state atnaujinimas be jokio skaitytojo — beprasmis re-renderis.

## Agentai
Privaloma grandinė: readme-guard -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `ui-app/src/view/pages/DashboardPage.tsx`

Draudžiama:
- `src/**`
- `ui-app/src/controller/**`
- `ui-app/src/model/**`
- `dist/**`
- `node_modules/**`

## Veiksmas
- `refreshAll` `proposalRefreshToken` didinti tik kai aktyvus maršrutas yra tas, kuriame `PolicyProposalsPanel` iš tikrųjų montuojamas.
- Komentaru užfiksuoti ryšį tarp token'o ir panelės montavimo vietos, kad ateityje nepatektų atgal į visus maršrutus.

## Patikra
- `pnpm typecheck:ui`
- `pnpm test:ui`

## Stop
Commit'ink tik kai abi patikros žalios. Jei paaiškėtų, kad `PolicyProposalsPanel` reikia atnaujinti ir iš kito maršruto — sustok ir pranešk, nesikeisk elgesio tyliai.

## Neįtraukta
Locale formatteriai, `WavesPanel` mirusio kelio šalinimas, `REQUEST_TIMEOUT_MS` keitimas, `useDashboardController` pertvarka (048/049).
