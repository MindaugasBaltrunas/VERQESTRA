# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Tikslas
`REQUEST_TIMEOUT_MS = 30_000` (`ui-app/src/model/api.ts:33`) yra lygus polling intervalams (`useDashboardController` `REFRESH_SEC = 30`, `useWavesController` `WAVES_POLL_MS = 30_000`). Lėtam serveriui užklausa dar nenutraukta, kai startuoja kita, ir `requestSequence` tyliai meta rezultatus. Timeout privalo būti aiškiai mažesnis už pollingo periodą.

## Agentai
Privaloma grandinė: readme-guard -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `ui-app/src/model/api.ts`
- `ui-app/src/model/apiEnvelopes.test.ts`

Draudžiama:
- `src/**`
- `ui-app/src/controller/**`
- `ui-app/src/view/**`
- `dist/**`
- `node_modules/**`

## Veiksmas
- Sumažinti `REQUEST_TIMEOUT_MS` iki 15_000 ir komentare įrašyti invariantą: timeout < trumpiausio pollingo periodo (30 s), kad užklausa nepersidengtų su savo pačios kartojimu.
- Patikrinti, kad timeout klaidos tekstas (`api.ts:56`) lieka teisingas naujai reikšmei.
- Testu užfiksuoti, kad `AbortSignal` nutraukia užklausą su timeout klaida ir kad konstanta mažesnė už 30 s.

## Patikra
- `pnpm typecheck:ui`
- `pnpm test:ui`

## Stop
Commit'ink tik kai abi patikros žalios. Jei atrodo, kad teisingas sprendimas yra didinti pollingo intervalus kontroleriuose — sustok ir pranešk, nes kontroleriai už scope ribų.

## Neįtraukta
Pollingo intervalų keitimas kontroleriuose, `useDashboardController` pertvarka, locale formatteriai, `WavesPanel` ir `proposalRefreshToken` darbai.
