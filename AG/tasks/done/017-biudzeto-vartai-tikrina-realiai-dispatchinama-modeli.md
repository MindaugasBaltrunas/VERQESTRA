## Žingsnis 0 — ar jau įgyvendinta?
Prieš keisdamas kodą patikrink, ar ## Tikslas ir ## Patikra jau tenkinami esamame kode.
Jei taip — NEDARYK jokių pakeitimų ir galutinę ataskaitą pradėk atskira eilute:
ALREADY_IMPLEMENTED: <failai/eilutės, įrodančios kad darbas jau padarytas>

## Sandbox taisyklės (privaloma — taupo turns)
- Po BET KOKIO `src` pakeitimo `dist` pasensta ir hook'ai blokuoja bash komandas. Pirma perbuild'ink TIKSLIA forma be pipe/redirect: `pnpm build`
- Patikroms naudok tik: `pnpm build` ir `pnpm test` (be `--`, be pipe į kitas komandas).
- `echo`, `sed`, `node -e` ir kompound komandos su neleistinais segmentais VISADA atmetamos — nekartok jų kitomis formomis; failams skaityti naudok Read/Grep tools.

# Task

## Spec source
openspec/changes/verqestra-backlog-v1

## Tikslas
Biudžeto vartai `runPreDispatchGates` turi tikrinti REALIAI dispatch'insimą modelį, ne `decision.selected_model` (012 atvejis: gate tikrino opus, dirbo sonnet). Application pusėje: portas modelio klasės skaičiavimui + vartų kvietimas su fallback.

## Agentai
Privaloma grandinė: readme-guard -> coder -> reviewer -> tester. readme-guard eina pirmas ir grąžina ribų santrauką.

## Failai
Leidžiama:
- `src/application/task-execution/run-coordinator-ports.ts`
- `src/application/task-execution/dispatch-task.ts`
- `src/tests/helpers/fake-task-run-ports.ts`
- `src/tests/task-execution-run.test.ts`

Draudžiama:
- `src/composition/loop/coordinator-execution-adapters.ts`
- `src/interfaces/cli/dispatch/claude-dispatch/dispatch-routing-plan.ts`
- `.env`
- `node_modules/**`
- `dist/**`

## Veiksmas
- `TaskRunPorts.policy` deklaruoti `resolveDispatchModelClass({ promptFile, taskId, phase, selectedModel? }): Promise<string>` su komentaru, kodėl vartai negali remtis decision modeliu.
- `runPreDispatchGates` prieš `enforceBudget` kviesti šį portą ir jo rezultatą paduoti kaip `model`; adapterio klaida NEparkuoja task'o — garsus log ir fallback į decision modelį (`selected_model` arba `sonnet`).
- Testai `task-execution-run.test.ts`: (a) routing grąžina kitą modelį nei decision — vartai gauna routing modelį; (b) routing modelis draudžiamas `enforceBudget` — dispatch blokuojamas prieš `ports.cli.run`; (c) porto klaida — vartai gauna decision modelį.

## Patikra
- `pnpm typecheck`
- `pnpm build`
- `pnpm test`

## Stop
Sustoti, kai visos patikros žalios ir vartams paduodamas modelis sutampa su porto grąžintu. Commitinti vienu commit'u su ataskaita (Pakeista / DB ribos / Job tipai / Testai / Rizikos / Ko neliečiau). Jei porto kontraktas reikalautų keisti kitus `TaskRunPorts` naudotojus už leidžiamų failų ribos — sustoti ir pranešti.

## Neįtraukta
- Composition adapterio realizacija (kita nuosekli užduotis).
- `routeModel` taisyklių keitimas.
- Attempt rezoliucijos vielinimas (task 015).
- Queue loop vykdymas.
