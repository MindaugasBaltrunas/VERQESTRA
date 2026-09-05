# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Žingsnis 0 — ar jau įgyvendinta?
Jei `src/composition/loop/coordinator-execution-adapters.ts` `verifyStopBridgeWaitCliPort` nonce ima
NE iš `process.env["AG_DISPATCH_NONCE"]`, o iš attempt/state įrašo (session-start baseline per
`sessionStartStatusPath` arba attempt `stop-state`), ir `src/tests/composition-cli.test.ts` own-done
scenarijus praeina be `process.env` nonce rašymo — ALREADY_IMPLEMENTED: cituok nonce rezoliucijos
eilutes ir testą.

## Tikslas
Pilnas auditas 2026-09-05 (`docs/audits/full-audit-2026-09-05.md`, L1, patikrinta ✓): koordinatoriaus
stop-bridge laukimas (021-d-05 / C4) produkcijoje niekada nesuveikia.
`coordinator-execution-adapters.ts:353` skaito `AG_DISPATCH_NONCE` iš KOORDINATORIAUS proceso env,
o nonce nustatomas tik `claude-dispatch` vaike (`claude-dispatch-process.ts:126-127`) ir jam
pasibaigus ištrinamas (`:181`); koordinatorius dispatch'ą visada paleidžia vaiku
(`coordinator-adapters.ts:395-400`), worktree vaikams nonce dar ir išvalomas
(`slot-task-runner.ts:117`). Todėl `dispatchNonce === ""`, `waitForOwnStopBridgeDone` nekviečiamas,
`verifyTask` (`verify-task.ts:42`) `quality-gates` vykdo iškart po dispatch'o — 018 incidentas („nėra
commit'o", nes Stop hook'as dar nespėjo) liko atviras. Įrodymas: `vq/logs/orchestrator.log` turi 1360
`DISPATCH` eilučių ir 0 `COORDINATOR STOP WAIT RESULT`. Testas `composition-cli.test.ts:309` žalias
tik todėl, kad nonce į `process.env` įrašo ranka.

Kryptis (audito „Ką daryti pirmiausia" 2): nonce koordinatoriui perduoti per attempt/state būseną,
kurią dispatch pusė rašo PRIEŠ Stop, ne per savo env. Šaltiniai jau egzistuoja: SessionStart hook'as
rašo baseline su `dispatch_nonce` + `task_id` (`session-start.ts:115-136`,
`sessionStartStatusPath`), o diagnozės sibling'as tą pačią problemą sprendžia
`resolveDispatchSessionNonce` (`domain/diagnosis/dispositions.ts:59-85`: env → attempt įrašas →
legacy su task_id sutapimu). Atmesta alternatyva — vaikui paveldėti nonce per env: jis gimsta tik
dispatch'o viduje, o koordinatorius yra jo tėvas, ne vaikas.

## Agentai
readme-guard -> debugger -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/composition/loop/coordinator-execution-adapters.ts` (`verifyStopBridgeWaitCliPort` 348-376, `ownStopBridgeProbe` 311-330)
- `src/application/task-execution/stop-bridge-wait.ts` (tik jei attempt kilmės `done` klasifikacijai reikia aiškaus parametro; esami kvietėjai elgiasi kaip anksčiau)
- `src/tests/composition-cli.test.ts` (298-344: scenarijai perrašomi be `process.env` nonce)
- `src/tests/interfaces-cli-dispatch-runtime.test.ts` (tik jei keičiama `stop-bridge-wait.ts`)

Draudžiama:
- `src/infrastructure/adapters/claude-dispatch-process.ts` (nonce env langas vaike nekinta)
- `src/infrastructure/state/stop-bridge.ts`
- `src/interfaces/hooks/session-start.ts` (baseline rašytojas — skaitomas, nekeičiamas)
- `src/domain/diagnosis/dispositions.ts` (`resolveDispatchSessionNonce` importuojamas, nekeičiamas)
- `src/composition/quality/diagnose-adapters.ts`
- `src/composition/loop/coordinator-adapters.ts`
- `dist/**`
- `node_modules/**`

## Veiksmas
- `coordinator-execution-adapters.ts` `verifyStopBridgeWaitCliPort`: nonce rezoliucija ta pačia
  tvarka kaip `resolveDispatchSessionNonce` (importuoti, ne kopijuoti): gyvas env (interaktyvus
  atvejis lieka kaip dabar) → session-start baseline (`sessionStartStatusPath(<runtimeRoot>/state)`;
  galioja tik kai jo `task_id` sutampa su `current-task-id` ir `updated_at` ne senesnis už šio
  attempt'o pradžią — pasenęs ankstesnio dispatch'o baseline'as NĖRA mūsų nonce) → `""`. Su
  netuščiu nonce laukimas ir `COORDINATOR STOP WAIT RESULT` eilutė vyksta kaip parašyta 358-370.
- Attempt kilmės `stop-state` `done` traktuoti kaip own-done pagal konstrukciją (manifesto įrodyta
  tapatybė, `dispositions.ts:64-65`) — jei tam reikia `mergeStopBridgeSources` parametro,
  praplėsti `stop-bridge-wait.ts` SUDERINAMAI (numatytasis elgesys nepakitęs dispatch kelyje).
- `composition-cli.test.ts`: (a) be env, be baseline — pass-through, jokio laukimo žurnalo;
  (b) be env, baseline su `task_id=0042` ir `dispatch_nonce=nonce-1`, globalus stop failas su tuo
  pačiu nonce → `result=own-done`; (c) baseline su svetimu `task_id` → pass-through;
  (d) timeout kelias su `AG_DISPATCH_STOP_WAIT_MS=0` lieka.
- Priėmimo kriterijus po merge (į ataskaitą): pirmas realus loop'o task'as palieka
  `COORDINATOR STOP WAIT RESULT` eilutę `orchestrator.log` — tai audito patikros kriterijus.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei paaiškėja, kad session-start baseline'as
worktree vaiko runtime'e (`<worktree>/vq/state`) nerašomas arba rašomas tik vienoje platformoje —
tada nonce šaltinis turi būti dispatch execution record'as, o tai liečia `dispatch-execution-record.ts`
už šio scope ribų.

## Neįtraukta
- Dispatch kelio laukimas (`claude-dispatch-outcome.ts:116`) — veikia savo procese su gyvu nonce,
  nekinta.
- Skip-dispatch (`skip-dispatch.ts`) kelias — tas pats CLI portas, dengiamas automatiškai; atskirų
  testų nerašoma.
- Diagnozės sibling'o nonce atgavimas (0049) — jau veikia, tik perpanaudojamas.
