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
`WavesPanel.tsx:54-58` instancijuoja `useWavesController({ enabled: props.onReload === undefined })`, bet `DashboardPage.tsx:298` `onReload` perduoda visada — vidinio kontrolerio `data`/`error`/`loading`/`reload` šakos produkcijoje mirusios. Palikti VIENĄ duomenų kelią: per props.

## Agentai
Privaloma grandinė: readme-guard -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `ui-app/src/view/components/WavesPanel.tsx`
- `ui-app/src/view/components/WavesPanel.test.tsx`

Draudžiama:
- `src/**`
- `ui-app/src/controller/useWavesController.ts`
- `ui-app/src/controller/useDashboardController.ts`
- `dist/**`
- `node_modules/**`

## Veiksmas
- Pašalinti `useWavesController` iškvietimą iš `WavesPanel` ir palikti tik props kelią; `onReload` padaryti privalomu propsu, o tipus (`UiWavesView` ir kt.) importuoti type-only.
- Atnaujinti `WavesPanel.test.tsx`, kad testuotų tik props kelią, be kontrolerio stub'ų.
- Komentare paaiškinti, kodėl duomenys ateina tik iš viršaus (vienas pollingo srautas endpoint'ui).

## Patikra
- `pnpm typecheck:ui`
- `pnpm test:ui`

## Stop
Commit'ink tik kai abi patikros žalios. Jei `onReload` padarius privalomu atsiranda kitas kvietėjas be jo (ne `DashboardPage`) — sustok ir pranešk, nes tai keistų kontraktą už scope ribų.

## Neįtraukta
`useWavesController` vidaus pertvarka, `useDashboardController` pertvarka (048/049), locale formatteriai, timeout ir `proposalRefreshToken` darbai.
