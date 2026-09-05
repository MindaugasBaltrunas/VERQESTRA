# Task
## Spec source
openspec/changes/verqestra-backlog-v1/
## Tikslas
Paruošti `stop-bridge-wait.ts` API taip, kad koordinatorius vėliau galėtų traktuoti attempt kilmės `stop-state` `done` kaip own-done pagal manifesto tapatybę (žr. `dispositions.ts:64-65`), nekeičiant esamo dispatch kelio elgesio. Pirma patikrinti, ar esamas API jau pakankamas — jei taip, nekeisti kodo ir aprašyti ataskaitoje kaip ALREADY_IMPLEMENTED su citata.
## Agentai
readme-guard -> debugger -> coder -> reviewer -> tester
## Failai
Leidžiama:
- `src/application/task-execution/stop-bridge-wait.ts`
- `src/tests/interfaces-cli-dispatch-runtime.test.ts`
Draudžiama:
- `src/composition/loop/coordinator-execution-adapters.ts`
- `src/composition/loop/coordinator-adapters.ts`
- `src/infrastructure/adapters/claude-dispatch-process.ts`
- `src/infrastructure/state/stop-bridge.ts`
- `src/domain/diagnosis/dispositions.ts`
- `dist/**`
- `node_modules/**`
## Veiksmas
- Perskaityti `stop-bridge-wait.ts` esamą API ir nustatyti, ar reikia naujo suderinamo parametro attempt kilmės `done` klasifikacijai (numatytasis elgesys nekinta).
- Jei reikia, pridėti parametrą SUDERINAMAI ir atnaujinti `interfaces-cli-dispatch-runtime.test.ts` naujam atvejui.
- Jei nereikia, aprašyti ataskaitoje kodėl (ALREADY_IMPLEMENTED) ir nekeisti kodo.
## Patikra
- `pnpm build`
- `pnpm test`
## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei reikalingas pakeitimas peržengtų `stop-bridge-wait.ts` ribas arba keistų dispatch kelio elgesį.
## Neįtraukta
- Nonce rezoliucijos logika `coordinator-execution-adapters.ts` — atskiras vėlesnis task'as.
- `composition-cli.test.ts` scenarijų perrašymas — atskiras vėlesnis task'as.
