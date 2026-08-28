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

## Tikslas
Prakišti `PreservedWorkReviewPorts` per `createRunCoordinator` opcijas iki `verifyTask` kvietimo, kad composition sluoksnis galėtų priduoti realų adapterį. Šiuo metu `run-coordinator.ts:153` kviečia `verifyTask(state, ports, { diagnoseCmd })` ir portas niekada nepasiekia `verify-task.ts`.

## Agentai
Privaloma grandinė: readme-guard -> architect -> coder -> reviewer -> tester. Jei subagentas negrąžina rezultato šiame bėgime, pakeitimą įgyvendink PATS Write/Edit įrankiais — bėgimas be nė vieno Write/Edit atmetamas.

## Failai
Leidžiama:
- `src/application/task-execution/run-coordinator-model.ts`
- `src/application/task-execution/run-coordinator.ts`
- `src/tests/task-execution-coordinator.test.ts`

Draudžiama:
- `dist/**`
- `node_modules/**`
- `ui-app/**`
- `src/domain/**`
- `src/interfaces/**`
- `src/composition/**`

## Veiksmas
- `run-coordinator-model.ts`: šalia `diagnoseCmd?` pridėk opcionalų `preservedWorkReview?: PreservedWorkReviewPorts` (type-only importas iš `./preserved-work-review-model.js`).
- `run-coordinator.ts`: perduok jį į `verifyTask` per sąlyginį spread'ą (`exactOptionalPropertyTypes`), nekeisdamas jokio kito dispatch žingsnio.
- `task-execution-coordinator.test.ts`: testas, kad fake `preservedWorkReview` portas pasiekia verify kelią, o be jo elgesys nesikeičia.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai abi patikros žalios. Sustok, jei prireiktų keisti `verify-task.ts` parašą, public CLI kontraktą ar `package.json`.

## Neįtraukta
Composition adapteris ir `command.ts` surišimas (atskira sekanti užduotis), timeout'o šaknis, preserved ref'ų valymo politika, UI.
