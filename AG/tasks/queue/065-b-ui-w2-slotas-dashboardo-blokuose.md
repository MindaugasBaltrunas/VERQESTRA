# Task

HUMAN-REVIEW-APPROVED: mindebaltru 2026-08-28 operatoriaus pavedimu — w2 matomumas dashboard'e (rankinis skėlimas: čia UI dalis, serverio dalis — 065)

## Spec source
openspec/changes/verqestra-backlog-v1

## Priklausomybės
- 065-ui-w2-slotas-matomas-grandineje-vykdyme-ir-signaluose

## Žingsnis 0 — ar jau įgyvendinta?
Jei „Darbo eigos suvestinė", „Aktyvus vykdymas" ir „Pagrindiniai signalai"
rodo IR w2 slot'o būseną (task, worktree, trukmė, baigtis) —
ALREADY_IMPLEMENTED su konkrečiomis eilutėmis. Jei serverio view dar
neservuoja abiejų slot'ų (065 nebaigtas) — STOP: priklausomybė neįvykdyta.

## Tikslas
UI pusė w2 matomumui (serverio duomenis paruošė 065):

1. **Agentų grandinė** (`AgentChainProgress`): kai banga turi aktyvų w2
   slot'ą — antra lygiagreti juosta su w2 task'u ir faze; sequential
   režime vaizdas identiškas dabartiniam (jokio tuščio w2 bloko).
2. **Aktyvus vykdymas** (`useAgentActivity` + DashboardPage sekcija):
   rodomi ABU aktyvūs slot'ai — worker id, task id, modelis, worktree
   kelias (w2), bėgimo trukmė.
3. **Pagrindiniai signalai** (`OverviewPanel`): `w2: <task> (Xm)` kai
   gyvas; paskutinė w2 baigtis (`merged` / `parked: <priežastis>` /
   `child exit <kodas>`); bangos režimas (`sequential` / `parallel 2/2`).

Tekstai per `t(...)` (en+lt), naujos className su taisyklėmis
`dashboard.css`, abi temos, jokių amžinų animacijų.

## Agentai
readme-guard -> coder -> reviewer -> i18n -> tester

## Failai
Leidžiama:
- `ui-app/src/view/pages/DashboardPage.tsx`
- `ui-app/src/view/components/AgentChainProgress.tsx`
- `ui-app/src/view/components/AgentChainProgress.test.tsx`
- `ui-app/src/view/components/OverviewPanel.tsx`
- `ui-app/src/view/components/OverviewPanel.test.tsx` (numatomas, jei nėra)
- `ui-app/src/controller/useAgentActivity.ts`
- `ui-app/src/controller/useAgentActivity.test.ts` (numatomas, jei nėra)
- `ui-app/src/model/types.ts`
- `ui-app/src/model/api.ts`
- `ui-app/src/i18n/I18nContext.tsx`
- `ui-app/src/view/styles/dashboard.css`

Draudžiama:
- `src/**` (serverio dalis — 065)
- `dist/**`
- `node_modules/**`

## Patikra
- `pnpm build`
- `pnpm test`
- `pnpm --dir ui-app build`

## Stop
Commit'ink, kai patikros žalios.

## Neįtraukta
Serverio projekcijos (065). Scheduling elgsena. Istorinių bangų archyvas.
Mobile gateway.
