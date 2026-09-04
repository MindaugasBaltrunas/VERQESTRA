# Repair Task

## Tikslas
Pataisyk aiškią lokalią implementacijos klaidą.

## Agentas
debugger

## Klaida
clear local issue: AssertionError [ERR_ASSERTION]: gyvi task'ai pažeidžia etaloną:

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
- `src/interfaces/cli/task-queue/accept-scope.ts`
- `src/tests/interfaces-cli-task-queue.test.ts`

Draudžiama:
- `src/interfaces/cli/task-queue/requeue.ts`
- `src/interfaces/cli/task-queue/task-move.ts`
- `src/application/task-execution/bucket-transition.ts`
- `src/domain/tasks/failai-scope-edit.ts`
- `src/composition/cli/commands-tasks.ts`
- `dist/**`
- `node_modules/**`

## Spec source
openspec/changes/verqestra-backlog-v1/
