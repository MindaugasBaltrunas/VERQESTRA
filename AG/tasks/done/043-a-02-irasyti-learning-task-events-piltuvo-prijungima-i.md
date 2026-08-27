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
- `openspec/changes/verqestra-backlog-v1/`
- Etalonas: `D:\React\AG_loop\AG\orchestrator\src\orchestrator\tasks\task-events.ts` (62-67 eil.)

## Tikslas
Užfiksuoti migracijos ledger'yje, kad task perėjimų piltuvo šalutiniai kvietimai (learning emisija ir token-analytics snapshot'as) dabar prijungti `composition` sluoksnyje. Tai užpildyta migracijos spraga, NE nukrypimas nuo etalono: elgesys atkurtas 1:1, nes VQ-504 metu iš etalono `recordTaskEvent` buvo perkelta tik jsonl eilutė, o du po jos einantys kvietimai liko nemigruoti.

## Agentai
Privaloma grandinė, nekeisk tvarkos: `readme-guard -> documenter`.

## Failai
Leidžiama:
- `migration-coverage.json`

Draudžiama:
- `src/`
- `AG/openspec/`
- `.env`
- `node_modules/`
- `dist/`

## Veiksmas
- Faile `migration-coverage.json` rask įrašą `"module": "orchestrator/learning"` (apie 262-268 eil.) ir jo esamo `evidence` lauko teksto gale pridėk sakinį, kad task perėjimų piltuvo šalutiniai kvietimai prijungti per `coordinatorJournalPort.recordEvent` `composition` sluoksnyje, tipas — užpildyta migracijos spraga, ne nukrypimas nuo etalono.
- Laikykis esamos failo struktūros, JSON formatavimo ir laukų pavadinimų; naujų laukų, įrašų ar sekcijų nekurk.
- Jokio kito ledger'io įrašo ir jokio failo už `## Failai / Leidžiama` ribų neliesk.

## Patikra
- `pnpm typecheck`
- `pnpm test`

## Stop
Commit'ink, kai abi patikros žalios. Sustok ir klausk, jei paaiškėtų, kad pastabai reikėtų naujo lauko, naujos kategorijos arba failo schemos keitimo.

## Neįtraukta
- Bet koks `src/` kodo ar testų keitimas — atlikta ankstesnėje užduotyje.
- Etalono `tasks.md` anotacija — nukrypimo nėra, tad jos nereikia.
- `dead-export-gate` griežtinimas ir istorinių perėjimų backfill.
