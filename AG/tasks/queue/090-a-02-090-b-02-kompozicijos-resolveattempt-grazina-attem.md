# Task

## Spec source
openspec/changes/verqestra-backlog-v1

## Žingsnis 0 — ar jau įgyvendinta?
Jei `resolveAttempt` (`src/composition/agent/dispatch-adapters.ts:130`) nebegrąžina besąlygiško
`reason=no-runtime` stub'o, o per `input.resolution.resolveActiveAttempt(taskId)` išsprendžia
attempt'ą ir grąžina `claudeLogPath` — ALREADY_IMPLEMENTED: cituok `resolveAttempt` kūną ir
testo pavadinimą.

## Tikslas
Priklauso nuo 090-a-01 (`ResolveAttemptResult.claudeLogPath` laukas) — vykdyti tik jam užsidarius.
Užpildyti tą lauką: dispatch procesas turi rašyti sesijos žurnalą į attempt katalogą
`.../attempts/<a>/logs/claude-last.log`, kad `readClaudeSessionLog` grąžintų `origin="attempt"`,
o ne pralaimėtų lenktynes globaliam veidrodžiui, kurį perrašo lygiagretus worker'is.

## Agentai
readme-guard -> debugger -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/composition/agent/dispatch-adapters.ts`
- `src/tests/composition-dispatch-attempt-channel.test.ts` (numatomas naujas)

Draudžiama:
- `src/interfaces/cli/dispatch/claude-dispatch/dispatch-ports.ts`
- `src/interfaces/cli/dispatch/claude-dispatch/dispatch-invocation.ts`
- `src/composition/quality/diagnose-adapters.ts`
- `src/composition/loop/coordinator-adapters.ts`
- `dist/**`
- `node_modules/**`

## Veiksmas
- `resolveAttempt`: per `input.resolution.resolveActiveAttempt(taskId)` gauk attempt ref ir
  `attemptLogPath(input.runtimeRoot, ref, "claude-last")`; sėkmės atveju grąžink
  `{ claudeLogPath, warnings: [] }`. `attempt` view LIEKA `undefined` — kiti kanalai
  (decision, promote*, execution-result) elgesio nekeičia.
- Fail-open: rezoliucijai ar kelio skaičiavimui nepavykus grąžink dabartinę warning eilutę
  (`reason=...`, „artifacts fall back to global mirrors") ir NEnutrauk dispatch'o.
- Testas `composition-dispatch-attempt-channel.test.ts`: (1) su fake `resolution`, grąžinančiu
  ok attempt — `claudeLogPath` rodo į attempt `logs/claude-last.log`; (2) su nesėkminga
  rezoliucija — `claudeLogPath` nėra ir warning'as išlieka.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Sustok ir klausk, jei pilnam kelio išsprendimui prireiktų keisti `dispatch-ports.ts` kontraktą,
skaitymo pusę (`diagnose-adapters.ts`, `coordinator-adapters.ts`) arba `claude-last-log.ts`
rašytoją. Commit'ink tik kai `pnpm typecheck` ir `pnpm test` žali.

## Neįtraukta
Legacy fallback regresijos testas ir `migration-coverage.json` anotacija (kitas task'as); likę
attempt kanalai — decision, promote-execution-context, promote-context-pack, execution-result.
