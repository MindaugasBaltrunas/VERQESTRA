# Task

## Spec source
openspec/changes/verqestra-backlog-v1

## Tikslas
„Aktyvus vykdymas" sekcija rodo ABU aktyvius slot'us: worker id, task id, modelis, worktree kelias (w2) ir bėgimo trukmė. Kai gyvas tik w1, vaizdas lieka toks pat kaip dabar.

## Agentai
PRIVALOMA grandinė: readme-guard -> coder -> reviewer -> i18n -> tester

## Failai
Leidžiama:
- `ui-app/src/controller/useAgentActivity.ts`
- `ui-app/src/controller/useAgentActivity.test.ts`
- `ui-app/src/view/pages/DashboardPage.tsx`
- `ui-app/src/i18n/I18nContext.tsx`
- `ui-app/src/view/styles/dashboard.css`

Draudžiama:
- `src/**`
- `ui-app/src/view/components/AgentChainProgress.tsx`
- `ui-app/src/view/components/OverviewPanel.tsx`
- `dist/**`
- `node_modules/**`

## Veiksmas
- `useAgentActivity`: grąžink visų gyvų slot'ų sąrašą iš `/api/events` kadro `slots[]` (`SlotAgentActivity`), o ne vien globalų aktyvumą; trūkstamus laukus laikyk neprivalomais.
- `DashboardPage` aktyvaus vykdymo sekcijoje render'ink kiekvieną slot'ą su worker id, task id, modeliu, worktree keliu ir trukme.
- Naujiems tekstams `t(...)` raktai en+lt, naujoms `className` — taisyklės `dashboard.css` abiem temoms.

## Patikra
- `pnpm --dir ui-app build`
- `pnpm test`

## Stop
STOP, jei reikėtų keisti `/api/events` krovinį serveryje (`src/**`). Kitaip commit'ink, kai abi patikros žalios.

## Neįtraukta
`AgentChainProgress` w2 juosta ir `OverviewPanel` signalai — atskiros užduotys. Serverio projekcijos (065). Istorinių bangų archyvas.
