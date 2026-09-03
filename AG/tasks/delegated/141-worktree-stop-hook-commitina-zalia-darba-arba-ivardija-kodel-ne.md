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

## Tikslas
Diagnozuoti, kodėl 098 bėgime worktree Stop hook'as praėjo skenus, bet nepriėjo iki commit'o (nėra „git commit" eilučių, nėra `vq/logs/commit.log`), kai 097 tame pačiame kelyje praėjo — ir pataisyti Stop hook'o kelią taip, kad žalias vykdytojo darbas worktree būtų commit'inamas ARBA kiekviena ne-commit baigtis paliktų GARSIĄ log eilutę su priežastimi. Tyli tuštuma po žalio darbo — draudžiama.

## Agentai
PRIVALOMA grandinė, tokia tvarka: readme-guard -> debugger -> coder -> reviewer -> tester.

## Failai
Leidžiama:
- `src/interfaces/hooks/on-stop.ts`
- `src/interfaces/hooks/on-stop-context.ts`
- `src/tests/interfaces-hooks-on-stop.test.ts`

Draudžiama:
- `src/domain/policies/bash-command-policy.ts`
- `src/application/task-execution/verify-task.ts`
- `src/domain/diagnosis/dispositions.ts`
- `src/infrastructure/state/task-state-store.ts`
- `dist/**`
- `node_modules/**`

## Veiksmas
- DIAGNOZĖ pirma: perskaityk PILNAI kritusio 098 ir praėjusio 097 worktree kopijų `hooks.log` ir nustatyk, kurioje Stop hook'o grandinės vietoje keliai išsišakojo (hipotezės eile: staging scope filtras pagal stalią `current-task-file` žymę vaiko `vq/state` kopijoje; session-writes ledger'io būsena; commit šakos sąlyga). Išvadą įrašyk į ataskaitą.
- Pagal diagnozę pataisyk Stop hook'o kelią: žalias vykdytojo darbas commit'inamas, o kiekviena ne-commit baigtis loguoja aiškią priežastį.
- Testai: regresija su atkurta 098 sąlyga (commit įvyksta arba garsi priežastis log'e) ir 097 klasės kelias nepakitęs; esami on-stop testai lieka žali be silpninimo.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai abi patikros žalios. Sustok ir klausk, jei diagnozė rodo, kad šaknis reikalauja keisti bash politikos git bloką vykdytojui arba worktree bootstrap kopijavimo aibę (`vq/state` į kopiją) — abu platesni kontraktai.

## Neįtraukta
- `dispositions.ts` priežasčių tekstai — atskiras sekantis task'as.
- `verify-task.ts` „commit missing" vs „work missing" žinutės skirtis — atskiras sekantis task'as.
- Parkuotos 098 worktree kopijos darbo atgavimas — operatoriaus rankinis veiksmas.
- `current-task-file` valymas tėvo medyje — 126.
