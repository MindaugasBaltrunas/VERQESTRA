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
