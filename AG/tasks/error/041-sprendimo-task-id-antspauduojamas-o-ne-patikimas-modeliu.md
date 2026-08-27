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
- `pnpm typecheck`
- `pnpm test`
## Stop
Sustok, kai patikros praeina.

## Neįtraukta
- Model-based diagnosis.
- Rollback.

## Failai
Leidžiama:
- `src/interfaces/cli/dispatch/claude-preflight/index.ts`
- `src/tests/interfaces-cli-preflight.test.ts`

Draudžiama:
- `src/application/task-planning/openspec-slug.ts`
- `src/composition/loop/coordinator-adapters.ts`
- `.env`
- `node_modules/**`
- `dist/**`

## Spec source
openspec/changes/verqestra-backlog-v1/
docs/audits/038-subagento-kanalo-premisa-paneigta-2026-08-26.md (skyrius „R5")
