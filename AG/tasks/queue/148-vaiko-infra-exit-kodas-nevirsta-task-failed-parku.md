# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Žingsnis 0 — ar jau įgyvendinta?
Jei ABI sąlygos tenkinamos —
(1) `src/composition/cli/main.ts` `catch` bloke (šiandien 58-61 eil.) arba
`src/shared/exit-codes.ts` `infrastructureExitCodeForError` funkcijoje
(šiandien 91-93 eil.) yra `WorkflowInfrastructureError` atpažinimas, kuris
grąžina jos `exitCode` lauką (grep `WorkflowInfrastructureError` ir
`exitCode` tuose failuose);
(2) `src/composition/loop/command.ts` `runChild` (šiandien 259-301 eil.)
klasifikuoja `result.code` per `isInfrastructureExitCode` ir infra kodui
NEgrąžina `false` (grep `isInfrastructureExitCode` faile) —
ALREADY_IMPLEMENTED: cituok abu fragmentus (failas:eilutės) kaip įrodymą.
Jei tenkinama tik viena — įgyvendinti likusią; ankstesnio bandymo nebuvo.

## Tikslas
Įrodymas (`vq/logs/orchestrator.log`, 2026-09-01 21:17:02 ir 21:18:25 UTC):
worktree slot'o vaikas (task 147, po jo 106) atsitrenkė į Claude usage
limitą — `DISPATCH USAGE LIMIT: ... reason=usage-limit-result — marking
infra (75)` ir SAVO kopijoje įvykdė `LOOP ABORT (infrastruktura):
stage=dispatch exit=75 ... returned_to_queue=...`. Tėvas pamatė
`WAVE SLOT CHILD EXIT 1` (`child exit context: code=1`), `worker-integration`
parkavo: `WORKER INTEGRATION PARKED: task=147 reason=task-failed`
(queue→human-review pagrindiniame medyje), o ciklas įrašė
`WAVE SLOT ENDED NONZERO ...; CONTINUING QUEUE` ir po minutės į tą pačią
sieną paleido 106 — irgi parkuotas `task-failed`. Aplinkos gedimas virto
dviem žmogaus peržiūromis ir tuščiu dispatch'u.

Dvi šaknys (patikrintos kode 2026-09-02):
1. VAIKAS meta `WorkflowInfrastructureError` su `exitCode: 75`
   (`src/application/task-execution/run-coordinator-terminal.ts:310`
   `stopRun`), bet `src/composition/cli/main.ts:60` `catch` grąžina
   `infrastructureExitCodeForError(error) ?? UNEXPECTED_ERROR_EXIT_CODE`, o
   `infrastructureExitCodeForError` (`src/shared/exit-codes.ts:91`)
   atpažįsta TIK Node errno (`isInfrastructureErrno`). Klasė ignoruojama →
   `process-queued-task` išeina su 1, nors žinojo 75. Tas pats galioja ir
   in-process `verqestra loop` keliui: `dispatchWaveSlots` metimą permeta,
   `runLoopCommand` jo negaudo, `runCli` paverčia 1.
2. TĖVAS `src/composition/loop/command.ts:300` `runChild` grąžina tik
   `result.code === 0`; `SlotTaskRunnerPorts.runChild`
   (`src/application/scheduling/slot-task-runner.ts:59`) yra
   `Promise<boolean>`; `recordOutcome(taskId, false)` →
   `FinishedWorkerSlot.succeeded=false`
   (`src/application/scheduling/wave-outcome.ts:87-97`) →
   `planWorkerIntegration` KIEKVIENĄ `!succeeded` worktree slot'ą parkuoja
   `task-failed` (`src/application/scheduling/worker-integration.ts:245-253`
   ir `292-299`). `isInfrastructureExitCode` šiame kelyje neegzistuoja.

Sprendimo kryptis (architektas tikslina KAIP, invariantai nekinta):
- Vaikas: `WorkflowInfrastructureError.exitCode` tampa proceso exit kodu;
  errno kelias ir `UNEXPECTED_ERROR_EXIT_CODE` lieka fallback'ais.
