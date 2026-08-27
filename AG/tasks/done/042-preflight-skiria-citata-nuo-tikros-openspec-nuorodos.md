# Repair Task

## Tikslas
Pataisyk aiškią lokalią implementacijos klaidą.

## Agentas
debugger

## Klaida
clear local issue: [ELIFECYCLE] Test failed. See above for more details.

## Veiksmas
Remkis vq/logs/checks-last.log ir pataisyk tik šios užduoties allowed paths apimtyje.

## Patikra
- `pnpm typecheck`
- `pnpm test`
## Stop
Sustok, kai patikros praeina.

## Neįtraukta
- Model-based diagnosis.
- Rollback.

## Failai
Leidžiama:
- `src/application/task-planning/openspec-context.ts`
- `src/tests/task-planning.test.ts`

Draudžiama:
- `src/application/task-planning/openspec-slug.ts`
- `src/interfaces/cli/dispatch/claude-preflight/index.ts`
- `.env`
- `node_modules/**`
- `dist/**`

## Spec source
openspec/changes/verqestra-backlog-v1/
