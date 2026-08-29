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
- `src/composition/ui/router-adapters.ts`
- `src/tests/composition-worktree-policy-wiring.test.ts`

Draudžiama:
- `src/interfaces/http/ui-waves-view.ts`
- `src/interfaces/http/ui-worktree-policy.ts`
- `src/interfaces/http/ui-router-mutations.ts`
- `src/application/scheduling/**`
- `.gitignore`
- `dist/**`

## Spec source
openspec/changes/verqestra-backlog-v1
