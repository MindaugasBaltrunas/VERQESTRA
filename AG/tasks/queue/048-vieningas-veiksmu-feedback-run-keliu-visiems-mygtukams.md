# Task

## Spec source
openspec/changes/verqestra-backlog-v1

## Žingsnis 0 — ar jau įgyvendinta?
Jei `resumeLoop` ir `reload` eina per tą patį `useOperatorActions.run()` kelią
(pending užraktas + toast), o `canResume` skaičiuojamas iš ciklo BŪSENOS, ne iš
etiketės teksto — ALREADY_IMPLEMENTED.

## Tikslas
2026-08-27 UI auditas: veiksmai be grįžtamojo ryšio ir be apsaugos.
(a) `resumeLoop` (`ui-app/src/controller/useDashboardController.ts:238-252`)
apeina `run()` — nėra `pendingActions` užrakto (du greiti paspaudimai = dvi POST)
ir jokio toast'o. (b) „Atnaujinti būseną"/„Tikrinti dar kartą"
(`RuntimePanel.tsx:182,267`) kviečia `actions.reload()` be jokio busy/klaidos
signalo prie mygtuko — klaida rodoma tik puslapio viršuje. (c) `canResume`
lygina etiketės TEKSTĄ (`useDashboardController.ts:67-77`:
`resumeLabel === "▶ Start loop"`) — po klaidos mygtukas užsidaro dėl teksto.

## Agentai
readme-guard -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `ui-app/src/controller/useDashboardController.ts`
- `ui-app/src/controller/useOperatorActions.ts`
- `ui-app/src/view/components/RuntimePanel.tsx`
- `ui-app/src/view/components/Header.tsx`
- `ui-app/src/tests/**`

Draudžiama:
- `src/**`
- `dist/**`
- `node_modules/**`

## Veiksmas
- `resumeLoop` perleisti per `run()` (kaip `stopLoop`/`startLoopWithWorkers`).
- `reload` mygtukams: `aria-busy` + disabled kol vyksta; nesėkmė — žinutė prie
  mygtuko arba toast, ne tik `refreshError` juosta viršuje.
- `canResume` išvesti iš `loopRunState`/pending būsenos, ne iš `resumeLabel`.
- Testai: dvigubas paspaudimas siunčia vieną POST; klaidos būsena neužrakina
  mygtuko amžinai.

## Patikra
- `pnpm typecheck:ui`
- `pnpm test:ui`

## Stop
Commit'ink, kai abi patikros žalios.

## Neįtraukta
Dviejų „Paleisti" kelių suvienijimas ir etikečių i18n (049). Per-proceso
„Tikrinti dar kartą" semantika (052).
