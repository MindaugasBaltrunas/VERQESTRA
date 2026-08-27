# Task

## Spec source
openspec/changes/verqestra-backlog-v1/
Etalonas: `D:\React\AG_loop\AG\orchestrator\src\orchestrator\tasks\task-events.ts` (62-67 eil.)

## Tikslas
Užfiksuoti migracijos ledger'yje, kad task perėjimų piltuvo šalutiniai kvietimai (learning emisija ir token-analytics snapshot'as) dabar prijungti `composition` sluoksnyje. Tai buvo migracijos spraga, NE nukrypimas nuo etalono: elgesys atkurtas 1:1, nes VQ-504 metu iš etalono `recordTaskEvent` perkelta tik jsonl eilutė, o du po jos einantys kvietimai liko nemigruoti.

## Agentai
Privaloma grandinė (nekeisk tvarkos): `readme-guard -> documenter`.

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
- Rask `migration-coverage.json` learning / task-events įrašą ir papildyk jį pastaba: piltuvo šalutiniai kvietimai prijungti per `coordinatorJournalPort.recordEvent`, tipas — užpildyta migracijos spraga, ne nukrypimas.
- Laikykis esamos failo struktūros ir laukų pavadinimų; naujų laukų ar sekcijų nekurk.
- Jokių kitų įrašų neliesk.

## Patikra
- `pnpm test`

## Stop
Commit'ink, kai patikra žalia. Sustok ir klausk, jei paaiškėtų, kad tinkamo įrašo nėra ir reikėtų kurti naują kategoriją arba keisti failo schemą.

## Neįtraukta
- Bet koks `src/` kodo ar testų keitimas — atlikta ankstesnėje užduotyje.
- Etalono `tasks.md` anotacija — nukrypimo nėra, tad jos nereikia.
- `dead-export-gate` griežtinimas ir istorinių perėjimų backfill.
