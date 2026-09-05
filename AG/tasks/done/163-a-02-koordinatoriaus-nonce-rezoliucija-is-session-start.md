# Task
## Spec source
openspec/changes/verqestra-backlog-v1/
## Priklausomybės
Priklauso nuo šio queue task'o pirmos dalies (stop-bridge-wait.ts API paruošimas) — jei ji pridėjo naują parametrą, šis darbas jį naudoja; jei ALREADY_IMPLEMENTED, tęsti be papildomo API.
## Tikslas
`coordinator-execution-adapters.ts` `verifyStopBridgeWaitCliPort` nonce'ą imti ne iš koordinatoriaus proceso `AG_DISPATCH_NONCE` env (jis ten niekad neužrašomas), o rezoliucija ta pačia tvarka kaip `resolveDispatchSessionNonce` (`domain/diagnosis/dispositions.ts`, importuoti, ne kopijuoti): gyvas env → session-start baseline (`sessionStartStatusPath`, galioja tik sutampant `task_id` su `current-task-id` ir ne senesnis už šio attempt'o pradžią) → `""`. Su netuščiu nonce iškviesti `waitForOwnStopBridgeDone` ir `COORDINATOR STOP WAIT RESULT` žurnalo eilutę.
## Agentai
readme-guard -> debugger -> coder -> reviewer -> tester
## Failai
Leidžiama:
- `src/composition/loop/coordinator-execution-adapters.ts`
- `src/tests/composition-cli.test.ts`
Draudžiama:
- `src/infrastructure/adapters/claude-dispatch-process.ts`
- `src/infrastructure/state/stop-bridge.ts`
- `src/interfaces/hooks/session-start.ts`
- `src/domain/diagnosis/dispositions.ts`
- `src/composition/quality/diagnose-adapters.ts`
- `src/composition/loop/coordinator-adapters.ts`
- `src/application/task-execution/stop-bridge-wait.ts`
- `dist/**`
- `node_modules/**`
## Veiksmas
- `verifyStopBridgeWaitCliPort` (348-376) ir `ownStopBridgeProbe` (311-330): pridėti nonce rezoliuciją importuojant `resolveDispatchSessionNonce`, tvarka gyvas env → session-start baseline → `""`.
- `composition-cli.test.ts` 298-344 perrašyti be `process.env` nonce rašymo: (a) be env/baseline — pass-through; (b) baseline su sutampančiu `task_id` ir `dispatch_nonce` → `own-done`; (c) svetimas `task_id` → pass-through; (d) timeout kelias su `AG_DISPATCH_STOP_WAIT_MS=0` išlieka.
## Patikra
- `pnpm build`
- `pnpm test`
## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei paaiškėja, kad worktree vaiko `<worktree>/vq/state` session-start baseline nerašomas arba rašomas tik vienoje platformoje — tada nonce šaltinis turėtų būti dispatch execution record, kas peržengia šio task'o scope.
## Neįtraukta
- Dispatch kelio laukimas (`claude-dispatch-outcome.ts`) — veikia savo procese su gyvu nonce, nekinta.
- Skip-dispatch kelias — dengiamas automatiškai, atskirų testų nerašoma.
