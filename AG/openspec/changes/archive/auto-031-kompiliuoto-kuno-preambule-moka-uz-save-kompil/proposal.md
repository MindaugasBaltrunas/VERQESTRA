# Proposal

## Why
Auditas 2026-08-26 (docs/audits/) išmatavo `worker-prompt-compilation.ts` abiejų renderių fiksuotą preambulę ir nustatė, kad ji viena prideda ~586 ženklus prie kompiliuoto kūno — apie 27% viso raw task dydžio mažam task'ui. Kompaktiškas DSL prompt'as (3 356 ženklai) šiandien NĖRA mažesnis už IR JSON prompt'ą (2 770), nes DSL dokumento glaudinimo sutaupymą pilnai suvalgo ilgesnė (~10 eilučių) markerių legenda. `guardCompiledWorkerPromptSize` (task 0001: kompiliuotas kūnas privalo MOKĖTI, t. y. būti griežtai mažesnis už raw) šiandien dažnai atmeta kompaktišką DSL kelią vien dėl preambulės kainos, ne dėl paties glaudinimo neveiksmingumo. Tai maskuoja realų DSL renderio naudingumą telemetrijoje ir mažina compression coverage mažiems task'ams, kuriems glaudinimas turėtų padėti labiausiai.

## Scope
- `renderWorkerTaskIrPrompt` ir `renderCompactWorkerDslPrompt` (`src/application/context-pack/worker-prompt-compilation.ts:255-289`) preambulių sutrumpinimas iki minimumo, kuris išlaiko vienareikšmį (unambiguous) worker'io skaitymą.
- DSL markerių legendos glaudinimas (`src/application/context-pack/worker-prompt-compilation.ts:279-284`): viena eilutė vietoj dešimties, sutartiniai skyrikliai vietoj pilno sakinio kiekvienam markeriui.
- IR JSON preambulės glaudinimas (`src/application/context-pack/worker-prompt-compilation.ts:262-266`): pašalinti pasikartojimus (task_id/sha jau eilutėje aukščiau; JSON struktūros laukai jau savaime aprašomi schema).
- Naujas arba papildytas testas realiame korpuse, tikrinantis fiksuotą preambulės+fence pridėtinę kainą (`compiledChars − document chars`) ≤ 250 ženklų abiem režimams (`worker_task_ir`, `compact_dsl`).
- `compact-dsl` modulio (`src/application/context-pack/compact-dsl/**`) keitimai leidžiami TIK jei jie būtini legendos glaudinimui (pvz. markerių pavadinimų suvienodinimui su glaudinama legenda); dokumento formato (paties DSL sintaksės) keisti NEREIKIA.

## Out Of Scope
- Prompt'o lygio dedup tarp task body ir execution context (task 029 — jau uždaryta atskirai).
- `WorkerTaskIr` struktūros ar `compact-dsl` dokumento formato (sintaksės, markerių reikšmių) keitimas — tai task 030 apimtis, kuri bėga PRIEŠ šį.
- Matavimo/telemetrijos pusė (kaip `compiledChars`/`rawChars` renkami ir raportuojami) — task 032 apimtis.
- `guardCompiledWorkerPromptSize` sprendimo logikos (>= palyginimas, fallback keliai) keitimas — jos semantika lieka nepaliesta, tik įvestis (trumpesnė preambulė) keičiasi.
- Etalono (`D:\React\AG_loop`) failų keitimas.

## Architecture Boundaries
- Modulis: `application/context-pack` (sluoksnis: `application` → gali importuoti `application, domain, shared`).
- Paliečiami failai: `src/application/context-pack/worker-prompt-compilation.ts`, `src/application/context-pack/compact-dsl/**` (tik jei būtina legendos glaudinimui), `src/tests/**` (naujas/papildytas preambulės dydžio testas).
- Reads: nėra (DB schemų neliečia; grynos funkcijos, gaunančios `WorkerTaskIr`/dokumentą kaip argumentą).
- Writes: nėra.
- Job types: nėra (kompiliavimo funkcija, ne worker job; kviečiama dispatch metu iš `compileWorkerPromptTaskForDispatch`, kuri lieka nepaliesta kaip viešas kontraktas).
- Public kontraktai nesikeičia: `WorkerPromptMode`, `WorkerPromptCompilation`, `compileWorkerPromptTaskForDispatch`, `guardCompiledWorkerPromptSize`, `compressionSizeFallbackReason` signatūros ir elgesys lieka tie patys — keičiasi tik preambulės TEKSTAS abiejuose renderiuose.
