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
148 vaikas 1 (`src/composition/cli/main.ts` — WorkflowInfrastructureError exitCode pasiekia proceso exit'ą). Be jo vaiko procesas niekada negrąžina 75 ir šis darbas neturi ką klasifikuoti.

## Tikslas
`src/composition/loop/command.ts:300` `runChild` grąžina `result.code === 0` — vieną bitą, kuriame infra baigtis (75) neatskiriama nuo task-failed. Įvesk aiškų slot baigties tipą, kurį `slot-task-runner.ts:156` perduoda aukščiau nekeisdamas prasmės.

## Agentai
PRIVALOMA grandinė (nekeisti, neapeiti): readme-guard -> architect -> coder -> reviewer -> tester.
architect apibrėžia baigties tipą ir jo kelią (runChild -> slot-task-runner -> vartotojai), coder įgyvendina.

## Failai
Leidžiama:
- `src/composition/loop/command.ts`
- `src/application/scheduling/slot-task-runner.ts`
- `src/tests/composition-loop-child-exit.test.ts`
- `src/tests/scheduling-slot-task-runner.test.ts`

Draudžiama:
- `src/application/scheduling/worker-integration.ts`
- `src/application/scheduling/wave-outcome.ts`
- `src/application/scheduling/loop-cycle.ts`
- `src/shared/exit-codes.ts`
- `dist/**`
- `node_modules/**`

## Veiksmas
- architect: apibrėžk baigties tipą (pvz. `"succeeded" | "task-failed" | "infrastructure"` su exit kodu), kur jis deklaruojamas, kad `application` neimportuotų `composition`, ir kaip esami `boolean` vartotojai išlieka veikiantys.
- `command.ts` `runChild`: `isInfrastructureExitCode(result.code)` -> infra baigtis su kodu; `formatChildExitDiagnostics` blokas lieka spausdinamas ir infra atveju.
- `slot-task-runner.ts`: porto tipas perduoda naują baigtį nepraradus exit kodo; testuose padenk visus tris atvejus (0, ne-infra ne-nulis, 75).

## Patikra
- `pnpm test`

## Stop
Sustok ir klausk, jei: naujam tipui reikėtų importo per sluoksnių ribą (`application` -> `composition`); reikėtų keisti exit kodų reikšmes; esamas testas prieštarauja naujam tipui (testas nesilpninamas).
Kai `pnpm test` žalias, commit'ink tik šio task'o failus ir baik.

## Neįtraukta
`worker-integration` park sprendimas ir `wave-outcome` atšaka, `loop-cycle` refill hold/abort — atskiri nuoseklūs task'ai.
