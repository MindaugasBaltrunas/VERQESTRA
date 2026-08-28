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
`loopControlsViewModel.ts:107-109` `startStreamCount` ir `LoopControls.tsx:20` `WORKER_CHOICES = [1, 2]` ignoruoja `workerControl.max`: kai max=1, W2 lieka pasirenkamas ir kiekviena banga tą prašymą atmes. Šioje užduotyje tvarkomas TIK grynas modelio sluoksnis — pasirinkimų sąrašas išvedamas iš `max`, o ne iš konstantos. UI komponento neliesk (atskira užduotis).

## Agentai
Privaloma grandinė: readme-guard -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `ui-app/src/model/loopControlsViewModel.ts`
- `ui-app/src/model/loopControlsViewModel.test.ts`

Draudžiama:
- `src/**`
- `ui-app/src/view/**`
- `ui-app/src/model/dashboardViewModel.ts`
- `dist/**`
- `node_modules/**`

## Veiksmas
- Pridėk grynąją funkciją (pvz. `workerChoices(workerControl)`), grąžinančią srautų pasirinkimus su `available` vėliava ir mašinine neprieinamumo priežastimi; `max` viršijantys pasirinkimai — neprieinami.
- Būtina sąlyga: `dashboardViewModel.ts:239-242` sako, kad `max === 0` reiškia „nežinoma" (bangos dar nebuvo) — tada pasirinkimai NEribojami (lieka 1 ir 2), kitaip valdiklis liktų be mygtukų. Šią sąlygą užrašyk komentaru.
- `startStreamCount` apribok tuo pačiu žinomu `max` ir padenk testais atvejus: max=0, max=1, max=2, `workerControl` nėra.

## Patikra
- `pnpm typecheck:ui`
- `pnpm test:ui`

## Stop
Commit'ink, kai abi patikros žalios. Sustok, jei pasirinkimų riba reikalautų keisti `dashboardViewModel.ts` kontraktą — tai ne šios užduoties apimtis.

## Neįtraukta
LoopControls.tsx mygtukų būsenos modelis ir i18n raktai (kita užduotis). EtaBadge (kita užduotis). Drain/abort mygtukai (050).
