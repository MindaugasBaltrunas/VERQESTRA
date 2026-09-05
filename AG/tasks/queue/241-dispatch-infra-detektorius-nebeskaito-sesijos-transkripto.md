# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Priklausomybės
- 173-composition-p2-partija-sprendimo-nuosavybe-ir-statinis-git-importas

## Žingsnis 0 — ar jau įgyvendinta?
Jei `src/composition/loop/coordinator-adapters.ts` `coordinatorFailurePort.isDispatchInfrastructureFailure`
grąžina TIK `isInfrastructureExitCode(exitCode)` (be `claude-last.log` teksto skaitymo ir be
`spawn … ENOENT|ENOENT|command not found|is not recognized as` regex'o) — ALREADY_IMPLEMENTED:
cituok funkciją ir testą, tvirtinantį, kad ENOENT sesijos tekste verdikto nebekeičia.

## Tikslas
Pilnas auditas 2026-09-05 ir realus incidentas tą pačią parą: task
`166-atkurtas-finished-slot-nedispatchinamas-antra-karta-ir-integruojamas` atsidūrė human-review su
priežastimi `task-failed`, nors tas pats įvykis TUO PAČIU antspaudu buvo įvardytas kaip
infrastruktūra. Žurnalas, `vq/logs/orchestrator.log` 2026-09-05 08:21:22:

`process-issued` eilutės: `process-queued-task: dispatch infrastructure failure exit=1`,
`LOOP ABORT (infrastruktura): stage=dispatch exit=1 returned_to_queue=166-…md`, ir iškart po jų
`WORKER INTEGRATION PARKED: task=166-… reason=task-failed`.

Grandinė. Vykdytojas pasiekė turn'ų lubas (`DISPATCH TOOL USAGE: events=60` prieš
`max_turns=60`) ir išėjo kodu 1 — tikra task'o nesėkmė. `coordinatorFailurePort`
(`coordinator-adapters.ts:96-103`) tada perskaitė VISĄ dispatch sesijos žurnalą
`vq/logs/claude-last.log` (2,2 MB stream-json transkriptas su visais tool rezultatais) ir jame rado
`ENOENT` — bet ne iš spawn gedimo, o iš paties task'o testinio kodo, kurį vykdytojas skaitė ir
redagavo: `new Error("ENOENT: AG/tasks nerastas")` faile
`src/tests/scheduling-wave-restored-slots.test.ts` (6 atitikmenys transkripte, patikrinta Grep'u
kopijoje `.ag/worktrees/ac19a497-…/w2-166-…-a1/vq/logs/claude-last.log`). Regex'as sutapo,
verdiktas virto „infrastruktūra", `stopRun` grąžino task'ą į eilę ir metė
`WorkflowInfrastructureError` su TUO PAČIU kodu 1. Tėvas
(`composition/loop/command.ts:106` `classifyChildExitOutcome`) kodą 1 klasifikuoja
`task-failed` — teisingai, nes `LOOP_BLOCKED_EXIT_CODE = 1` yra sąmoningai NE infrastruktūros
kodas (`shared/exit-codes.ts:30-40`). Todėl `infrastructure_exit_code` liko `undefined` ir
`planWorkerIntegration` (`worker-integration.ts:290-320`) nuėjo į `task-failed` parką, nors ta pati
funkcija turi tam skirtą `infrastructure` išimtį.

Kryptis: teksto skenavimas ŠALINAMAS, o ne siaurinamas. Jo priežastis jau nebegalioja —
`claude-launcher.ts:197-205` trūkstamą vykdytoją nuo 2026-08-09 praneša deterministiniu
`EXECUTOR_UNAVAILABLE_EXIT_CODE = 69` ir to paties failo komentaras (200 eil.) tiesiai sako, kad
tai „exit kodas, kurį `isInfrastructureExitCode` klasifikuoja BE JOKIO TEKSTO". Regex'as liko kaip
paveldas ir dabar duoda tik klaidingus teigiamus: bet kuris task'as, kurio failuose ar tool
rezultatuose pasitaiko `ENOENT` (arba `command not found`), kiekvieną savo ne-nulinę baigtį
paverčia „infrastruktūra". Atmesta alternatyva — kelti naują infrastruktūros exit kodą, kad
verdiktas pereitų proceso ribą: verdiktas čia buvo NETEISINGAS, tad jo perdavimas tik sutvirtintų
klaidą.

