# Task

## Spec source
openspec/changes/verqestra-backlog-v1 — eilutė „Uždaryti preflight retry memo ribą: aplinkos pataisymas neturi atrodyti kaip human review kilpa".
Tęsinys po dalies, kuri pridėjo `preflightMemoExpired` ir `PREFLIGHT_MEMO_MAX_AGE_MS` į `run-coordinator-guards.ts`.

## Tikslas
Pasenęs memo įrašas nebeturi likti diske ir nebeturi gimdyti `preflight_retry_without_change` human-review kilpos: skaitymo vietoje (lazy, be atskiro GC praėjimo) jis ištrinamas su log eilute, o task'as eina į normalų preflight'ą.

## Agentai
Privaloma grandinė: readme-guard -> architect -> coder -> reviewer -> tester.

## Failai
Leidžiama:
- `src/application/task-execution/run-coordinator.ts`
- `src/tests/task-execution-coordinator.test.ts`

Draudžiama:
- `src/application/task-execution/run-coordinator-guards.ts`
- `src/composition/loop/coordinator-optional-adapters.ts`
- `dist/**`
- `node_modules/**`
- `ui-app/**`

## Veiksmas
- `preflightRetryGuard`: radus `hit`, kurio `preflightMemoExpired` yra `true`, iškviesk `memo.clear(state.taskId)`, įrašyk `ports.log.write("PREFLIGHT MEMO EXPIRED: task=<id> age=<h>")` ir grąžink `false` (jokio journal human-review įrašo, jokio `repeat_count` didinimo).
- `recordPreflightFailureMemo`: pasenęs ankstesnis įrašas nebelaikomas tęsiniu — `repeat_count` prasideda nuo 1.
- `src/tests/task-execution-coordinator.test.ts`: įrodyk, kad 25 h senumo memo ištrinamas iš store, log turi `PREFLIGHT MEMO EXPIRED`, task'as nepatenka į human-review, o šviežias memo toliau parkuoja kaip anksčiau.

## Patikra
- `pnpm typecheck`
- `pnpm lint`
- `pnpm test:only`

## Stop
Commit'ink, kai visos trys patikros žalios. Sustok ir klausk, jei reikėtų keisti `PreflightFailureMemoPort` kontraktą ar composition adapterį.

## Neįtraukta
Amžiaus taisyklės keitimas (ankstesnė dalis). Retry limitai. Worktree kopijų valymas (079). Memo diagnostikos praturtinimas (080).
