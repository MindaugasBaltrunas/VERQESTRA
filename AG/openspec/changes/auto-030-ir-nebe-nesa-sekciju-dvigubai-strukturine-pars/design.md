# Design

## Approach
1. **Diagnozė (įrodyta kodu, ne spėjimu).** `taskBulletItems` (`src/domain/tasks/sections.ts:69-74`) filtruoja tik eilutes, atitinkančias `BULLET_ITEM` regex; kiekviena kita eilutė (tęsinys be `-` prefikso) į `captured` sąrašą nepatenka. `hasUnconsumedContent`/`lineHasResidue` (`worker-task-ir.ts:237-259`) po to kiekvieną sekcijos eilutę tikrina atskirai — tęsinio eilutė niekada neatitinka jokio `captured` item'o (nes item'as yra tik pirmos bullet eilutės tekstas), taigi `residual` lieka netuščias ir VISA sekcija patenka į `elements` kaip `raw`. Tai sistemingai kartojasi standartiniame task šablone, nes `## Veiksmas` ir `## Neįtraukta` sekcijos realiuose failuose beveik visada turi bent vieną punktą, nusidriekusį per kelias eilutes (žr. pvz. šio paties task'o `## Veiksmas` sekciją).
2. **Sprendimas: sujungti tęsinio eilutes su jų punktu PRIEŠ `taskBulletItems`/residue skaičiavimą**, ne keisti pačią NO SILENT LOSS taisyklę. Sekcijos kūne (`section.body`) pirmiausia atlikti logical-line sujungimą: eilutė yra tęsinys, jei ji NĖRA bullet eilutė (`BULLET_ITEM` neatitinka), NĖRA tuščia, NĖRA `isScopeMarkerLine`, ir eina iš karto po eilutės, kuri jau priklauso einamam punktui (bullet arba ankstesnis tęsinys). Sujungtos eilutės tampa vieno `captured` item'o dalimi (pvz. sujungtos per tarpą arba `\n`, kad `lineHasResidue` matytų item'o tekstą per abi eilutes).
3. Vietoj naujos eksportuojamos funkcijos domenui, pridėti mažą private helper'į `worker-task-ir.ts` viduje (arba `sections.ts`, jei jį naudos ir kitos vietos), kuris prieš `taskBulletItems(bodyOf(...))` kvietimą sujungia tęsinio eilutes į jų bullet punktą TIK residue skaičiavimo tikslu — `acceptance_criteria`/`out_of_scope` PUBLIC lauko reikšmė (worker matomas laukas) gali likti nepakitusi (kiekvienas item — pirma bullet eilutė) arba būti praplėsta pilnu sujungtu tekstu; sprendimas priklauso nuo to, ką realiai naudoja downstream renderer (`render-candidates.ts`/`compact-dsl`) — jei jie šiuo metu praranda tęsinio tekstą PUBLIC lauke, tai jau atskira, bet susijusi spraga, kurią reikia įvardyti (ne nutylėti), net jei jos taisymas peržengia šio task'o minimalią apimtį.
4. **Alternatyva, atmesta**: keisti `isScopeMarkerLine`/`BULLET_ITEM` regex, kad jis "atspėtų" tęsinį pagal atitrauką (indentation) — atmesta, nes tikri task failai nenaudoja nuoseklaus atitraukimo tęsiniams (pvz. šio task'o tekstas), tad heuristika būtų fail-open (galėtų klaidingai laikyti naują, neatpažintą sakinį "tęsiniu" ir jį prarasti). Saugesnis kelias — pozicinis (eina iš karto po bullet/tęsinio eilutės, be tuščios eilutės tarpe), o ne atitraukimu grįstas.
5. Sėkmės matavimas: naujas testas `src/tests/**` paleidžia `compileWorkerTaskIr` per visą `AG/tasks/queue` + `AG/tasks/done` korpusą, palygina `workerTaskIrChars(ir)` vidurkį su raw failo `.length` vidurkiu ir assert'ina, kad IR vidurkis < raw vidurkis ARBA santykis (IR/raw - 1) < 0.02. Skaičius fiksuojamas test assert'e su komentaru, kada ir kokiu korpuso dydžiu matuota.
6. Lossless round-trip įrodymas (DSL encode → decode → tas pats IR) lieka privalomas testas ir turi praeiti su naujai sumažintu `elements` sąrašu — jei sujungimas sumažina `elements`, DSL round-trip fixture'ai gali reikėti atnaujinti tik tiek, kiek keičiasi faktinis IR turinys (ne testo tikslas).

## Data Flow
```
task Markdown (disk)
  -> enumerateTaskSections()                      [nepakeista]
  -> per MAPPED_SECTIONS: bodyOf(section)
       -> [NAUJA] sujungti tęsinio eilutes su jų bullet punktu (tik residue skaičiavimui)
       -> taskBulletItems() / parseBacktickChecks() / nonEmptyLines()   [struktūrinis captured]
       -> hasUnconsumedContent(body, captured)     [dabar mato sujungtą tekstą, ne pavienę eilutę]
            -> false (dažniausias atvejis po pataisymo): sekcija NEDUBLIUOJAMA elements bloke
            -> true (tikrai neatpažintas turinys): sekcija IR TOLIAU patenka į elements kaip raw
  -> workerTaskIrSchema.parse(...) -> WorkerTaskIr
  -> workerTaskIrChars(ir) matuojamas prieš/po korpuso teste
```

## Risks
- **Fail-open rizika**: jei sujungimo heuristika per plati (per daug eilučių palaiko "tęsiniu"), tikrai neatpažintas turinys gali dingti be verbatim fallback'o — tiesiogiai pažeidžia NO SILENT LOSS. Mitigacija: sujungimo taisyklė grynai pozicinė (iš karto po bullet/tęsinio, be tuščios eilutės ir be markerio tarp jų), su testu, kuris specialiai įrodo, kad TIKRAI nesusijusi laisva pastraipa sekcijos gale (be jokio bullet prieš ją) LIEKA raw elemente.
- **PUBLIC lauko semantikos keitimas**: jei `acceptance_criteria`/`out_of_scope` item'ų tekstas išplečiamas sujungtu turiniu, tai keičia `WorkerTaskIr` lauko REIKŠMĖS prasmę workeriui (papildomas tekstas, kurio anksčiau ten nebuvo) — tokiu atveju `WORKER_TASK_IR_VERSION` PRIVALO kilti ir prompt'o skaitymo raktas (`WORKER_TASK_IR_PROMPT_HEADING` ar analogas) atnaujinamas kartu. Jei sprendimas apsiriboja tik residue skaičiavimu (public laukas nesikeičia), versija NEKELIAMA, bet tai aiškiai užrašoma design pastaboje ir commit'o ataskaitoje.
- **Korpuso matavimo trapumas**: `AG/tasks/queue`/`done` turinys kinta laike (užduotys užbaigiamos, naujos atsiranda) — testas turi naudoti sąrašą, esantį repo momentu, kai testas paleidžiamas, o ne fiksuotą sąrašą failų vardų, kad neapsimeluotų vėliau pasikeitus queue turiniui.
- **CONTEXT_CACHE_VERSION** nekeliamas iš šio change'o, nebent IR turinio pakeitimas realiai pasiekia context pack'o generavimo taką (retrieval/reitingavimas/biudžetas) — jei taip, CLAUDE.md reikalauja kėlimo ir tai turi būti atskirai patikrinta prieš commit'ą.
