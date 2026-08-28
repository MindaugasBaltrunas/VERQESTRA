# Task

## Spec source
openspec/changes/verqestra-backlog-v1

## Žingsnis 0 — ar jau įgyvendinta?
Jei skaičių/baitų formatavimas naudoja aktyvų `locale` (ne prikaltą `lt-LT`),
`WavesPanel` nebeinstancijuoja negyvo vidinio kontrolerio, request timeout
mažesnis už polling intervalą, o `refreshAll` nebedidina `proposalRefreshToken`
maršrute be `PolicyProposalsPanel` — ALREADY_IMPLEMENTED.

## Tikslas
2026-08-27 UI audito higienos likučiai: (a) `TokenBudgetPanel.tsx:17` ir
`DiagnosticsPanel.tsx:18` — `Intl.NumberFormat("lt-LT")` ignoruoja `locale`,
nors datos tame pačiame faile jį naudoja (`DiagnosticsPanel.tsx:21-26`).
(b) `WavesPanel.tsx:53` — `useWavesController({enabled: props.onReload ===
undefined})`; `DashboardPage.tsx:298` `onReload` perduoda visada, tad hook'as
ir jo `data`/`error`/`reload` šakos (`:54-56`) produkcijoje mirusios.
(c) `REQUEST_TIMEOUT_MS = 30_000` (`model/api.ts:33`) == `REFRESH_SEC`/`WAVES_POLL_MS`
(30 s) — lėtam serveriui užklausos persidengia ir `requestSequence`
(`useDashboardController.ts:162-165`) tyliai meta rezultatus. (d)
`DashboardPage.tsx:53-56` — `refreshAll` didina `proposalRefreshToken`, nors
`PolicyProposalsPanel` `#/system` maršrute nemontuojamas (`:240`).

## Agentai
readme-guard -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `ui-app/src/view/components/TokenBudgetPanel.tsx`
- `ui-app/src/view/components/TokenBudgetPanel.test.tsx` (numatomas naujas)
- `ui-app/src/view/components/DiagnosticsPanel.tsx`
- `ui-app/src/view/components/DiagnosticsPanel.test.tsx`
- `ui-app/src/view/components/WavesPanel.tsx`
- `ui-app/src/view/components/WavesPanel.test.tsx`
- `ui-app/src/view/pages/DashboardPage.tsx`
- `ui-app/src/model/api.ts`
- `ui-app/src/model/apiEnvelopes.test.ts`

Draudžiama:
- `src/**`
- `ui-app/src/controller/useDashboardController.ts`
- `dist/**`
- `node_modules/**`

## Veiksmas
- Skaičių/baitų formatterius parametrizuoti aktyviu `locale`.
- `WavesPanel`: pašalinti vidinį kontrolerio fallback'ą — duomenys ateina tik
  per props (arba atvirkščiai, bet VIENAS kelias).
- `REQUEST_TIMEOUT_MS` sumažinti (pvz. 15 s) arba polling intervalus padidinti,
  kad užklausos nepersidengtų su savo pačių kartojimu.
- `refreshAll` nebeliesti `proposalRefreshToken`, kai panelė nemontuojama
  (perduoti tik ten, kur ji yra).

## Patikra
- `pnpm typecheck:ui`
- `pnpm test:ui`

## Stop
Commit'ink, kai abi patikros žalios. Vykdyti PO 047 (WavesPanel liečiamas ten).

## Neįtraukta
Kontrolerio (`useDashboardController.ts`) pertvarka (048/049).
