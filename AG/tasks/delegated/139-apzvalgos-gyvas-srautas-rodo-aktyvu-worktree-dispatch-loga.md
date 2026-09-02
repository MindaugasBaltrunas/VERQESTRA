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
