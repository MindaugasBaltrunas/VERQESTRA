# Task

## Spec source
openspec/changes/verqestra-backlog-v1
Etalonas: D:\React\AG_loop\AG\orchestrator\src\orchestrator\tasks\task-events.ts (62-67 eil.)

## Tikslas
Task perėjimų piltuvas turi automatiškai maitinti learning atmintį ir token-analytics
snapshot'ą, kaip etalone. Dabar `#/learning` („Mokymasis" / „Nuolatinis tobulinimas")
amžinai tuščias, nes `vq/state/learning/events.jsonl` niekas nerašo: emiteris ir
snapshot'o atnaujintojas migruoti su testais, bet be prijungimo taško — abu našlaičiai.

## Agentai
readme-guard -> architect -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/composition/loop/coordinator-adapters.ts`
- `src/tests/composition-learning-wiring.test.ts` (naujas)

Draudžiama:
- `src/application/learning/**` (emiteris ir snapshot'as TEISINGI — trūksta tik kvietėjo)
- `src/application/task-execution/run-coordinator.ts` (041 laukas)
- `src/tests/task-execution-run.test.ts` (041 laukas)
- `.env`
- `node_modules/**`
- `dist/**`

## Dependencies
depends_on: none

## Veiksmas
- FAKTAI (auditas 2026-08-27): `emitLearningEventsForTaskTransition`
  (`src/application/learning/learning-emitter.ts:47`) ir `updateTokenAnalyticsSnapshot`
  (`src/application/learning/token-analytics-snapshot.ts:149`) produkcijoje NEKVIEČIAMI —
  tik testų. Produkcija snapshot'ą tik skaito (`node-adapters.ts:210`), o learning žurnalą
  rašo tik rankinė `verqestra learning record` ir UI approve/reject. Skaitymo pusė
  (control-plane -> UI) gyva ir teisinga — trūksta TIK maitinimo.
- ŠAKNIS: migruojant VQ-504, iš etalono `recordTaskEvent` perkelta tik jsonl eilutė.
  Etalone po append'o eina dar du kvietimai: learning emisija kiekvienam įvykiui ir,
  terminaliniam perėjimui (`ANALYTICS_SNAPSHOT_STATES`), snapshot'o atnaujinimas.
- SPRENDIMAS: `coordinatorJournalPort.recordEvent`
  (`src/composition/loop/coordinator-adapters.ts:192-200`) po `appendTextFile` best-effort
  kviečia `emitLearningEventsForTaskTransition(nodeFsAdapter, input.runtimeRoot, event)`;
  kai `ANALYTICS_SNAPSHOT_STATES.has(event.to_state)` — ir
  `updateTokenAnalyticsSnapshot(nodeFsAdapter, input.runtimeRoot)`. Snapshot'o kvietimą
  apgaubti try/catch (emiteris savo try/catch jau turi): joks learning kelias niekada
  negali nutraukti task apdorojimo ar sugriauti `recordEvent` kontrakto.
- Terminalines būsenas imti iš `ANALYTICS_SNAPSHOT_STATES`
  (`src/application/task-execution/task-events-model.ts`) — VIENO šaltinio, ne kopijos
  (žr. emiterio 18-22 eil. komentarą apie 2026-08-24 radinį).
- Vieno taško pakanka: `run-coordinator-terminal`, `run-coordinator-cheap-finish`,
  `skip-dispatch` ir `final-audit-repair` visi eina per tą patį `journal.recordEvent`.
- Į `migration-coverage.json` learning/task-events pastabą įrašyti, kad piltuvo šalutiniai
  kvietimai prijungti (buvo migracijos spraga, ne nukrypimas — elgesys atkurtas 1:1).
- Testai (naujame `composition-learning-wiring.test.ts`, per REALŲ `coordinatorJournalPort`
  su fake fs portu, ne per tiesioginį emiterio kvietimą — būtent surišimo trūkumo unit
  testai nepagavo): (1) terminalinis įvykis palieka `task_outcome` įrašą
  `vq/state/learning/events.jsonl` ir atnaujina snapshot'ą; (2) ne-terminalinis
  (`queue`/`active`) nerašo nieko; (3) learning fs klaida nenutraukia `recordEvent` —
  jsonl eilutė vis tiek įrašyta, klaida praryta.

## Patikra
- `pnpm typecheck`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Sustok, jei pasirodytų, kad reikia keisti
`application/learning` vidų arba `TaskJournalPort` kontraktą
(`run-coordinator-ports.ts`) — tikslas yra prijungti esamus modulius kompozicijoje,
ne perprojektuoti juos.

## Neįtraukta
- Rankinės `verqestra learning` CLI ir UI approve/reject keliai — jie veikia.
- `dead-export-gate` griežtinimas (testų kvietėjas dabar tenkina vartus, todėl našlaitis
  su testais praeina tyliai) — atskiro task'o kandidatas, jei pasikartos.
- Istorinių perėjimų backfill iš `vq/logs/task-events.jsonl` — atmintis pildosi nuo
  prijungimo momento, kaip ir etalone.
