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

## Žingsnis 0 — ar jau įgyvendinta?
Jei `src/composition/ui/sse-adapters.ts` `readGlobalActivity` po `resolved.ok` tikrina, ar tėvo attempt
log'as egzistuoja (kaip `readActiveAttempt` 195-200 eil.), `src/interfaces/http/ui-lifecycle.ts` nebekviečia
`removeStaleRuntimeRecord` ant `ui.pid` (arba rašo JSON runtime įrašą), o `sse-service.ts` `writeToClient`
catch'as be klientų stabdo taimerius — ALREADY_IMPLEMENTED: cituok tris vietas.

## Tikslas
Pilnas auditas 2026-09-05 (`docs/audits/full-audit-2026-09-05.md`, UI P2/P3; `scratchpad/audit-ui.md`
F9, F10, P3): (F9) `sse-adapters.ts:102-103` `if (resolved.ok) return readAgentActivity({ fs }, runtimeRoot)`
— globalus `claude-last.log` veidrodis, o `:195-200` (`readActiveAttempt`) tą pačią būseną (attempt
rezoliuotas, bet tėvo `claudeLog` neegzistuoja = worktree dispatch'as) atpažįsta ir stebi kopijos log'ą;
nesimetrija rodo ankstesnio ne-worktree paleidimo fosiliją, kai `slots[]` tuščias. (F10)
`ui-lifecycle.ts:151` rašo `ui.pid` kaip pliką PID, `:140` skaito jį per `removeStaleRuntimeRecord` kaip
JSON runtime įrašą → visada „unreadable" → trinamas → rašomas iš naujo; niekas kitas neskaito (grep
`ui.pid`: tik `ui-lifecycle.ts` ir `interfaces-http-lifecycle.test.ts:288`); `ui-server.json` jau yra
tikrasis įrašas. (P3) `sse-service.ts:121-128` `writeToClient` catch'as numeta klientą, bet `stopTimers`
kviečiamas tik `drop` kelyje (`:229-232`) — po paskutinio numesto kliento 1,5 s `stat` taimeriai ×4-8
sukasi su 0 klientų iki kito prisijungimo.

## Agentai
readme-guard -> architect -> coder -> reviewer -> security -> tester

## Failai
Leidžiama:
- `src/composition/ui/sse-adapters.ts` (`readGlobalActivity` 97-120 eil.)
- `src/tests/composition-ui-sse-live-updates.test.ts`
- `src/interfaces/http/ui-lifecycle.ts` (`uiPidFile` 53-58, 140, 151 eil.)
- `src/tests/interfaces-http-lifecycle.test.ts` (288 eil. pina `ui.pid` turinį)
- `src/interfaces/http/sse-service.ts` (`writeToClient` 121-128 eil., `stopTimers` 168-173 eil.)
- `src/tests/interfaces-http-sse.test.ts`

Draudžiama:
- `src/interfaces/hooks/loop-runtime-store.ts` (`removeStaleRuntimeRecord` semantika nekinta)
- `src/interfaces/http/loop-lifecycle.ts` (loop'o PID įrašas — kita byla, teisinga)
- `src/composition/ui/command.ts` (task 225) ir `src/composition/ui/server.ts` (task 226)
- `dist/**`
- `node_modules/**`

## Veiksmas
- `readGlobalActivity`: po `resolved.ok` — jei tėvo `attemptLogPath(…, CLAUDE_LOG_CHANNEL)` neegzistuoja,
  eiti `worktreeLiveSources(taskId)` keliu (kopijos log'as arba TUŠČIA veikla), ne globalus veidrodis;
  ta pati rezoliucija, kuri jau yra `readActiveAttempt` — iškelti į vieną vidinę funkciją.
- `ui-lifecycle.ts`: `ui.pid` NEBERAŠOMAS ir `removeStaleRuntimeRecord` nebekviečiamas — `ui-server.json`
  (`writeUiServerRecord`) yra vienintelis UI įrašas; `uiPidFile` šalinamas su komentaru 58 eil.
  (alternatyva — rašyti JSON runtime įrašą — atmesta: du įrašai apie tą patį procesą).
- `sse-service.ts`: `writeToClient` catch'as po `clients.delete` — `if (clients.size === 0) stopTimers()`
  (tas pats `drop` kelias); `clientCount()` lieka.
- Testai: SSE adapteris — rezoliuotas bandymas be tėvo log'o su gyvu worktree lease duoda kopijos turinį,
  be lease — tuščią veiklą (ne `claude-last.log`); lifecycle — `ui.pid` nebekuriamas, startas lieka
  `started`; SSE hub — klientas su metančiu `write` numetamas ir taimeriai (`setInterval` fake) išvalyti.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei `ui.pid` turi skaitytoją už `src/**` ribų
(`templates/**`, `.claude/**`, docs) — grep 2026-09-05 rodo 0, bet tada failas paliekamas ir tik
klaidingas `removeStaleRuntimeRecord` kvietimas šalinamas.

## Neįtraukta
- `readActiveAttempt` ir `readLiveSlotSources` — jau teisingi (task 139), nekeičiami.
- SSE keepalive/poll intervalų kalibravimas — ne šio audito radinys.
- `WavesPanel` ISO žymų formatavimas — task 231; `ReliabilityPage` `fixRate: 1` — task 233 Neįtraukta (P3).
