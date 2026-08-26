# Tasks

- [ ] readme-guard: perskaityti README.md ir architektūros dokumentą, patvirtinti, kad `domain/tasks`, `shared/markdown` ir `application/context-pack` ribos leidžia šį pakeitimą (domain → domain, shared; application → application, domain, shared), ir kad joks `node:` importas nepatenka į `domain` sluoksnį.
- [ ] architect: patvirtinti arba pakoreguoti design.md siūlomą sprendimą (pozicinis tęsinio eilučių sujungimas prieš residue skaičiavimą); ypač nuspręsti, ar `acceptance_criteria`/`out_of_scope` PUBLIC lauko forma keičiasi (jei taip — kelti `WORKER_TASK_IR_VERSION`), ir užfiksuoti sprendimą design.md.
- [ ] schedule-domain: diagnozuoti realius `AG/tasks/queue` + `done` failus, surinkti konkrečius pavyzdžius eilučių, kurios šiuo metu laikomos „neapskaitytomis" (daugiaeilio bullet tęsiniai, jei atsiranda kitų atvejų — užfiksuoti juos atskirai, ne spėti).
- [ ] coder: `src/domain/tasks/sections.ts` (arba `worker-task-ir.ts`, priklausomai nuo architect sprendimo) — implementuoti tęsinio eilučių sujungimą su bullet punktu, naudojant tik pozicinę taisyklę (iš karto po bullet/tęsinio, be tuščios eilutės, be `isScopeMarkerLine` markerio tarp jų); jokio atitraukimu (indentation) grįsto spėjimo.
- [ ] coder: `src/application/context-pack/worker-task-ir.ts` — pritaikyti `hasUnconsumedContent`/`lineHasResidue` naują sujungtą captured tekstą; NO SILENT LOSS struktūra (170-190 eilutės) nekeičiama, tik residue skaičiavimo tikslumas.
- [ ] coder (jei reikia pagal architect sprendimą): `worker-task-ir-schema.ts` — kelti `WORKER_TASK_IR_VERSION` ir atnaujinti komentarus, jei PUBLIC lauko reikšmės forma keičiasi.
- [ ] coder: `compact-dsl/**` — atnaujinti round-trip fixture'us tiek, kiek būtina dėl sumažėjusio `elements` sąrašo; lossless decode-atgal-į-tą-patį-IR įrodymas lieka nepakeistas savo tikrinimo esme.
- [ ] reviewer: patikrinti, kad joks pakeitimas neapeina NO SILENT LOSS ar FAIL CLOSED taisyklių (worker-task-ir.ts:12-25); patvirtinti, kad tęsinio sujungimo taisyklė yra griežtai pozicinė ir turi bent vieną negatyvų testą, įrodantį, kad nesusijęs turinys neišnyksta.
- [ ] tester: naujas fixture testas su daugiaeiliu bullet punktu `## Veiksmas`/`## Neįtraukta` sekcijoje — sekcija NEBĖRA `elements` sąraše kaip `raw` po pataisymo.
- [ ] tester: naujas negatyvus fixture testas — laisva, nesusijusi pastraipa sekcijos gale (be bullet prieš ją) LIEKA `elements` sąraše kaip `raw`.
- [ ] tester: korpuso matavimo testas per `AG/tasks/queue` + `AG/tasks/done` — IR vidurkis < raw vidurkis arba dubliavimas < 2%; skaičius fiksuotas assert'e/komentare.
- [ ] tester: patvirtinti, kad esamas lossless DSL round-trip testas lieka žalias (su atnaujintais fixture'ais, jei reikia).
- [ ] tester: jei `WORKER_TASK_IR_VERSION` keliama, patvirtinti, kad su tuo susijęs prompt'o skaitymo raktas atnaujintas ir egzistuojantis testas tai tikrina.
- [ ] documenter: `pnpm typecheck && pnpm test` paleisti ir rezultatą (įskaitant korpuso matavimo skaičių prieš/po) įrašyti į commit'o ataskaitą; aiškiai parašyti, ar `WORKER_TASK_IR_VERSION` keltas ir kodėl (arba kodėl ne); patvirtinti `CONTEXT_CACHE_VERSION` NEKELIAMAS, nebent pakeitimas realiai pasiekia context pack generavimo taką.

## AG Queue Tasks
- 031-compiled-prompt-preambules-mazinimas (depends_on: none) — fiksuoto skaitymo rakto (WORKER_TASK_IR_PROMPT_HEADING / COMPACT_DSL_PROMPT_HEADING) dydžio mažinimas, minėtas kaip Out Of Scope.
- 032-shadow-matavimo-poros-keitimas (depends_on: 030) — shadow/A-B matavimo poros atnaujinimas, kad atspindėtų naują (mažesnį) IR dydį po šio dedup; priklauso nuo 030, nes matavimo bazė keičiasi tik uždarius šį task'ą.
