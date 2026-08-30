# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Priklausomybės
- `095-auditas-be-radiniu-gali-uzsidaryti-kaip-done-audit-complete` (domain markeris).
- „AUDIT_COMPLETE markeris per DiagnosisRulesPort ir verify-task“ (port'o metodas privalo egzistuoti).

## Tikslas
Prijungti kanoninę domain implementaciją prie `DiagnosisRulesPort` kompozicijos adapteryje, kad audito markerio kelias veiktų gyvame loop'e, o ne tik testų fake'e.

## Agentai
readme-guard -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/composition/loop/coordinator-execution-adapters.ts`
- `src/tests/composition-cli.test.ts`

Draudžiama:
- `src/application/task-execution/run-coordinator-ports.ts`
- `src/application/task-execution/verify-task.ts`
- `src/domain/diagnosis/stream-log.ts`
- `src/tests/task-execution-run.test.ts`
- `ui-app`
- `dist`
- `node_modules`

## Veiksmas
- `src/composition/loop/coordinator-execution-adapters.ts` (~200 eil.): greta `hasAlreadyImplementedMarker: (claudeLog) => logHasAlreadyImplementedMarker(claudeLog)` prijunk audito markerio metodą prie kanoninės `domain/diagnosis/stream-log.js` funkcijos (importas 33 eil.).
- `src/tests/composition-cli.test.ts`: patikra, kad realus `taskRunPorts` diagnozės taisyklių port'as atpažįsta `AUDIT_COMPLETE: <santrauka>` tiek žaliame, tiek stream-json log'e — fake'as čia netinka, tikrinamas būtent surišimas.
- Ataskaitoje nurodyk, ar po prijungimo port'o metodas gali tapti privalomu (jei taip — atskiras task'as, čia `run-coordinator-ports.ts` neliesti).

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Stabdyk ir klausk, jei prijungimas reikalautų keisti port'o kontraktą (`run-coordinator-ports.ts`) ar domain funkciją, arba jei `composition-cli.test.ts` patikra reikalautų realaus IO. Baigęs su žalia `pnpm test` — commit'ink ir sustok.

## Neįtraukta
- Port'o metodo pavertimas privalomu.
- `verify-task` ir domain logikos keitimai.