- Tėvas: vaiko exit kodą klasifikuoja `isInfrastructureExitCode`. Infra
  baigtis NĖRA terminalinė task'o baigtis — ji apdorojama TAIP PAT, kaip
  in-process kelyje: `runChild` meta `WorkflowInfrastructureError` su vaiko
  `exitCode` (po esamos `formatChildExitDiagnostics` diagnostikos), lease
  atlaisvinamas `slot-task-runner.ts` `finally` bloke kaip iki šiol,
  `dispatchWaveSlots` (jau dokumentuota `wave-dispatch.ts:129-131`:
  „metimas nutraukia run'ą palaukus kitų slot'ų; metančiam slot'ui baigtis
  nefiksuojama") permeta, ciklas sustoja su infra kodu. `recordOutcome`
  infra slot'ui NEkviečiamas → `planWorkerIntegration` jo nemato → parko
  nėra, task failas lieka `AG/tasks/queue` pagrindiniame medyje.
  Atmesta alternatyva: tri-state `succeeded` per `wave-outcome.ts` /
  `worker-integration.ts` / `wave-scheduler-contract.ts` — liečia penkis
  papildomus modulius ir snapshot'o `restoreFinishedSlots` semantiką
  (`wave-scheduler-state.ts:205-221`) dėl atvejo, kuriam sistema jau turi
  kelią (metimas). Jei architektas įrodo, kad metimo kelias invarianto
  neišlaiko — žr. Stop.

Invariantas: infra klasės exit kodas NIEKADA nevirsta `task-failed` parku
ir NIEKADA nesukelia `CONTINUING QUEUE` refill'o į tą pačią sieną.

## Agentai
readme-guard -> architect -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/shared/exit-codes.ts` (`infrastructureExitCodeForError` gali
  atpažinti `WorkflowInfrastructureError.exitCode`; kodų LENTELĖS reikšmės
  nekinta — cross-process kontraktas)
- `src/tests/shared-errors.test.ts` (egzistuoja — `infrastructureExitCodeForError`
  atvejai 80-81 eil.)
- `src/composition/cli/main.ts` (`catch` blokas)
- `src/tests/composition-cli.test.ts` (egzistuoja — `runCli` išimčių testas
  94-129 eil.)
- `src/tests/fixtures/characterization/cli-exit-contracts.json` (tik jei
  pridedamas atvejis; esamų atvejų kodai nekinta)
- `src/composition/loop/command.ts` (`runChild` klasifikacija ir metimas)
- `src/composition/loop/child-exit-diagnostics.ts` (jei klasifikatorius
  iškeliamas į gryną funkciją, testuojamą be proceso)
- `src/tests/composition-loop-child-exit.test.ts` (egzistuoja — grynų
  `command.ts` pagalbininkų testai)
- `src/tests/composition-loop-command.test.ts` (egzistuoja —
  `buildLoopCyclePorts` surišimo testai)
- `src/application/scheduling/slot-task-runner.ts` (`runChild` porto
  kontrakto dokumentacija: infra baigtis = metimas, ne `false`; `finally`
  lease atlaisvinimas privalo galioti ir metimo kelyje)
- `src/tests/scheduling-slot-task-runner.test.ts` (egzistuoja)
- `src/application/scheduling/wave-dispatch.ts` (tik jei reikia: po pirmo
  lane'o metimo kiti lane'ai NEBEprašo `refill` — dabar `active === 0`
  vartas to negarantuoja, kai dar dirba trečias lane'as)
- `src/tests/scheduling-wave-dispatch.test.ts` (egzistuoja)
- `src/application/scheduling/loop-cycle.ts` (tik jei reikia: metimo
  propagacija su aiškia `LOOP ABORT` eilute tėvo žurnale)
- `src/tests/scheduling-loop-cycle.test.ts` (egzistuoja)

Draudžiama:
- `src/application/scheduling/worker-integration.ts` ir
  `src/tests/scheduling-pool.test.ts` (park semantika nekinta — infra slot'as
  čia neturi patekti apskritai)
- `src/application/scheduling/wave-outcome.ts`,
  `src/application/scheduling/wave-scheduler.ts`,
  `src/application/scheduling/wave-scheduler-contract.ts`,
  `src/application/scheduling/wave-scheduler-state.ts` (tri-state kelias —
  atmesta alternatyva, žr. Stop)
- `src/application/task-execution/run-coordinator-terminal.ts` (vaiko
  `stopRun` jau teisingas — jis meta su `exitCode`)
- `src/infrastructure/adapters/claude-dispatch-outcome.ts` (usage-limit
  klasifikacija į 75 jau teisinga)
- `src/interfaces/cli/task-queue/process-queued-task.ts` (klaida
  propaguojama iki `runCli` — gaudyti čia reikštų antrą exit kodo
  priskyrimo vietą, o `main.ts` komentaras ją draudžia)
- `dist/**`
- `node_modules/**`

## Veiksmas
- `exit-codes.ts`/`main.ts`: `WorkflowInfrastructureError` su `exitCode`
  → tas kodas; be `exitCode` — esamas kelias. Architektas sprendžia, ar
  atpažinimas gyvena `infrastructureExitCodeForError` (shared→shared
  importas `errors.js` leidžiamas, ciklo nėra — `errors.ts` `exit-codes`
  neimportuoja) ar `main.ts` `catch` bloke. Testas
  (`composition-cli.test.ts`): komanda meta
  `new WorkflowInfrastructureError("x", { exitCode: 75 })` → `runCli`
  grąžina 75; be `exitCode` → 1; errno atvejis nekinta.
- `command.ts` `runChild`: po diagnostikos (`formatChildExitDiagnostics` +
  `appendChildExitSlotLog` lieka VISIEMS ne-nuliniams kodams), jei
  `isInfrastructureExitCode(result.code)` → mesti
  `WorkflowInfrastructureError` su `exitCode: result.code` ir žinute, iš
  kurios matyti `slot`, `task`, `code`; kitaip — `result.code === 0` kaip
  dabar. Klasifikatorių (`code → "ok" | "task-failed" | "infrastructure"`)
  iškelti į gryną funkciją (`child-exit-diagnostics.ts` arba šalia), kad
  testas nereikalautų realaus proceso.
- `slot-task-runner.ts`: `runChild` porto komentaras ir `finally` — testas
  (`scheduling-slot-task-runner.test.ts`): `runChild` meta → lease
  `release` vis tiek kviečiamas, metimas propaguojamas (ne paverčiamas
  `WAVE SLOT FAILED ... false`).
- `wave-dispatch.ts`/`loop-cycle.ts` (tik jei architektas patvirtina
  spragą): po lane'o metimo joks kitas lane'as nebegauna `refill`; tėvo
  žurnale atsiranda viena `LOOP ABORT (infrastruktura): ... slot=... exit=...`
  eilutė (formatas suderintas su `run-coordinator-terminal.ts:289/308`,
  kad esami grep'ai ją rastų). Testai: `scheduling-wave-dispatch.test.ts`
  — metantis lane'as: `recordOutcome` jam NEkviečiamas, `refill` po metimo
  nebekviečiamas, klaida permetama po kitų lane'ų;
  `scheduling-loop-cycle.test.ts` — `runSlotTask` meta
  `WorkflowInfrastructureError` → `runLoopCycle` permeta, žurnale NĖRA
  `CONTINUING QUEUE`.
- Architektas PRIEŠ kodavimą patikrina ir ataskaitoje įrašo: (a) ką
  `recoverFromCrash` / `selectNextResumableTask` daro su `beginTask`
  paliktu checkpoint'u/ledger įrašu, kai `recordOutcome` nebuvo — in-process
  metimo kelias šiandien palieka tą pačią būseną, tad paritetas yra
  bazinis lūkestis, bet jis turi būti pamatytas kode, ne prielaidoje;
  (b) kad atlaisvinto lease worktree kopiją kitas startas nuskina per
  `reapOrphanWorktrees` (loop-cycle.ts:88-90), t. y. „švari nesėkmė" be
  rankinio valymo.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei architektas įrodo, kad
metimo kelias invarianto neišlaiko (pvz. `recoverFromCrash` po metimo
task'ą vis tiek paverčia žlugusiu arba dvigubai dispatch'ina) — tada
tri-state baigtis per `wave-outcome.ts`/`worker-integration.ts` yra
ATSKIRAS task'as su savo `## Failai`, o šis apsiriboja 1-a šaknimi
(`main.ts`/`exit-codes.ts`) ir verdikto dokumentavimu.

## Neįtraukta
- Usage-limit „wait-and-resume" automatika tėvo procese (laukti sienos ir
  tęsti be operatoriaus) — ciklas sustoja su 75 kaip in-process kelyje;
  laukimo/tęsimo politika yra atskiras sprendimas su `loop-lifecycle`
  supervizoriaus scope.
- Task'ų 147 ir 106 grąžinimas iš `human-review` į `queue` — bucket'ų
  kilnojimas yra operatoriaus veiksmas.
- Tri-state `FinishedWorkerSlot` baigtis ir `restoreFinishedSlots`
  semantika (`wave-scheduler-state.ts`) — atmesta alternatyva, žr. Stop.
- Failų sankirta su 146 (`AG/tasks/human-review`, ne queue — priklausomybė
  pagal etaloną nedeklaruojama): 146 ir jo būsimas vaikas
  `146-a-02-surisa-ensuretaskfileinworktree-porta-composition` liečia
  `slot-task-runner.ts`, `command.ts`, `scheduling-slot-task-runner.test.ts`,
  `composition-loop-child-exit.test.ts`. Kai 146-a-02 atsiras queue,
  operatorius/planuoklė turi serializuoti porą arba pridėti
  `## Priklausomybės` eilutę čia — tai ne šio task'o autoriaus sprendimas.
