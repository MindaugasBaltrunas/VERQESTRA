## Žingsnis 0 — ar jau įgyvendinta?
Prieš keisdamas kodą patikrink, ar ## Tikslas ir ## Patikra jau tenkinami esamame kode.
Jei taip — NEDARYK jokių pakeitimų ir galutinę ataskaitą pradėk atskira eilute:
ALREADY_IMPLEMENTED: <failai/eilutės, įrodančios kad darbas jau padarytas>

## Sandbox taisyklės (privaloma — taupo turns)
- Po BET KOKIO `src` pakeitimo `dist` pasensta ir hook'ai blokuoja bash komandas. Pirma perbuild'ink TIKSLIA forma be pipe/redirect: `pnpm build`
- Patikroms naudok tik: `pnpm build` ir `pnpm test` (be `--`, be pipe į kitas komandas).
- `echo`, `sed`, `node -e` ir kompound komandos su neleistinais segmentais VISADA atmetamos — nekartok jų kitomis formomis; failams skaityti naudok Read/Grep tools.
- Rašymo darbą atlik PATS šioje sesijoje (Write/Edit) ir neatidėk jo vėlesniam laikui: headless sesija po paskutinio tavo žingsnio baigiasi, o bėgimas be nė vieno Write/Edit parkuojamas human-review. `## Agentai` grandinė yra orkestratoriaus maršruto metaduomuo — jei subagentas negrąžina rezultato šiame bėgime, įgyvendink pakeitimą tiesiogiai.

# Task

## Spec source
openspec/changes/verqestra-backlog-v1

## Žingsnis 0 — ar jau įgyvendinta?
Jei `ResolveAttemptResult` (`src/interfaces/cli/dispatch/claude-dispatch/dispatch-ports.ts:101`)
jau turi nebūtiną `claudeLogPath` lauką IR `dispatch-invocation.ts` jį perduoda toliau taip, kad
`prepareDispatchArtifacts` gautų `attemptClaudeLog` net be `active` view — ALREADY_IMPLEMENTED:
cituok tipo deklaraciją ir perdavimo eilutę.

## Tikslas
Atidaryti interfaces pusėje kanalą, kuriuo attempt-scoped `claude-last` kelias pasiekia
`launchProcess` `logChannels.attemptPath`, kai kompozicija dar negrąžina pilno
`DispatchAttemptView`. Šiuo žingsniu elgesys NEsikeičia (laukas visur nebūtinas ir tuščias) —
keliamas tik kontraktas, kurį užpildys kitas task'as.

## Agentai
readme-guard -> debugger -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/interfaces/cli/dispatch/claude-dispatch/dispatch-ports.ts`
- `src/interfaces/cli/dispatch/claude-dispatch/dispatch-invocation.ts`
- `src/interfaces/cli/dispatch/claude-dispatch/dispatch-artifacts.ts`
- `src/interfaces/cli/dispatch/claude-dispatch/command.ts`
- `src/tests/interfaces-cli-dispatch-command.test.ts`
- `src/tests/interfaces-cli-dispatch-plan.test.ts`

Draudžiama:
- `src/composition/agent/dispatch-adapters.ts`
- `src/infrastructure/adapters/claude-last-log.ts`
- `src/application/task-execution/verify-task.ts`
- `dist/**`
- `node_modules/**`

## Veiksmas
- `dispatch-ports.ts`: praplėsk `ResolveAttemptResult` nebūtinu `claudeLogPath?: string`
  (attempt kanalo `claude-last` kelias, kai pilno attempt view nėra); kitų portų nekeisk.
- `dispatch-invocation.ts`: perduok `resolved.claudeLogPath` toliau į invocation rezultatą ir
  `command.ts` → `prepareDispatchArtifacts`, kad `attemptClaudeLog` būtų
  `active?.claudeLogPath ?? resolved.claudeLogPath` (`exactOptionalPropertyTypes` — per sąlyginį
  spread'ą, kaip gretimose eilutėse).
- Testai: `interfaces-cli-dispatch-command.test.ts` tvirtina, kad `resolveAttempt`, grąžinęs vien
  `claudeLogPath` be `attempt`, pasiekia `launchProcess` `logChannels.attemptPath`; be lauko —
  `attemptPath` lieka `undefined` (regresijos apsauga).

## Patikra
- `pnpm typecheck`
- `pnpm test:file dist/tests/interfaces-cli-dispatch-command.test.js`
- `pnpm test`

## Stop
Sustok ir klausk, jei: reikėtų keisti `claude-last-log.ts` rašytoją, `verify-task.ts` verdiktų
logiką ar `coordinator-adapters.ts` skaitymo fallback'ą; jei `attemptClaudeLog` pratekinimui
prireiktų liesti kompozicijos failą. Commit'ink tik kai `pnpm typecheck` ir `pnpm test` žali.

## Neįtraukta
Kompozicijos `resolveAttempt` stub'o pakeitimas (kitas task'as), legacy fallback regresijos
testas ir `migration-coverage.json` anotacija (trečias task'as), kiti attempt kanalai
(decision, promote*, execution-result) — jų vielinimas lieka atviras migration-coverage darbas.
