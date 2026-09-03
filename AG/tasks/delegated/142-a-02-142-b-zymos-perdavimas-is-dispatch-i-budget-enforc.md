## Žingsnis 0 — ar jau įgyvendinta?
Prieš keisdamas kodą patikrink, ar ## Tikslas ir ## Patikra jau tenkinami esamame kode; jei taip — NEDARYK jokių pakeitimų ir galutinę ataskaitą pradėk atskira eilute:
ALREADY_IMPLEMENTED: <failai/eilutės, įrodančios kad darbas jau padarytas>
Jei task'as yra auditas/patikra, užbaigta be keistinų radinių — ataskaitą pradėk atskira eilute:
AUDIT_COMPLETE: <ką patikrinai ir kodėl keisti nieko nereikia>

## Sandbox taisyklės (privaloma — taupo turns)
- Po BET KOKIO `src` pakeitimo `dist` pasensta ir hook'ai blokuoja bash komandas. Pirma perbuild'ink TIKSLIA forma be pipe/redirect: `pnpm build`
- Patikroms naudok tik: `pnpm build` ir `pnpm test` (be `--`, be pipe į kitas komandas).
- `echo`, `sed`, `node -e` ir kompound komandos su neleistinais segmentais VISADA atmetamos — nekartok jų kitomis formomis; failams skaityti naudok Read/Grep tools.
- Rašymo darbą atlik PATS šioje sesijoje (Write/Edit) ir neatidėk jo vėlesniam laikui: headless sesija po paskutinio tavo žingsnio baigiasi, o bėgimas be nė vieno Write/Edit parkuojamas human-review — NEBENT ataskaita prasideda sąžiningu ALREADY_IMPLEMENTED arba AUDIT_COMPLETE markeriu su įrodymais (žr. Žingsnį 0). `## Agentai` grandinė yra orkestratoriaus maršruto metaduomuo — jei subagentas negrąžina rezultato šiame bėgime, įgyvendink pakeitimą tiesiogiai.

# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Priklausomybės
- 142-budget-enforcement-gerbia-human-review-approved-zyma (142-A: `enforceExecutionBudget` suppression kelias)

## Žingsnis 0 — ar jau įgyvendinta?
Jei 142-A pasirinko (B) šaką (biudžeto kanalas žymos sąmoningai nepaiso) — NEVYKDOMA: cituok `tool-budget-gates.ts` doc'ą kaip įrodymą ir baik. Jei `dispatch-task.ts` jau perduoda žymos turinį į `ports.policy.enforceBudget` request'ą — ALREADY_IMPLEMENTED su kodo ir testo citata.

## Tikslas
142-A padarė, kad `enforceExecutionBudget` gali slopinti `context files > max` priežastį, kai request'e yra HUMAN-REVIEW-APPROVED žyma. Šiame task'e žymos faktas realiai atkeliauja: `dispatch-task.ts` turi task tekstą, `run-coordinator-ports.ts` — request formą, composition — adapterio surišimą. Be šios grandies suppression kelias lieka nepasiekiamas iš gyvo dispatch launch.

## Agentai
PRIVALOMA grandinė (be praleidimų): readme-guard -> architect -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/application/task-execution/dispatch-task.ts`
- `src/application/task-execution/run-coordinator-ports.ts`
- `src/composition/loop/coordinator-execution-adapters.ts`
- `src/tests/task-execution-run.test.ts`

Draudžiama:
- `src/application/token-governance/tool-budget-gates.ts` (142-A scope)
- `src/tests/token-governance-gates.test.ts` (142-A scope)
- `src/domain/tasks/human-review/gates.ts`
- `src/interfaces/cli/dispatch/claude-preflight/index.ts`
- `src/application/context-pack/assemble/assemble.ts`
- `dist/**`
- `node_modules/**`

## Veiksmas
- `run-coordinator-ports.ts` `enforceBudget` request papildomas neprivalomu `humanReviewApproved?: string` lauku (`exactOptionalPropertyTypes` — per sąlyginį spread'ą), composition adapteris jį perduoda nekeisdamas.
- `dispatch-task.ts` žymą išsitraukia esamu domain keliu `analyzeHumanReviewGates` iš AKTYVAUS task teksto ir įdeda į request'ą tik kai ji galioja.
- Testai `task-execution-run.test.ts`: (1) task su galiojančia žyma → request'e `humanReviewApproved` yra ir launch nebeparkuojamas dėl `context files N > M`; (2) tas pats be žymos → parkavimas kaip iki šiol.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei paaiškėtų, kad `dispatch-task.ts` neturi patikimo kelio iki aktyvaus task teksto (reformuluoto vs žalio teksto dviprasmybė — kuriame ieškoti žymos yra kontrakto klausimas).

## Neįtraukta
- `enforceExecutionBudget` vidinė logika ir jos testas (142-A).
- `max_files` ribos reikšmės keitimas.
- 122 task'o rankinis atblokavimas — operatoriaus veiksmas.
