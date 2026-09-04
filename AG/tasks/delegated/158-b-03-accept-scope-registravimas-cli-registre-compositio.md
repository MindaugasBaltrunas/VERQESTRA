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
- 158-a-02-accept-scope-cli-adapteris-interfaces

Prielaida iš Dalies 2: `src/interfaces/cli/task-queue/accept-scope.ts` privalo egzistuoti.
Jei jo nėra — STOP.

## Žingsnis 0 — ar jau įgyvendinta?
Jei `src/composition/cli/commands-tasks.ts` jau registruoja `accept-scope` ir
`src/tests/composition-cli.test.ts` komandų sąrašas turi `"accept-scope"` — ALREADY_IMPLEMENTED
su abiem citatomis.

## Tikslas
Prijungti `accept-scope` prie CLI registro, kad komanda būtų pasiekiama operatoriui su tais
pačiais fs portais kaip gretimos task queue komandos.

## Agentai
readme-guard -> architect -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/composition/cli/commands-tasks.ts`
- `src/tests/composition-cli.test.ts`

Draudžiama:
- `src/interfaces/cli/task-queue/accept-scope.ts`
- `src/interfaces/cli/task-queue/requeue.ts`
- `src/domain/tasks/failai-scope-edit.ts`
- `README.md`
- `dist/**`
- `node_modules/**`

## Veiksmas
- Įrašyk registro įrašą `accept-scope <task-file-or-name> <path…>` su aprašu iškart po `requeue`
  (`commands-tasks.ts:63`), fs portus imk kaip gretimos komandos (`nodeFsAdapter`).
- Papildyk `composition-cli.test.ts` komandų sąrašą (164-199 eil.) reikšme `"accept-scope"` po
  `"requeue"`.
- Nekurk naujų portų ir nekeisk gretimų komandų registracijos.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Privaloma nurodyta agentų grandinė. Commit'ink, kai patikros žalios. Stop ir klausk, jei komandai
prireiktų porto, kurio gretimos task queue komandos neturi.

## Neįtraukta
- README „Task queue" lentelės eilutė — kita dalis.
- Adapterio logikos keitimai — dalies 2 scope.
