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
openspec/changes/verqestra-backlog-v1

## Tikslas
Prieš rašant vaiko task failą, patikrinti jo `## Failai / Leidžiama` kelius ta pačia taisykle. Vaiko task'as su įrodytai klaidingu keliu (tėvinio katalogo nėra) neparašomas be pataisos — `## Failai` paimama iš tėvinio task'o su garsia log eilute.

## Agentai
Privaloma grandinė: readme-guard -> architect -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/application/task-execution/task-splitting.ts`
- `src/tests/task-execution-rules.test.ts`

Draudžiama:
- `src/interfaces/cli/dispatch/claude-preflight/spec-source.ts`
- `src/interfaces/hooks/**`
- `.env`
- `node_modules/**`
- `dist/**`

## Veiksmas
- Katalogo egzistavimo patikrą gauk per esamus splitting portus arba injektuojamą predikatą; jokio naujo tiesioginio IO application sluoksnyje.
- Glob'ų ir „egzistuojantis katalogas + nesamas failas" atvejų nekeisk (fail-open).
- Testuok: vaikas su pramanytu keliu gauna tėvinę `## Failai` sekciją; švarus vaikas rašomas nepakeistas.

## Patikra
- `pnpm typecheck`
- `pnpm test`

## Stop
Commit'ink, kai abi patikros žalios. Sustok, jei prireiktų keisti scope guard'ų ar rollback pusę.

## Neįtraukta
- Repair fazės teisė perrašinėti task failą — atskiras kandidatas.
- 032-b-03 retrospektyva.
