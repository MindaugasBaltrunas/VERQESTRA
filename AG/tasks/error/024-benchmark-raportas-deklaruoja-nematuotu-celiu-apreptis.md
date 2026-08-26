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
- `pnpm --dir AG/benchmark test`
- `pnpm build`
## Stop
Sustok, kai patikros praeina.

## Neįtraukta
- Model-based diagnosis.
- Rollback.

## Failai
Leidžiama:
- `AG/benchmark/src/application/report/benchmark-report-model.ts`
- `AG/benchmark/src/application/report/benchmark-report.ts`
- `AG/benchmark/src/application/report/benchmark-report-json.ts`
- `AG/benchmark/src/application/report/benchmark-report-markdown.ts`
- `AG/benchmark/src/tests/benchmark-report.test.ts`

Draudžiama:
- `.env`
- `.env.*`
- `node_modules/**`
- `dist/**`
- `src/**`
- `ui-app/**`

## Spec source
openspec/changes/verqestra-backlog-v1
