# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Žingsnis 0 — ar jau įgyvendinta?
Jei `src/application/task-execution/run-coordinator-terminal.ts` `applySplitSupersede` po tėvo
perkėlimo į `done` NEBEkviečia `ports.completion.cascadeBlockedDependents` (439 eil. nebėra) ir
`src/tests/task-execution-runtime-split.test.ts` tvirtina, kad dalys 2..N lieka `queue` —
ALREADY_IMPLEMENTED: cituok funkcijos pabaigą ir testą.

## Tikslas
Pilnas auditas 2026-09-05 (`docs/audits/full-audit-2026-09-05.md`, L3, patikrinta ✓):
runtime-oversize skėlimas parkuoja savo vaikus į human-review. `run-coordinator-terminal.ts:399-439`
`applySplitSupersede`: `enqueueChildTasks` įrašo dalis 2..N su `blocked_by: <parent>`
(`task-splitting.ts:200`), tėvas keliauja į `done` su `# Superseded` stub'u, o tada
`cascadeBlockedDependents(parent)` (439) → `coordinator-execution-adapters.ts:232`
`routeBlockedTasksToHumanReview` (`task-graph-import.ts:153-183`) perkelia VISUS queue task'us su
`blocked_by: parent` į human-review su priežastimi „upstream task entered human-review or failed
routing". Tėvas yra `done`, priklausomybė patenkinta — kaskada čia prieštarauja `done` šakai
(palygink 118/128/147: kaskaduojama tik po duplicate/human-review/retry-limit). Latentinis: žurnale
`TASK SPLIT (runtime-oversize)` = 0 (69 kiti skėlimai eina preflight keliu be kaskados). Fake portas
(`src/tests/helpers/fake-task-run-ports.ts:226`) `cascadeBlockedDependents` daro no-op, todėl
testai žali.

Kryptis (audito „Ką daryti pirmiausia" 6): po `done` kaskados nekviesti. Atmesta alternatyva —
riboti kaskadą adapteryje (`coordinator-execution-adapters.ts:232`): adapteris priklauso task'ui
163, o žinojimas „tėvas baigė done" gyvena application sluoksnyje, ne kompozicijoje.

## Agentai
readme-guard -> debugger -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/application/task-execution/run-coordinator-terminal.ts` (`applySplitSupersede` 388-441)
- `src/tests/helpers/fake-task-run-ports.ts` (226: opt-in reali kaskados imitacija)
- `src/tests/task-execution-runtime-split.test.ts`

Draudžiama:
- `src/composition/loop/coordinator-execution-adapters.ts` (163 scope)
- `src/application/task-execution/task-graph-import.ts` (`routeBlockedTasksToHumanReview` semantika nekinta)
- `src/application/task-execution/task-splitting.ts`
- `src/application/task-execution/enqueue-child-tasks.ts`
- `src/tests/task-execution-run.test.ts` (kitas fake'o vartotojas — numatytasis no-op jam lieka)
- `dist/**`
- `node_modules/**`

## Veiksmas
- `run-coordinator-terminal.ts` `applySplitSupersede`: pašalinti `cascadeBlockedDependents` kvietimą
  po `done` (439); komentare įvardyti, kad kaskada priklauso tik ne-sėkmės terminalams (118, 128,
  147, 193), o vaikai su `blocked_by: <parent>` atsiveria planuoklyje natūraliai, nes tėvas `done`.
- `fake-task-run-ports.ts`: `cascadeBlockedDependents` gauna OPT-IN realistinę realizaciją
  (`createFakeTaskRunEnv({ cascadeToHumanReview: true })` ar pan.: queue failai su
  `blocked_by: <taskId>` perkeliami į `human-review`); numatytasis elgesys lieka no-op, kad kiti
  fake'o vartotojai (`task-execution-run`, `verify-*`, `coordinator`) nepasikeistų.
- `task-execution-runtime-split.test.ts`: su įjungta kaskada runtime-oversize skėlimas į 3 dalis →
  tėvas `done` su `# Superseded`, dalys 2..N lieka `queue`, `human-review` tuščias; kontrolinis
  atvejis — human-review terminalas (`transition.kind === "human-review"`) tebekaskaduoja.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei paaiškėja, kad planuoklis `done` tėvo vaikų
be kaskados NEatveria (t. y. `blocked_by` rezoliucija reikalauja įvykio, o ne bucket'o) — tada
sprendimas yra planuoklio pusėje, ne čia.

## Neįtraukta
- `routeBlockedTasksToHumanReview` priežasties tekstas ir E4/E5 kaskados semantika ne-sėkmės
  atvejais — nekinta.
- Preflight kelio skėlimas (`first_task` pratęsimas) — kitas mechanizmas, nepaliestas.
- Adapterio (`coordinator-execution-adapters.ts:232`) apsauga „nekaskaduoti done tėvo" — jei
  norima gynybos gylio, atskiras task'as po 163.
