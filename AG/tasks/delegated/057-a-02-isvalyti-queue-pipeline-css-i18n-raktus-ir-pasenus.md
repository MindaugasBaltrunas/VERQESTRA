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
Užbaigti „Eilės srauto" (Queue pipeline) bloko šalinimą iš `#/system`: po to, kai `QueuePipelineBoard` ir `queuePipelineViewModel` jau ištrinti, pašalinti likusius jų pėdsakus — CSS sekciją, tik jų naudotus i18n raktus ir pasenusius komentarus — bei perbuildinti `ui-app/dist`, iš kurio serveris atiduoda dashboard'ą.

## Agentai
Privaloma grandinė: readme-guard -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `ui-app/src/view/styles/dashboard.css`
- `ui-app/src/i18n/I18nContext.tsx`
- `ui-app/src/view/components/WavesPanel.tsx` (TIK pasenęs komentaras ~42 eil.)
- `ui-app/src/model/types.ts` (TIK komentaro eilutė ~738 apie queuePipelineViewModel)

Draudžiama:
- `ui-app/src/view/pages/DashboardPage.tsx`
- `ui-app/src/controller/**`
- `ui-app/src/model/api.ts`
- `src/**`
- `node_modules/**`

## Veiksmas
- `dashboard.css`: prieš trinant grep'u patikrinti, kad `pipeline-*` klasių nenaudoja joks TSX, tada išimti „Queue pipeline board" sekciją (~1758–1833) ir responsive taisykles `.pipeline-board` (~3589, ~3600).
- `I18nContext.tsx`: išimti raktus, kuriuos naudojo TIK QueuePipelineBoard („Queue pipeline" ir stulpelių pavadinimai) — kiekvieną prieš trinant patikrinti grep'u, kad jo nenaudoja kitas komponentas.
- Pasenusius komentarus `WavesPanel.tsx` (~42 eil.) ir `types.ts` (~738 eil.) perrašyti arba pašalinti, kad neliktų nuorodos į nebeegzistuojantį komponentą; pabaigoje paleisti `pnpm --dir ui-app build`.

## Patikra
- `pnpm typecheck && pnpm test`
- `pnpm --dir ui-app build`

## Stop
Commit'ink, kai patikros žalios. Sustok ir klausk, jei CSS ar i18n raktas pasirodo naudojamas kito komponento.

## Neįtraukta
Serverio pusė: `/api` `pipeline`/scheduler duomenų šaltinis lieka — miręs SERVERIO eksportas, jei toks atsiras, yra atskiro audito sprendimas. Kiti `#/system` blokai neliečiami; `DashboardPage.tsx` jau sutvarkytas ankstesnėje dalyje.
