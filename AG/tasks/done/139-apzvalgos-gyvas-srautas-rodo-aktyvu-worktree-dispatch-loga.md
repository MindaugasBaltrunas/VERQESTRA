# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Tikslas
Skaitytojas nustoja tyliai grąžinti seno veidrodžio turinį kaip gyvą veiklą. Šiandien `readAgentActivity` be `sources.logPath` krenta į `<runtimeRoot>/logs/claude-last.log` (`src/interfaces/ui-model/agent-activity-reader.ts:45`) — worktree dispatch'o metu tai 8 valandų fosilija iš paskutinio ne-worktree paleidimo. Reikia aiškios „gyvo konteksto" semantikos: kai kviečiantysis sako, kad vykdymas gyvas, veiklos turinys imamas TIK iš aiškiai perduoto gyvo šaltinio, o jo nesant grąžinama TUŠČIA veikla. Šis žingsnis šakai neutralus — tinka ir TEE į tėvo attempt, ir sekimui per lease. Priklausomybė: 138 (`## Agentai` parseris) jau uždarytas, tas pats testo failas.

## Agentai
Privaloma grandinė: readme-guard -> architect -> coder -> reviewer -> tester.

## Failai
Leidžiama:
- `src/interfaces/ui-model/agent-activity-reader.ts`
- `src/tests/interfaces-ui-model-agent-activity.test.ts`

Draudžiama:
- `src/interfaces/ui-model/agent-activity.ts`
- `src/composition/ui/sse-adapters.ts`
- `src/composition/ui/dashboard-adapters.ts`
- `src/infrastructure/adapters/claude-last-log.ts`
- `ui-app/**`
- `dist/**`
- `node_modules/**`

## Veiksmas
- Įvesk į `AgentActivitySources` aiškų gyvo konteksto žymėjimą (pvz. `liveExecution: true`), kuris išjungia numatytąjį kritimą į `<runtimeRoot>/logs/claude-last.log`.
- Gyvame kontekste be `logPath` (arba kai to failo nebėra — worktree išvalytas) grąžink tuščią veiklą per esamą `buildAgentActivity` kelią, be klaidos ir be veidrodžio turinio.
- Pridėk testus: (1) gyvas kontekstas + `logPath` → turinys iš jo; (2) gyvas kontekstas be šaltinio → tuščia, veidrodis NEskaitomas; (3) ne gyvas kontekstas → esamas elgesys žalias; (4) šaltinis dingsta skaitymo metu → tuščia, ne crash.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai abi patikros žalios. Stop ir klausk, jei sąžiningam pateikimui prireiktų keisti `agent-activity.ts` projekcijos logiką arba naujų UI tekstų `ui-app/**`.

## Neįtraukta
- SSE šaltinio rezoliucija per gyvą lease su `worktree_path` — kitas darbas.
- Dashboard stamp'o šaltinis — trečias darbas.
- Gyvas TEE į tėvo attempt kelią (`claude-last-log.ts`, `dispatch-adapters.ts`) — atskiras task'as.
- Veidrodžio rašymo pusė (`claude-launcher.ts`) — nekeičiama.
