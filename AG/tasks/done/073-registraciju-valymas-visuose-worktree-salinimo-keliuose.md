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
- `pnpm build`
- `pnpm test`
## Stop
Sustok, kai patikros praeina.

## Neįtraukta
- Model-based diagnosis.
- Rollback.

## Failai
Leidžiama:
- `src/infrastructure/git/worktrees/worktree-removal.ts`
- `src/infrastructure/git/worktrees/worktree-reaper.ts`
- `src/infrastructure/git/preserved-work.ts`
- `src/tests/infrastructure-worktrees.test.ts`
- `src/tests/infrastructure-git-preserved-work.test.ts`

Draudžiama:
- `src/infrastructure/git/worktrees/worktree-registration-cleanup.ts`
  (valymo logika teisinga — tik prijungiama)
- `src/application/**`
- `dist/**`
- `node_modules/**`

## Spec source
openspec/changes/verqestra-backlog-v1
