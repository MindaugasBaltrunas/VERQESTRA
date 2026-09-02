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
Composition puse: `runChild` (`src/composition/loop/command.ts`) nebegrazina `result.code === 0` boolean'o, o klasifikuoja exit koda i `SlotChildOutcome` — infra kodas (75) tampa `infrastructure` su kodu, kitas nenulinis — `task-failed` su kodu, 0 — `succeeded`. Priklauso nuo ankstesnio task'o, kuris deklaravo `SlotChildOutcome` ir porto parasa `src/application/scheduling/slot-task-runner.ts`.

## Agentai
PRIVALOMA grandine (nekeisti, neapeiti): readme-guard -> architect -> coder -> reviewer -> tester.

## Failai
Leidziama:
- `src/composition/loop/command.ts`
- `src/tests/composition-loop-child-exit.test.ts`

Draudziama:
- `src/application/scheduling/slot-task-runner.ts`
- `src/tests/scheduling-slot-task-runner.test.ts`
- `src/application/scheduling/worker-integration.ts`
- `src/shared/exit-codes.ts`
- `dist/**`
- `node_modules/**`

## Veiksmas
- Zingsnis 0: patikrink, ar `runChild` jau grazina `SlotChildOutcome` per eksportuota klasifikatoriu ir ar testas dengia 0 / ne-infra nenulini / 75. Jei taip — NEDARYK pakeitimu ir ataskaita pradek eilute `ALREADY_IMPLEMENTED: <failai/eilutes>`.
- Jei ne: ivesk gryna eksportuota klasifikavimo funkcija (`isInfrastructureExitCode` sprendimas) ir kviesk ja `runChild` grazinime.
- Uztikrink, kad `formatChildExitDiagnostics` blokas lieka spausdinamas ir infra atveju; testuose padenk visus tris kodus.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Sustok ir klausk, jei: reiketu keisti exit kodu reiksmes ar `src/shared/exit-codes.ts`; klasifikatorius reikalautu keisti porto tipa `application` sluoksnyje (tai ankstesnio task'o riba); esamas testas priestarauja klasifikacijai (testas NESILPNINAMAS).
Kai `pnpm test` zalias, commit'ink tik siuos du failus ir baik.

## Neitraukta
`worker-integration` park sprendimas ir `wave-outcome` atsaka, `loop-cycle` refill hold/abort — atskiri nuoseklus task'ai.
