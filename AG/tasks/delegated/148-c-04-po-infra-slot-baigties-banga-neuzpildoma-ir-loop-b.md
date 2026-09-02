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

## Priklausomybės
148 vaikas 3 (`worker-integration` / `wave-outcome` grąžina infra baigtį be `task-failed` parko). Be jo loop lygyje nėra signalo, į kurį reaguoti.

## Tikslas
Dvi nesuderintos semantikos tam pačiam įvykiui: usage limitas pirminio medžio slot'e sustabdo loop'ą (`LOOP ABORT (infrastruktura)`), o vaiko slot'e ciklas rašo `WAVE SLOT ENDED NONZERO … CONTINUING QUEUE` ir degina eilę toliau. Vaiko infra baigtis turi elgtis kaip in-process kelias: bangos daugiau neužpildomos, loop'as baigiasi tuo pačiu infra kodu arba laukia, jei toks mechanizmas jau yra.

## Agentai
PRIVALOMA grandinė (nekeisti, neapeiti): readme-guard -> architect -> coder -> reviewer -> tester.

## Failai
Leidžiama:
- `src/application/scheduling/loop-cycle.ts`
- `src/tests/scheduling-loop-cycle.test.ts`

Draudžiama:
- `src/application/scheduling/worker-integration.ts`
- `src/application/scheduling/wave-outcome.ts`
- `src/composition/loop/command.ts`
- `src/shared/exit-codes.ts`
- `dist/**`
- `node_modules/**`

## Veiksmas
- architect: prieš išradinėdamas naują mechanizmą patikrink esamą `isInfrastructureExitCode` naudojimą (`empty-queue-adapters.ts:130`) ir `loop-cycle.ts` refill/hold kelią; įvardyk, ar vaiko infra baigtis meta tą pačią `WorkflowInfrastructureError` kaip in-process kelias, ar loop lieka gyvas su hold — ir kodėl.
- `loop-cycle.ts`: po infra slot baigties refill'ai sustoja, o loop'as baigiasi tuo pačiu infra exit kodu (arba pereina į esamą hold kelią) — viena semantika abiem keliams.
- `scheduling-loop-cycle.test.ts`: testas, kad po infra baigties nauji slot'ai nebeprovisioninami ir loop grąžina infra kodą; papildomai testas, kad ne-infra ne-nulis baigtis eilės degimo nekeičia.

## Patikra
- `pnpm test`

## Stop
Sustok ir klausk, jei: reikėtų keisti exit kodų reikšmes ar `cli-exit-contracts.json`; hold mechanizmas reikalautų naujo porto ar dependency; du bandymai iš eilės krenta dėl tos pačios priežasties.
Kai `pnpm test` žalias, commit'ink tik šio task'o failus ir baik.

## Neįtraukta
Nieko — tai paskutinis 148 grandinės darbas.
