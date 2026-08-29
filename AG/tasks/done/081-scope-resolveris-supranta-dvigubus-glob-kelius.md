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
- `src/application/scheduling/conflict-detector.ts`
- `src/application/scheduling/worker-pool-admission.ts`
- `src/tests/scheduling-conflict-detector.test.ts` (numatomas; jei testas
  gyvena kitur — tas failas vietoje šio, įrašyti į ataskaitą)

Draudžiama:
- `src/application/scheduling/worker-pool-plan.ts` (077 jį valo — nesikirsti)
- `src/domain/**`
- `dist/**`
- `node_modules/**`

## Spec source
openspec/changes/verqestra-backlog-v1