## Agentai
readme-guard -> debugger -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/composition/loop/coordinator-adapters.ts` (`coordinatorFailurePort` 88-106 eil.; kartu pašalinti nebenaudojamą `readOptionalFile` importą, jei jis lieka be kitų kvietėjų šiame faile)
- `src/tests/composition-loop-failure-port.test.ts` (numatomas naujas; jei `coordinatorFailurePort` testas jau gyvena kitame faile — tas failas vietoje šio, įrašyti į ataskaitą)

Draudžiama:
- `src/shared/exit-codes.ts` (69 ir 1 semantika teisinga, nekeičiama)
- `src/composition/loop/command.ts` (`classifyChildExitOutcome` teisingas, nekinta)
- `src/application/scheduling/worker-integration.ts` (infrastruktūros išimtis teisinga, nekinta)
- `src/application/task-execution/dispatch-task.ts` (kvietėjas nekinta — portas grąžina teisingą atsakymą)
- `src/infrastructure/adapters/claude-launcher.ts` (69 emisija jau veikia, nekeičiama)
- `dist/**`
- `node_modules/**`

## Veiksmas
- `coordinator-adapters.ts` `isDispatchInfrastructureFailure`: palikti `exitCode === 0 → false` ir
  `isInfrastructureExitCode(exitCode)`; pašalinti `claude-last.log` skaitymą ir regex'ą. Antraštės
  komentaras perrašomas: kodėl teksto nebereikia (launcher'io 69) ir kokį gedimą teksto skaitymas
  realiai sukėlė (166, 2026-09-05).
- Testai: (a) `exitCode: 1` su žurnalu, kuriame yra `ENOENT` — `false` (tai regresijos testas
  incidentui); (b) `exitCode: 75/78/124/69` — `true`; (c) `exitCode: 0` — `false`; (d) žurnalo
  failo nebuvimas verdikto nebekeičia nė vienu atveju.
- Patikrinti Grep'u, ar `readOptionalFile` po pakeitimo dar turi kvietėjų `coordinator-adapters.ts`;
  jei ne — importas šalinamas, kitaip lint (`no-unused-vars`) nudažys vartus raudonai.
- Priėmimo kriterijus į ataskaitą: task'as, kurio `## Failai` liečia failą su `ENOENT` literalu,
  po nesėkmės gauna `reason=task-failed` VIENĄ kartą ir be `LOOP ABORT (infrastruktura)` eilutės.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei rasi realų gedimą, kurio launcher'is
NEPRANEŠA kodu 69 ir kurį gaudė tik teksto regex'as (pvz. spawn ENOENT ne `claude`, o gretimam
binarui) — tada sprendimas yra siaurinti skaitymą iki launcher'io savo rašomų pirmųjų žurnalo
eilučių, ne iki viso transkripto, ir tai keičia šio task'o apimtį.

## Neįtraukta
- `vq/config/token-budget.json` turn'ų lubų sulyginimas su šablonu (medium 90, repair 45) —
  operatoriaus žingsnis, atliktas 2026-09-05; task 159 jį sąmoningai paliko už kodo ribų.
- Task'o 166 grąžinimas į eilę — operatoriaus veiksmas per `verqestra requeue`.
- README exit kodų lentelės eilutė kodui 69 — task 222.
- `worker-integration.ts` parkavimo šakos — jos teisingos; klaida gimė detektoriuje.
