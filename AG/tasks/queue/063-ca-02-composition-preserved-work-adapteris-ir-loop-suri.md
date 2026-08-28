# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Tikslas
Surišti preserved work review portus su realiais adapteriais loop composition sluoksnyje, kad automatinė išsaugoto darbo peržiūra veiktų gyvame dispatch kelyje. Prielaida: `createRunCoordinator` jau priima `preservedWorkReview` opciją (ankstesnė užduotis).

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
- Naujame `preserved-work-adapters.ts` sukurk `PreservedWorkReviewPorts` factory: `materialize` per `infrastructure/git/preserved-work.js` `materializePreservedWork`, `runCheck` per `infrastructure/process` runner'į su `cwd = worktreePath`; jokios verslo logikos, tik adaptavimas į application tipus.
- `command.ts`: priduok šį portą `createRunCoordinator` opcijose (verify-task kelias), nekeisdamas kitų dispatch žingsnių ar CLI kontrakto.
- Testas: su adapteriu žalias preserved darbas praeina iki `done` su `PRESERVED-WORK-RECOVERED`; be adapterio elgesys nekinta.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai abi patikros žalios. Sustok, jei prireiktų keisti public CLI kontraktą, `package.json` ar application portų parašus.

## Neįtraukta
Timeout'o šaknies sprendimas, preserved ref'ų valymo politika, UI rodymas.
