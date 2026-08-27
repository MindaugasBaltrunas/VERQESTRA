# Repair Task

## Tikslas
Pataisyk aiškią lokalią implementacijos klaidą.

## Agentas
debugger

## Klaida
clear local issue: $ pnpm run lint && pnpm run build && node --test "dist/tests/**/*.test.js" && pnpm run typecheck:ui && pnpm run test:ui

## Veiksmas
Remkis vq/logs/checks-last.log ir pataisyk tik šios užduoties allowed paths apimtyje.

## Patikra
- `pnpm typecheck:ui`
- `pnpm test:ui`
## Stop
Sustok, kai patikros praeina.

## Neįtraukta
- Model-based diagnosis.
- Rollback.

## Failai
Leidžiama:
- `ui-app/src/controller/useDashboardController.ts`
- `ui-app/src/view/components/Header.tsx`
- `ui-app/src/view/components/LoopControls.tsx`
- `ui-app/src/i18n/I18nContext.tsx`
- `ui-app/src/tests/**`

Draudžiama:
- `src/**`
- `ui-app/src/api.ts`
- `dist/**`
- `node_modules/**`

## Spec source
openspec/changes/verqestra-backlog-v1
