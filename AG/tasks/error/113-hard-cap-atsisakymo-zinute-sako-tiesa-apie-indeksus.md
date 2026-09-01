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
- `pnpm build`
- `pnpm test`
## Stop
Sustok, kai patikros praeina.

## Neįtraukta
- Model-based diagnosis.
- Rollback.

## Failai
Leidžiama:
- `src/application/scheduling/worker-pool-plan.ts`
- `src/tests/scheduling-pool.test.ts`

Draudžiama:
- `src/application/scheduling/wave-provisioning.ts` (pakaitalo logika —
  task 114)
- `src/application/scheduling/worker-pool-admission.ts` (admission žinutės —
  task 116 kontekstas)
- `dist/**`
- `node_modules/**`

## Spec source
openspec/changes/verqestra-backlog-v1/
