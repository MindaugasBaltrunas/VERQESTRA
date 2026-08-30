# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Priklausomybės
- `095-auditas-be-radiniu-gali-uzsidaryti-kaip-done-audit-complete` (domain `logHasAuditCompleteMarker` ir trečia `resolveNoCommitDisposition` šaka privalo egzistuoti prieš šį darbą).

## Tikslas
Prijungti domain'e jau egzistuojantį audito markerį prie no-commit done kelio: `DiagnosisRulesPort` gauna markerio skaitymo metodą, o `verify-task` jį perduoda į `resolveNoCommitDisposition`. Kompozicijos adapterio prijungimas — atskiras, vėlesnis task'as.

## Agentai
readme-guard -> architect -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/application/task-execution/run-coordinator-ports.ts`
- `src/application/task-execution/verify-task.ts`
- `src/application/task-execution/run-coordinator-terminal.ts`
- `src/tests/helpers/fake-task-run-ports.ts`
- `src/tests/task-execution-run.test.ts`

Draudžiama:
- `src/domain/diagnosis/dispositions.ts`
- `src/domain/diagnosis/stream-log.ts`
- `src/composition/loop/coordinator-execution-adapters.ts`
- `src/interfaces`
- `ui-app`
- `dist`
- `node_modules`

## Veiksmas
- `src/application/task-execution/run-coordinator-ports.ts`: `DiagnosisRulesPort` (244-251 eil.) naujas NEPRIVALOMAS metodas audito markerio skaitymui — opcionalus ta pačia priežastimi kaip esamas `writeActivity?` laukas: kol adapteris neprijungtas, esami implementuotojai turi likti kompiliuojami; kartu spręsk, ar `AlreadyImplementedVia` (24 eil.) reikia naujos reikšmės, ar užtenka `"marker"`.
- `src/application/task-execution/verify-task.ts` (161-186 eil.): perskaityk markerį per port'ą saugiu kvietimu (nėra metodo → `false`), paduok į `noCommitInputs` ir parink `via` reikšmę `done-already-implemented` perėjimui; `run-coordinator-terminal.ts` (176-181 eil.) liesk TIK jei įvedei naują `via` reikšmę — kitaip neliesk ir pažymėk ataskaitoje.
- Testai: `fake-task-run-ports.ts` (216 eil.) fake taisyklės grąžina naują markerį; `task-execution-run.test.ts` atvejai — audito markeris + `no-writes` + švarus medis uždaro `done-already-implemented`, o `wrote`/`unknown` lieka human-review/rollback kaip dabar.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Stabdyk ir klausk, jei port'o metodo neįmanoma pridėti neprivalomo ir tektų tame pačiame task'e keisti `src/composition` adapterį, arba jei nauja `AlreadyImplementedVia` reikšmė verstų keisti daugiau nei `run-coordinator-terminal.ts` priežasties eilutę. Baigęs su žalia `pnpm test` — commit'ink ir sustok.

## Neįtraukta
- Kanoninės `logHasAuditCompleteMarker` implementacijos prijungimas `src/composition/loop/coordinator-execution-adapters.ts` — kitas task'as.
- Bet koks `src/domain/diagnosis` keitimas.
