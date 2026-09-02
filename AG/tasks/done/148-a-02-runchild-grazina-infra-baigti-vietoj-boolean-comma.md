# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Tikslas
Application pusė: `SlotChildOutcome` (`"succeeded" | "task-failed" | "infrastructure"` su exit kodu) deklaruotas `application` sluoksnyje, `runChild` porto tipas ji grazina, o `createSlotTaskRunner` perduoda baigti aukstyn NEPRARADES exit kodo. Jokio importo is `composition`.

## Agentai
PRIVALOMA grandine (nekeisti, neapeiti): readme-guard -> architect -> coder -> reviewer -> tester.

## Failai
Leidziama:
- `src/application/scheduling/slot-task-runner.ts`
- `src/tests/scheduling-slot-task-runner.test.ts`

Draudziama:
- `src/composition/loop/command.ts`
- `src/application/scheduling/worker-integration.ts`
- `src/application/scheduling/wave-outcome.ts`
- `src/application/scheduling/loop-cycle.ts`
- `src/shared/exit-codes.ts`
- `dist/**`
- `node_modules/**`

## Veiksmas
- Zingsnis 0: patikrink, ar tikslas jau tenkinamas (`slot-task-runner.ts` tipas + porto parasas + baigties perdavimas be pakeitimo). Jei taip — NEDARYK jokiu pakeitimu ir ataskaita pradek atskira eilute `ALREADY_IMPLEMENTED: <failai/eilutes>`.
- Jei ne: architect apibrezia tipa ir jo deklaravimo vieta (`application`, kad nebutu importo i `composition`), coder ji ivedaa ir perduoda per `createSlotTaskRunner` nekeisdamas prasmes.
- Testuose padenk visus tris atvejus (`succeeded`, `task-failed` su ne-infra nenuliniu kodu, `infrastructure` su 75) — baigtis per runner keliauja nepakeista.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Sustok ir klausk, jei: naujam tipui reiketu importo per sluoksniu riba (`application` -> `composition`); reiketu keisti exit kodu reiksmes; esamas testas priestarauja tipui (testas NESILPNINAMAS).
Kai `pnpm test` zalias, commit'ink tik siuos du failus ir baik.

## Neitraukta
`src/composition/loop/command.ts` `runChild`/`classifyChildExitOutcome` ir `src/tests/composition-loop-child-exit.test.ts` — atskiras kitas task'as. `worker-integration` park sprendimas, `wave-outcome` atsaka, `loop-cycle` refill hold/abort — atskiri nuoseklus task'ai.
