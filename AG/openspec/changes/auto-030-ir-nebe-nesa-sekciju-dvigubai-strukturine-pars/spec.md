# Spec Delta

## Added
- Nauja vidinė (neeksportuojama arba domain-lygio) logika `worker-task-ir.ts` (arba `sections.ts`) sekcijos kūno tęsinio eilutėms sujungti su jų bullet punktu prieš residue (`hasUnconsumedContent`) skaičiavimą.
- Naujas testas `src/tests/**`, kuris per `AG/tasks/queue` + `AG/tasks/done` korpusą (visi realūs `.md` task failai) apskaičiuoja: (a) `workerTaskIrChars(ir)` vidurkį, (b) raw failo `.length` vidurkį, ir assert'ina, kad santykis (IR vidurkis / raw vidurkis) < 1.02 arba IR vidurkis < raw vidurkis. Testas praleidžia (skip su aiškia priežastimi) tik tuo atveju, jei korpuse iš viso nėra tinkamų task failų (tuščias katalogas).
- Naujas testas, kuris konkrečiam fixture task'ui su daugiaeiliu bullet punktu `## Veiksmas` sekcijoje patvirtina, kad ta sekcija NEBĖRA `elements` sąraše kaip `raw` (nes visas jos turinys dabar laikomas suvartotu struktūrinio parse'o).
- Naujas negatyvus testas: fixture task su TIKRAI nesusijusia laisva pastraipa `## Veiksmas` sekcijos gale (be bullet prieš ją, ne jokio esamo punkto tęsinys) — ta pastraipa PRIVALO likti `elements` sąraše kaip `raw` (NO SILENT LOSS neatlaisvinamas).

## Changed
- `taskBulletItems`/residue skaičiavimo elgesys `worker-task-ir.ts` viduje: dabar sekcijos daugiaeilio bullet punkto tęsinio eilutė laikoma suvartota (consumed) to paties punkto, o ne nepadengta liekana.
- (Sąlyginai, tik jei pasirinkta design.md alternatyva) `acceptance_criteria`/`out_of_scope` reikšmės forma — jei item'ai pradeda talpinti pilną sujungtą tekstą vietoj vienos pirmos eilutės, `WORKER_TASK_IR_VERSION` keliamas iš 1 į 2 ir tai dokumentuojama schema faile bei prompt'o skaitymo rakte.

## Acceptance Criteria
- `pnpm typecheck && pnpm test` žali be jokio susilpninto ar praleisto testo.
- Naujas korpuso matavimo testas įrodo, kad IR vidurkis realiuose `AG/tasks/queue`+`done` failuose yra mažesnis už raw vidurkį ARBA turinio dubliavimas < 2%; konkretus skaičius fiksuotas testo assert'e ar komentare, ne vien teiginyje.
- Esamas lossless round-trip testas (DSL encode → decode → tas pats IR) praeina nepakeistas savo tikrinimo esme, net jei fixture duomenys atsinaujina dėl mažesnio `elements` sąrašo.
- Fixture testas su daugiaeiliu bullet punktu patvirtina, kad ta sekcija NEBEDUBLIUOJAMA `elements` bloke.
- Negatyvus fixture testas patvirtina, kad tikrai neatpažintas (nesusijęs) turinys IR TOLIAU patenka į `elements` kaip `raw` — NO SILENT LOSS taisyklė lieka įrodoma testu, ne vien komentaru.
- Jei `WorkerTaskIr` lauko reikšmės prasmė keičiasi, `WORKER_TASK_IR_VERSION` pakeltas ir tai paminėta commit'o ataskaitoje; jei nesikeičia, ataskaitoje aiškiai parašyta, kodėl versijos kėlimas nereikalingas.
- Jokio naujo `node:` importo `domain` sluoksnyje; importų grafas lieka acikliškas.
