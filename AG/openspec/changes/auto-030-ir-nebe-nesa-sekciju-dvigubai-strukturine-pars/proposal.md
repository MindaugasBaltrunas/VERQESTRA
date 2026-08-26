# Proposal

## Why
`compileWorkerTaskIr` (`src/application/context-pack/worker-task-ir.ts:168-191`) laikosi savo dokumentuotos NO SILENT LOSS taisyklės (18-22 eilutės): kai atpažintos sekcijos struktūrinis parse'as nepadengia kiekvienos eilutės, visas sekcijos kūnas PAPILDOMAI patenka į `elements` kaip `raw`. Tai teisingai apsaugo nuo praradimo, bet realiuose task failuose praktiškai visada suveikia — auditas 2026-08-26 (53 failai) parodė vien IR string turinio vidurkį 2 393 ženklų prieš 2 186 vidutinį raw failo dydį (~+9%), nes IR turi tiek struktūrą, TIEK tą pačią sekciją verbatim. Šaknis nustatyta kode: `taskBulletItems`/`stripBulletPrefix` (`src/domain/tasks/sections.ts:69-74`, `src/shared/markdown.ts:53-55`) atpažįsta TIK eilutes, prasidedančias bullet žymekliu (`BULLET_ITEM` regex); daugiaeilio sąrašo punkto tęsinio eilutė (be `-` prefikso) niekada nepatenka į `captured`, todėl `hasUnconsumedContent` (worker-task-ir.ts:246-249) ją visada laiko liekana ir visa sekcija (pvz. `## Veiksmas`) dubliuojasi kaip `raw` elementas, nors struktūrinis parse'as jau pagavo kiekvieną bullet'o pirmą eilutę. `## Failai` `Leidžiama:`/`Draudžiama:` antraštės jau apsaugotos per `isScopeMarkerLine`, tad prie dubliavimo neprisideda.

## Scope
- `src/domain/tasks/sections.ts` — `taskBulletItems` (arba nauja funkcija tame pačiame faile) atpažįsta daugiaeilio bullet punkto tęsinio eilutes (eilutė be bullet prefikso, einanti iš karto po bullet eilutės ir be savo antraštės/markerio) kaip to paties punkto dalį, o ne kaip atskirą neatpažintą liekaną.
- `src/shared/markdown.ts` — jei reikalinga papildoma pagalbinė funkcija tęsinio eilutei atpažinti (pvz. „ar eilutė yra continuation, ne naujas punktas, ne tuščia, ne markeris"); jokio esamo eksporto elgesio nekeisti be naujo parametro/perkrovimo.
- `src/application/context-pack/worker-task-ir.ts` — `hasUnconsumedContent`/`lineHasResidue` naudoja išplėstą capture'ą taip, kad tęsinio eilutės būtų laikomos suvartotomis (consumed) tų pačių `acceptance_criteria`/`out_of_scope` punktų, kuriems jos priklauso; NO SILENT LOSS logika (170-190 eilutės) nekeičiama struktūriškai — tik `captured`/residue skaičiavimas tampa tikslesnis.
- `src/application/context-pack/worker-task-ir-schema.ts` — versijos kėlimas (`WORKER_TASK_IR_VERSION`) TIK jei pasikeičia lauko REIKŠMĖS prasmė (pvz. `acceptance_criteria` pradeda talpinti sujungtą daugiaeilį tekstą vietoj vienos eilutės); jei pakeitimas tik sumažina `elements` dubliavimą nekeičiant jokio kito lauko formos, versija nekeliama, bet sprendimas dokumentuojamas design.md.
- `src/application/context-pack/compact-dsl/**` — jei DSL encode/decode testai priklauso nuo dabartinio `elements` turinio (pvz. round-trip fixture su duplikuotu raw bloku), atnaujinti tik tiek, kiek reikia, kad lossless round-trip įrodymas liktų teisingas su naujai sumažintu `elements` sąrašu.
- Testai po `src/tests/**`, įskaitant naują matavimo testą ant `AG/tasks/queue` + `AG/tasks/done` korpuso.

## Out Of Scope
- Prompt'o lygio dedup tarp task kūno ir execution context — task 029 (jau uždaryta).
- Compiled prompt preambulės (fiksuoto skaitymo rakto) mažinimas — task 031.
- Shadow/A-B matavimo poros keitimas — task 032.
- Bet kokia nauja LLM/heuristinė sumarizacija — draudžiama pagal NO SUMMARIZATION taisyklę (worker-task-ir.ts:14-17); šis change'as tik tikslina esamą deterministinį parse'ą, nieko neapibendrina.
- `## Failai` `Leidžiama:`/`Draudžiama:` markerio logikos keitimas — jau teisingai veikia per `isScopeMarkerLine`.

## Architecture Boundaries
- Moduliai: `domain/tasks` (domain sluoksnis — leidžiama domain, shared; jokio `node:` importo), `shared/markdown` (shared sluoksnis), `application/context-pack` (application — leidžiama application, domain, shared). Sluoksnių riba nekeičiama, importų kryptis lieka ta pati (application → domain → shared).
- Reads DB schemas: nėra (grynos funkcijos, jokio IO; įėjimas — task Markdown string).
- Writes DB schemas: nėra.
- Job types: nėra (kompiliatorius neturi dispatch/queue ryšio; kviečiamas iš esamų taškų be pakeitimo).
