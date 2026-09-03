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
Diagnozės priežasčių tekstuose atskirti du skirtingus atvejus: „executor made no write-tool calls" (darbo nebuvo) ir naujas „writes present, tree dirty, no commit — stop hook did not commit" (darbas buvo, problema hook'e). Operatorius neturi būti siunčiamas ieškoti dingusio darbo, kai kaltas hook'as.

## Agentai
PRIVALOMA grandinė, tokia tvarka: readme-guard -> debugger -> coder -> reviewer -> tester.

## Failai
Leidžiama:
- `src/domain/diagnosis/dispositions.ts`
- `src/tests/characterization-diagnosis.test.ts`
- `src/tests/fixtures/characterization/diagnosis-dispositions.json`

Draudžiama:
- `src/interfaces/hooks/on-stop.ts`
- `src/interfaces/hooks/on-stop-context.ts`
- `src/application/task-execution/verify-task.ts`
- `src/domain/policies/bash-command-policy.ts`
- `dist/**`
- `node_modules/**`

## Veiksmas
- Keisk TIK `resolveNoCommitReviewReason` ir priežasčių tekstus; `resolveNoCommitDisposition` sprendimo šakos (markerio ir fail-closed logika) lieka nepakeistos.
- Pridėk atskirą priežastį atvejui „rašymai buvo, medis purvinas, commit'o nėra" ir išlaikyk esamą „no write-tool calls" priežastį.
- Atnaujink characterization fixture'ą tik tiek, kiek keitėsi tekstai; testuose padengk abu atvejus.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai abi patikros žalios. Sustok ir klausk, jei priežasties atskyrimui prireiktų keisti priėmimo sprendimo šakas, ne tik įvardijimą.

## Neįtraukta
- Stop hook'o commit kelias — ankstesnis task'as.
- `verify-task.ts` žinutės — sekantis task'as.
