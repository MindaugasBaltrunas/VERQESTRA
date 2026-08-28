# Task

## Spec source
openspec/changes/verqestra-backlog-v1

## Žingsnis 0 — ar jau įgyvendinta?
Jei W1 mygtukas requested=1 būsenoje nebeatrodo kaip paspaudžiamas pažadas
(tooltip nebežada „Click to keep only W1", kai jis disabled), srautų
pasirinkimas ribojamas pagal `workerControl.max`, o ETA ženklelis srauto
kortelėse arba gauna realius duomenis, arba nepiešiamas — ALREADY_IMPLEMENTED.

## Tikslas
2026-08-27 UI auditas: (a) `LoopControls.tsx:95-97` — W1 mygtukas numatytoje
būsenoje (`requested === 1`) amžinai disabled, bet jo `title` žada „Click to
keep only W1"; aktyvi būsena turi būti rodoma kaip BŪSENA (pažymėtas), ne kaip
išjungtas mygtukas su klaidinančiu tooltip'u. (b) `WORKER_CHOICES = [1, 2]`
(`:20`) ir `startStreamCount` (`loopControlsViewModel.ts:107-109`) ignoruoja
`workerControl.max` (`dashboardViewModel.ts:216,242`) — kai max=1, W2 vis tiek
aktyvus ir kiekviena banga prašymą atmes. (c) `SlotProgressCard.tsx:134` visada
piešia `EtaBadge`, bet `DashboardPage.tsx:69-79` `etas` neperduoda —
`resolveEta(undefined)` visada `{state:"unavailable"}`: negyvas valdiklis
kiekvienoje kortelėje.

## Agentai
readme-guard -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `ui-app/src/view/components/LoopControls.tsx`
- `ui-app/src/view/components/LoopControls.test.tsx`
- `ui-app/src/model/loopControlsViewModel.ts`
- `ui-app/src/model/loopControlsViewModel.test.ts`
- `ui-app/src/view/components/SlotProgressCard.tsx`
- `ui-app/src/view/components/SlotProgressCard.test.tsx`
- `ui-app/src/view/pages/DashboardPage.tsx`
- `ui-app/src/i18n/I18nContext.tsx` (nauji raktai tooltip'ams/priežastims — be jų
  `i18n/coverage.test.ts` raudonas)

Draudžiama:
- `src/**`
- `ui-app/src/model/api.ts`
- `dist/**`
- `node_modules/**`

## Veiksmas
- W1/W2 mygtukus paversti radio/segmented-state modeliu: aktyvus pasirinkimas
  pažymėtas, neaktyvus paspaudžiamas; tooltip atitinka realią galimybę.
- Pasirinkimus generuoti iš `workerControl.max` (1..max), ne iš konstantos.
- ETA: perduoti `etas` iš `DashboardPage` į korteles ARBA nepiešti `EtaBadge`,
  kol šaltinio nėra — vienas sprendimas, dokumentuotas komentaru.
- Testai: max=1 → W2 nerodomas/disabled su teisinga priežastimi.

## Patikra
- `pnpm typecheck:ui`
- `pnpm test:ui`

## Stop
Commit'ink, kai abi patikros žalios.

## Neįtraukta
Drain/abort mygtukai (050). ETA skaičiavimo backend'as.
