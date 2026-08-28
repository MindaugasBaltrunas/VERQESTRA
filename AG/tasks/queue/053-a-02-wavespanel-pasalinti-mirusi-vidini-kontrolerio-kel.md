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
