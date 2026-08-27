## Žingsnis 0 — ar jau įgyvendinta?
Prieš keisdamas kodą patikrink, ar ## Tikslas ir ## Patikra jau tenkinami esamame kode.
Jei taip — NEDARYK jokių pakeitimų ir galutinę ataskaitą pradėk atskira eilute:
ALREADY_IMPLEMENTED: <failai/eilutės, įrodančios kad darbas jau padarytas>

## Sandbox taisyklės (privaloma — taupo turns)
- Po BET KOKIO `src` pakeitimo `dist` pasensta ir hook'ai blokuoja bash komandas. Pirma perbuild'ink TIKSLIA forma be pipe/redirect: `pnpm build`
- Patikroms naudok tik: `pnpm build` ir `pnpm test` (be `--`, be pipe į kitas komandas).
- `echo`, `sed`, `node -e` ir kompound komandos su neleistinais segmentais VISADA atmetamos — nekartok jų kitomis formomis; failams skaityti naudok Read/Grep tools.
- Rašymo darbą atlik PATS šioje sesijoje (Write/Edit) ir neatidėk jo vėlesniam laikui: headless sesija po paskutinio tavo žingsnio baigiasi, o bėgimas be nė vieno Write/Edit parkuojamas human-review. `## Agentai` grandinė yra orkestratoriaus maršruto metaduomuo — jei subagentas negrąžina rezultato šiame bėgime, įgyvendink pakeitimą tiesiogiai.

# Task

## Spec source
openspec/changes/verqestra-backlog-v1/
Etalonas: `D:\React\AG_loop\AG\orchestrator\src\orchestrator\tasks\task-events.ts` (62-67 eil.)

## Tikslas
Prijungti našlaičius learning modulius prie task perėjimų piltuvo. `emitLearningEventsForTaskTransition` (`src/application/learning/learning-emitter.ts:47`) ir `updateTokenAnalyticsSnapshot` (`src/application/learning/token-analytics-snapshot.ts:149`) produkcijoje NEKVIEČIAMI — tik testų, todėl `vq/state/learning/events.jsonl` niekada neprisipildo ir `#/learning` amžinai tuščias. Skaitymo pusė gyva; trūksta TIK maitinimo.

## Agentai
Privaloma grandinė (nekeisk tvarkos): `readme-guard -> architect -> coder -> reviewer -> tester`.

## Failai
Leidžiama:
- `src/composition/loop/coordinator-adapters.ts`
- `src/tests/composition-learning-wiring.test.ts`

Draudžiama:
- `src/application/learning/learning-emitter.ts`
- `src/application/learning/token-analytics-snapshot.ts`
- `src/application/task-execution/run-coordinator.ts`
- `src/application/task-execution/run-coordinator-ports.ts`
- `src/tests/task-execution-run.test.ts`
- `.env`
- `node_modules/`
- `dist/`

## Veiksmas
- `coordinatorJournalPort.recordEvent` (`src/composition/loop/coordinator-adapters.ts:196-200`) po `appendTextFile` best-effort kviečia `emitLearningEventsForTaskTransition(nodeFsAdapter, input.runtimeRoot, event)`; kai `ANALYTICS_SNAPSHOT_STATES.has(event.to_state)` — papildomai `updateTokenAnalyticsSnapshot(nodeFsAdapter, input.runtimeRoot)`, apgaubtą try/catch (emiteris savo try/catch jau turi). Joks learning kelias negali nutraukti `recordEvent` ar keisti jo kontrakto.
- Terminalines būsenas imk TIK iš `ANALYTICS_SNAPSHOT_STATES` (`src/application/task-execution/task-events-model.ts`) — vienas šaltinis, jokių kopijų (žr. emiterio 18-22 eil. komentarą).
- Naujame `src/tests/composition-learning-wiring.test.ts` testuok per REALŲ `coordinatorJournalPort` su fake fs portu (ne tiesioginį emiterio kvietimą — būtent surišimo trūkumo unit testai nepagavo): (1) terminalinis įvykis palieka `task_outcome` įrašą `vq/state/learning/events.jsonl` ir atnaujina snapshot'ą; (2) `queue`/`active` perėjimas nerašo nieko; (3) learning fs klaida praryjama — jsonl eilutė vis tiek įrašyta.

## Patikra
- `pnpm typecheck`
- `pnpm test`

## Stop
Commit'ink tik kai abi patikros žalios. Sustok ir klausk, jei paaiškėtų, kad reikia keisti `application/learning` vidų arba `TaskJournalPort` kontraktą — tikslas prijungti esamus modulius, ne perprojektuoti.

## Neįtraukta
- `migration-coverage.json` anotacija — atskira nuosekli užduotis po šios.
- Rankinės `verqestra learning` CLI ir UI approve/reject keliai — veikia.
- `dead-export-gate` griežtinimas ir istorinių perėjimų backfill iš `vq/logs/task-events.jsonl`.
