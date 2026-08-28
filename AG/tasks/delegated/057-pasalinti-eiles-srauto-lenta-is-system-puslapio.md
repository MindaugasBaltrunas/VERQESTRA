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
Operatoriaus nurodymas (2026-08-28): pašalinti „Eilės srautas" (Queue pipeline) bloką iš `#/system` puslapio — jis dubliuoja Tasks puslapio ir WavesPanel informaciją. Ši dalis atjungia bloką nuo renderio ir ištrina jo komponentą bei viewmodel'į. Trynimas čia yra užduoties esmė pagal tiesioginį operatoriaus nurodymą, o ne šalutinis efektas: `dead-export-gate.test.ts` neleidžia palikti eksporto be kvietėjo.

## Agentai
Privaloma grandinė: readme-guard -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `ui-app/src/view/pages/DashboardPage.tsx`
- `ui-app/src/view/components/QueuePipelineBoard.tsx` (TRINAMAS)
- `ui-app/src/view/components/QueuePipelineBoard.test.tsx` (TRINAMAS)
- `ui-app/src/model/queuePipelineViewModel.ts` (TRINAMAS)
- `ui-app/src/model/queuePipelineViewModel.test.ts` (TRINAMAS)

Draudžiama:
- `ui-app/src/controller/**`
- `ui-app/src/model/api.ts`
- `ui-app/src/view/styles/dashboard.css`
- `ui-app/src/i18n/I18nContext.tsx`
- `src/**`
- `dist/**`
- `node_modules/**`

## Veiksmas
- `DashboardPage.tsx`: išimti `QueuePipelineBoard` ir `buildQueuePipeline` importus, `const pipeline = useMemo(...)` skaičiavimą (~94 eil.) ir renderio eilutę `{activeRoute === "system" && pipeline && ...}` (~303 eil.); nenaudojamų likusių importų nepalikti.
- Ištrinti keturis TRINAMAS pažymėtus failus.
- Grep'u patvirtinti, kad `QueuePipelineBoard` ir `buildQueuePipeline` nebeminimi jokiame `ui-app/src` faile (išskyrus komentarus, kurie tvarkomi kitoje dalyje).

## Patikra
- `pnpm typecheck && pnpm test`

## Stop
Commit'ink, kai abi patikros žalios. Sustok ir klausk, jei bet kuris vartas reikalautų liesti draudžiamus failus.

## Neįtraukta
`dashboard.css` „Queue pipeline board" sekcija, i18n raktai, pasenę komentarai (`WavesPanel.tsx`, `types.ts`) ir `ui-app/dist` perbuildas — antra dalis. Serverio `pipeline`/scheduler duomenų šaltinis `src/**` lieka nepaliestas. Kiti `#/system` blokai (RuntimePanel, TokenBudgetPanel, WavesPanel, DiagnosticsPanel) neliečiami.
