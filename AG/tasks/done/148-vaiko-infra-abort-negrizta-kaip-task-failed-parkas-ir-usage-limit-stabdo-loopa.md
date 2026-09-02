# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Tikslas
Vaiko procesas, kuris krito dėl infrastruktūros (usage limit, exit 75), turi baigtis tuo pačiu kodu, o ne `UNEXPECTED_ERROR_EXIT_CODE` (1). Dabar `src/composition/cli/main.ts:58-61` catch'as tikrina tik `infrastructureExitCodeForError`, kuris atpažįsta vien errno klaidas, tad `WorkflowInfrastructureError(exitCode=75)` proceso riboje virsta 1. Tai pirmoji iš trijų grandinės spragų — be jos tėvas fiziškai negali atskirti infra baigties nuo task-failed.

## Agentai
PRIVALOMA grandinė (nekeisti, neapeiti): readme-guard -> coder -> reviewer -> tester.
readme-guard eina pirmas ir grąžina ribų santrauką; tolesni agentai remiasi ja.

## Failai
Leidžiama:
- `src/composition/cli/main.ts`
- `src/tests/composition-cli.test.ts`

Draudžiama:
- `src/shared/exit-codes.ts`
- `src/tests/fixtures/characterization/cli-exit-contracts.json`
- `src/composition/loop/command.ts`
- `src/application/scheduling/worker-integration.ts`
- `dist/**`
- `node_modules/**`

## Veiksmas
- `main.ts` catch šakoje: jei `error instanceof WorkflowInfrastructureError` ir jos `exitCode !== undefined` (laukas optional, žr. `src/shared/errors.ts:56-71`), grąžink tą kodą; kitu atveju kelias lieka nepakitęs — `infrastructureExitCodeForError(error) ?? UNEXPECTED_ERROR_EXIT_CODE`.
- `io.error` diagnostikos eilutė lieka kaip buvusi — operatorius turi matyti priežastį ir prie infra baigties.
- `composition-cli.test.ts`: pridėk testą, kad komanda, metanti `WorkflowInfrastructureError` su `exitCode: 75`, duoda `runCli` grąžą 75, ir testą, kad ta pati klaida BE `exitCode` toliau duoda `UNEXPECTED_ERROR_EXIT_CODE`.

## Patikra
- `pnpm test`

## Stop
Sustok ir klausk, jei: reikėtų keisti exit kodų reikšmes arba `cli-exit-contracts.json` charakterizaciją; reikėtų keisti `WorkflowInfrastructureError` konstruktoriaus kontraktą; esamas testas rodo priešingą lūkestį (silpninti testą draudžiama — tada taisomas kodas arba stabdoma).
Kai `pnpm test` žalias, commit'ink tik šio task'o failus ir baik.

## Neįtraukta
`runChild` infra klasifikacija ir slot baigties tipas, `worker-integration` park sprendimas, `wave-outcome` atšaka, `loop-cycle` refill hold/abort — atskiri nuoseklūs task'ai.
