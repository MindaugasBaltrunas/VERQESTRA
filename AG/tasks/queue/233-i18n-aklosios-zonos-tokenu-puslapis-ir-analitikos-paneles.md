# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Priklausomybės
- 231-neskaitomi-api-laukai-rodomi-waves-ir-compression-ir-css-akloji-zona

## Žingsnis 0 — ar jau įgyvendinta?
Jei `AnalyticsDecisionPanel.tsx:21-22` `Intl.NumberFormat` gauna `useI18n().locale` (ne `undefined`),
`TokenUsagePage.tsx:170` `description=` literalas eina per `t()` (kaip kaimynas `:175`), o
`TokenUsageSummaryPanel.tsx:57` LT `title` — per žodyno raktą — ALREADY_IMPLEMENTED: cituok tris eilutes.

## Tikslas
Pilnas auditas 2026-09-05 (`docs/audits/full-audit-2026-09-05.md`, UI P2; `scratchpad/audit-ui.md` F6),
antra tokens partija po task 229 (8 kelių riba): `AnalyticsDecisionPanel.tsx:21-22`
`Intl.NumberFormat(undefined, …)` — naršyklės, ne UI kalba (LT UI su EN naršykle rodo EN procentus);
`TokenUsagePage.tsx:170` `description=` literalas be rakto, nors kaimynas `:175` eina per `t()`;
`TokenUsageSummaryPanel.tsx:57` LT `title` literalas — EN režime lietuviškai. `i18n-coverage` vartas
literalų be `t()` nemato — sargu tampa komponentų testai abiem kalbomis. `locale` jau eksponuoja
`I18nContext` (task 229) — čia tik vartotojai.

## Agentai
readme-guard -> architect -> coder -> reviewer -> i18n -> tester

## Failai
Leidžiama:
- `ui-app/src/view/components/tokens/AnalyticsDecisionPanel.tsx` (21-22 eil.)
- `ui-app/src/view/pages/TokenUsagePage.tsx` (170 eil.)
- `ui-app/src/view/components/tokens/TokenUsageSummaryPanel.tsx` (57 eil.)
- `ui-app/src/i18n/I18nContext.tsx`
- `ui-app/src/view/styles/11-token-usage.css` (naujų klasių nenumatoma; deklaruota CSS varto reikalavimu)
- `ui-app/src/tests/view/components/tokens/AnalyticsDecisionPanel.test.tsx`
- `ui-app/src/tests/view/pages/TokenUsagePage.test.tsx`
- `ui-app/src/tests/view/components/tokens/TokenUsageSummaryPanel.test.tsx` (numatomas naujas — komponentas testo neturi, §5c)

Draudžiama:
- `ui-app/src/view/components/tokens/TopTasksTable.tsx`, `UsageBreakdownChart.tsx`, `TokenAnalyticsSnapshotPanel.tsx` (task 229)
- `ui-app/src/view/pages/ReliabilityPage.tsx`, `ui-app/src/controller/useDashboardController.ts` (P3 — žr. Neįtraukta)
- `ui-app/src/tests/gates/i18n-coverage.test.ts` (task 236)
- `dist/**`
- `node_modules/**`

## Veiksmas
- `AnalyticsDecisionPanel.tsx`: abu `Intl.NumberFormat(undefined, …)` → `locale` iš `useI18n()`
  (formatavimo helper'is komponento viduje, kad `pp`/`percent` šakos liktų vienoje vietoje).
- `TokenUsagePage.tsx:170`: `description={t("…")}` su LT+EN raktais; `TokenUsageSummaryPanel.tsx:57`:
  `title` per žodyno raktą (LT tekstas tampa LT vertimu, EN — raktu).
- Testai: `AnalyticsDecisionPanel` LT/EN renderis su ta pačia reikšme duoda skirtingus skirtukus;
  `TokenUsagePage` EN DOM'e nėra lietuviško `description`; naujas `TokenUsageSummaryPanel.test.tsx` —
  `title` abiem kalbomis ir bazinis renderis (kortelės su `summary` fixture).
- Nauji raktai į `I18nContext.tsx`; `11-token-usage.css` — tik jei prireiktų klasės (CSS vartas).

## Patikra
- `pnpm build`
- `pnpm test`
- `pnpm --dir ui-app build`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei `TokenUsageSummaryPanel` prop'ų forma reikalauja
fixture'o, kurio nėra kituose testuose (`tokenUsageViewModel.test.ts` gali turėti tinkamą) — testas
rašomas su realiu view-model'iu, ne su rankiniu objektu.

## Neįtraukta
- `ReliabilityPage.tsx:70` `fixRate: 1` tuščiam laikotarpiui („Fix rate 100 %"), `useDashboardController.ts:194-206`
  negyvi `eslint-disable`, `useDashboardController.load` priklausomybė nuo `t` (kalbos perjungimas
  perstato intervalą), `uploadTaskFiles` klaida dukart (`DashboardPage.tsx:385-387`) — audito P3, atskira
  smulkmenų partija po šios grandinės.
- `WavesPanel` ISO žymų formatavimas — task 231.
- Vartas dinaminiams raktams — task 236.
