# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Priklausomybės
- 229-i18n-aklosios-zonos-tokenu-komponentai-ir-lt-lt-formateriai
- 230-klientas-atsisako-resumeloop-ir-queuecounts

## Žingsnis 0 — ar jau įgyvendinta?
Jei `ui-app/src/model/types.ts` `UiWaveSlot` turi `phase` ir `last_event`, `CompressionTelemetry` —
`feature_pairs`, `CompressionPage.tsx` rodo „N/M mažesnis" visoms vėliavoms (ne tik `worker_task_ir`),
o `18-command-center-blocks.css` turi `.freshness-indicator.freshness-connecting` taisyklę —
ALREADY_IMPLEMENTED: cituok tipus, renderį ir CSS taisyklę.

## Tikslas
Pilnas auditas 2026-09-05 (`docs/audits/full-audit-2026-09-05.md`, UI P2/P3; `scratchpad/audit-ui.md`
F8, P3): laukai atkeliauja kas pollingą ir NIEKUR neskaitomi (15-o rato klasė). `/api/waves`
`slots[].phase`, `slots[].last_event` skaičiuojami `wave-slot-model.ts:168-244`, siunčiami
`ui-waves-view.ts:360-372`; kliento `UiWaveSlot` (`types.ts:799-812`) jų NETURI — `WavesPanel` fazę
skaičiuoja SAVO (`SlotProgressPhase`), du „phase" atsakymai tam pačiam slot'ui. `/api/compression`
`telemetry.feature_pairs` (`ui-compression-view.ts:121,313-324`) — `CompressionTelemetry`
(`types.ts:711-729`) neturi; `CompressionPage.tsx:213` „N/M mažesnis" rodo tik `worker_task_ir`, likusioms
4 vėliavoms verdiktas be skaičių. CSS varto akloji zona (template klasės, `dashboard-css-coverage.test.ts:28`):
`.freshness-connecting` (`FreshnessIndicator.tsx:68` `freshness-${state}`) taisyklės nėra → „Kraunama…"
gauna bazinį ŽALIĄ pulsuojantį tašką (`18-command-center-blocks.css:197-203`) — atrodo kaip „gyva";
`.workflow-card--{queue…done}` (`WorkflowBoard.tsx:203`) — 7 klasės be taisyklės (tik `--running`,
`09-workflow.css:146`). Serverio laukai NEŠALINAMI (mobile-gateway skaito `phase`) — klientas juos rodo.

## Agentai
readme-guard -> architect -> coder -> reviewer -> i18n -> tester

## Failai
Leidžiama:
- `ui-app/src/model/types.ts` (`UiWaveSlot` 799-812 eil.; `CompressionTelemetry` 711-729 eil.)
- `ui-app/src/view/components/dashboard/WavesPanel.tsx` (slot'o eilutė rodo serverio `phase`/`last_event`)
- `ui-app/src/view/pages/CompressionPage.tsx` (213-224 eil. — „N/M" iš `feature_pairs` kiekvienai vėliavai)
- `ui-app/src/i18n/I18nContext.tsx`
- `ui-app/src/view/styles/18-command-center-blocks.css` (`.freshness-indicator.freshness-connecting` šalia 191-194 eil.)
- `ui-app/src/view/styles/09-workflow.css` (`.workflow-card--<bucket>` taisyklės šalia 146 eil.)
- `ui-app/src/tests/view/components/dashboard/WavesPanel.test.tsx`
- `ui-app/src/tests/view/pages/CompressionPage.test.tsx`

Draudžiama:
- `src/interfaces/http/ui-waves-view.ts`, `src/interfaces/http/ui-compression-view.ts`, `src/interfaces/ui-model/**` (serverio kontraktas nekinta)
- `ui-app/src/view/components/shared/FreshnessIndicator.tsx`, `ui-app/src/view/components/dashboard/WorkflowBoard.tsx` (klasės teisingos — trūksta tik CSS)
- `ui-app/src/model/slotProgressViewModel.ts` (kliento fazė lieka — serverio fazė rodoma šalia, kaip faktas)
- `dist/**`
- `node_modules/**`

## Veiksmas
- `types.ts`: `UiWaveSlot.phase?: string`, `last_event?: { kind: string; ts: string } | null` (forma iš
  `wave-slot-model.ts:65` `WaveSlotEvent`), `CompressionTelemetry.feature_pairs?: Record<string, { compared: number; smaller: number }>`
  (forma iš `ui-compression-view.ts:313-324`) — visi neprivalomi (senas serveris).
- `WavesPanel.tsx`: slot'o eilutėje serverio `phase` ir `last_event.kind`+laikas (per `toLocaleString`
  su `useI18n().locale`, ne žalias ISO); `CompressionPage.tsx`: „mažesnis N/M" kiekvienai vėliavai iš
  `feature_pairs[rec.key]`, kai pora yra; `worker_task_ir` kelias lieka suderintas.
- CSS: `.freshness-indicator.freshness-connecting` — neutralus (ne žalias) taškas be pulsavimo;
  `.workflow-card--queue|active|delegated|human-review|done|…` — po vieną kairio rėmelio toną (sąrašą
  imti iš `WorkflowBoard.tsx` bucket'ų, ne spėti).
- Testai: WavesPanel fixture su `phase`/`last_event` rodo juos, be jų — nekinta; CompressionPage su
  `feature_pairs` rodo „2/5" prie `compact_dsl`; `dashboard-css-coverage` vartas žalias.

## Patikra
- `pnpm build`
- `pnpm test`
- `pnpm --dir ui-app build`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei `feature_pairs` serverio forma skiriasi nuo
`ui-compression-view.ts:313-324` (patikrink prieš rašydamas tipą) — kliento tipas turi būti serverio
kopija, ne interpretacija.

## Neįtraukta
- `controlPlane.human_review_tasks[].actions`, `learning_recommendations[].actions` — klientas turi savo
  `ACTION_LABEL`; serverio laukų šalinimas — kontrakto task'as su mobile-gateway patikra.
- `DashboardData.queueCounts` — task 230.
- `ReliabilityPage.tsx:70` `fixRate: 1`, `useDashboardController.ts:194-206` negyvi `eslint-disable`,
  `uploadTaskFiles` klaida dukart — P3, task 233 Neįtraukta.
