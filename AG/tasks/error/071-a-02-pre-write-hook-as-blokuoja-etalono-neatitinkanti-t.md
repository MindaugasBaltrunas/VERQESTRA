# Repair Task

## Tikslas
Pataisyk aiškią lokalią implementacijos klaidą.

## Agentas
debugger

## Klaida
clear local issue: AssertionError [ERR_ASSERTION]: split these files by responsibility — a baseline does not exist by construction

## Veiksmas
Remkis vq/logs/checks-last.log ir pataisyk tik šios užduoties allowed paths apimtyje.

## Patikra
- `pnpm build`
- `pnpm test`
## Stop
Sustok, kai patikros praeina.

## Neįtraukta
- Model-based diagnosis.
- Rollback.

## Failai
Leidžiama:
- `src/interfaces/hooks/pre-hooks.ts`
- `src/tests/interfaces-hooks-pre-hooks.test.ts`

Draudžiama:
- `src/domain/tasks/etalonas-rules.ts`
- `src/interfaces/hooks/scope-guards.ts`
- `src/application/quality-gates/preflight-rules.ts`
- `dist/**`
- `node_modules/**`

## Spec source
openspec/changes/verqestra-backlog-v1
