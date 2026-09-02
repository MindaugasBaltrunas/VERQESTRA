# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Priklausomybės
- 148-b-03-infra-baigtis-nebeparkuojama-kaip-task-failed-work

> 2026-09-02 pataisyta: priklausomybė buvo proza („148 vaikas 3 …"), ne task id, tad planuoklė
> jos nematė. Be 148-b-03 (`worker-integration` / `wave-outcome` infra baigtis be `task-failed`
> parko) loop lygyje nėra signalo, į kurį reaguoti.

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
