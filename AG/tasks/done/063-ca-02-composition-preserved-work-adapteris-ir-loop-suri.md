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
AG/openspec/changes/verqestra-backlog-v1/

## Tikslas
Surišti preserved work review portus su realiais adapteriais loop composition sluoksnyje: `createRunCoordinator` jau priima `preservedWorkReview` opciją (run-coordinator.ts, PreservedWorkReviewPorts modelis jau egzistuoja) — reikia sukurti realius adapterius ir prijungti juos `command.ts` dispatch kelyje.

## Agentai
Privaloma grandinė: readme-guard -> architect -> coder -> reviewer -> tester. Jei subagentas negrąžina rezultato šiame bėgime, pakeitimą įgyvendink PATS Write/Edit įrankiais — bėgimas be nė vieno Write/Edit atmetamas.

## Failai
Leidžiama:
- `src/composition/loop/preserved-work-adapters.ts`
- `src/composition/loop/command.ts`
- `src/tests/composition-preserved-work-wiring.test.ts`

Draudžiama:
- `dist/**`
- `node_modules/**`
- `ui-app/**`
- `src/domain/**`
- `src/interfaces/**`
- `src/application/**`

## Veiksmas
- Naujame `preserved-work-adapters.ts` sukurk `preservedWorkReviewPort(input: { projectRoot: string })` factory, grąžinantį `PreservedWorkReviewPorts` (`src/application/task-execution/preserved-work-review-model.ts`): `materialize(ref)` per `materializePreservedWork` iš `infrastructure/git/preserved-work.js`, `runCheck(worktreePath, command)` per `runShell` iš `infrastructure/process/run-process.js` su `cwd = worktreePath`.
- `command.ts`: `createRunCoordinator(taskRunPorts({...}), { preservedWorkReview: preservedWorkReviewPort({ projectRoot }) })` in-process `runSlotTask` kelyje (~eilutė 210-223), nekeičiant kitų dispatch žingsnių ar CLI kontrakto.
- Naujame teste patikrink: su adapteriu žalias preserved darbas praeina iki `done` su `PRESERVED-WORK-RECOVERED`; be adapterio (options be `preservedWorkReview`) elgesys nekinta.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai abi patikros žalios. Sustok, jei prireiktų keisti public CLI kontraktą, `package.json` ar application portų parašus (`run-coordinator-ports.ts`, `preserved-work-review-model.ts`).

## Neįtraukta
Timeout'o šaknies sprendimas, preserved ref'ų valymo politika, UI rodymas.
