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
