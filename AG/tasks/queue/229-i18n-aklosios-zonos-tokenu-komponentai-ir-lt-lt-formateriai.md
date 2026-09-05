# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Priklausomybės
- 228-i18n-aklosios-zonos-dashboard-paneles

## Žingsnis 0 — ar jau įgyvendinta?
Jei `I18nContext.tsx` eksponuoja aktyvios kalbos `locale` (`lt-LT`/`en-US`), o `TopTasksTable.tsx:29-45`,
`UsageBreakdownChart.tsx:13-19`, `TokenAnalyticsSnapshotPanel.tsx:7-13` nebeturi literalo `"lt-LT"`
(grep `"lt-LT"` per `ui-app/src/view` = 0 šiuose failuose) ir `TopTasksTable.tsx:98,185`,
`UsageBreakdownChart.tsx:49` tekstai eina per `t()` — ALREADY_IMPLEMENTED: cituok grep ir `locale`.

## Tikslas
Pilnas auditas 2026-09-05 (`docs/audits/full-audit-2026-09-05.md`, UI P2; `scratchpad/audit-ui.md` F6):
hardcoded `"lt-LT"` formateriai `TopTasksTable.tsx:29-45`, `UsageBreakdownChart.tsx:13-19`,
`TokenAnalyticsSnapshotPanel.tsx:7-13` — EN režime LT skaičių formatas (`1 234,5` vietoje `1,234.5`);
tekstai be rakto: `TopTasksTable.tsx:98` „No data", `:185` „iš" (EN režime lietuviškai),
`UsageBreakdownChart.tsx:49`. `i18n-coverage` vartas literalų be `t()` nemato, o `lt-LT` nėra tekstas —
todėl vienintelis sargas yra komponentų testai abiem kalbomis. Sprendimas: `locale` ateina iš
`I18nContext` (viena tiesa kalbai ir formatui), ne iš naršyklės ir ne iš literalo. Likę tokens komponentai
(`AnalyticsDecisionPanel`, `TokenUsagePage`, `TokenUsageSummaryPanel`) — task 233 (8 kelių riba).

## Agentai
readme-guard -> architect -> coder -> reviewer -> i18n -> tester

## Failai
Leidžiama:
- `ui-app/src/i18n/I18nContext.tsx` (`locale` konteksto laukas + `useI18n().locale`)
- `ui-app/src/view/components/tokens/TopTasksTable.tsx` (29-45, 98, 185 eil.)
- `ui-app/src/view/components/tokens/UsageBreakdownChart.tsx` (13-19, 49 eil.)
- `ui-app/src/view/components/tokens/TokenAnalyticsSnapshotPanel.tsx` (7-13 eil.)
- `ui-app/src/view/styles/11-token-usage.css` (naujų klasių nenumatoma; deklaruota CSS varto reikalavimu)
- `ui-app/src/tests/view/components/tokens/TopTasksTable.test.tsx`
- `ui-app/src/tests/view/components/tokens/UsageBreakdownChart.test.tsx`
- `ui-app/src/tests/view/components/tokens/TokenAnalyticsSnapshotPanel.test.tsx`

Draudžiama:
- `ui-app/src/view/components/tokens/AnalyticsDecisionPanel.tsx`, `TokenUsageSummaryPanel.tsx`, `ui-app/src/view/pages/TokenUsagePage.tsx` (task 233)
- `ui-app/src/model/**` (formatavimas lieka view sluoksnyje)
- `ui-app/src/tests/gates/i18n-coverage.test.ts` (task 236)
- `dist/**`
- `node_modules/**`

## Veiksmas
- `I18nContext.tsx`: `locale: "lt-LT" | "en-US"` išvedamas iš aktyvios kalbos ir eksponuojamas per
  `useI18n()`; esamas `t` nekinta; `I18nContext.test.tsx` esami testai lieka žali (jei jį reikėtų keisti
  — jis už ribų, stop).
- Trys komponentai: formateriai gauna `locale` iš konteksto (helper'is komponento viduje arba
  `useMemo` su `Intl.NumberFormat(locale, …)`); literalas `"lt-LT"` dingsta; „No data", „iš",
  `UsageBreakdownChart:49` tekstas — per `t()` su LT+EN raktais.
- Testai: kiekvienam komponentui renderis LT ir EN režimu — skaičius `1234.5` LT rodomas su LT
  skirtukais, EN — su EN; nė vieno lietuviško literalo EN DOM'e ir atvirkščiai.
- Esamos asercijos, pin'inusios LT formatą numatytame (EN) režime, taisomos į teisingą režimą, ne
  silpninamos.

## Patikra
- `pnpm build`
- `pnpm test`
- `pnpm --dir ui-app build`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei `locale` pridėjimas lūžtų
`ui-app/src/tests/i18n/I18nContext.test.tsx` (už ribų) — tada laukas pridedamas kaip neprivalomas su
numatytąja reikšme, kad esami testai liktų nepaliesti.

## Neįtraukta
- `AnalyticsDecisionPanel.tsx:21-22` `Intl.NumberFormat(undefined)`, `TokenUsagePage.tsx:170`,
  `TokenUsageSummaryPanel.tsx:57` — task 233.
- Datų (`toLocaleString`) formatavimas WavesPanel ISO žymoms — P3, task 233 Neįtraukta.
- Vartas dinaminiams raktams — task 236.
