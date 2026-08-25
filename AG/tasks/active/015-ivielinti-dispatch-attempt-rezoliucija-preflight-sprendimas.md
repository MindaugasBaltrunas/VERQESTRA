# Task

## Spec source
openspec/changes/verqestra-backlog-v1
AG/openspec/changes/verqestra-backlog-v1/tasks.md

## Tikslas
P0 (2026-08-25 optimizavimo auditas): preflight paskelbtas `token_budget_tier` ir
`selected_model` niekada nepasiekia dispatch'o, nes `resolveAttempt` yra stub'as
(`src/composition/agent/dispatch-adapters.ts:124-130`), o `dispatch-invocation.ts`
sprendimą skaito TIK iš attempt namespace. Įrodymas: 17/17 `DISPATCH TURN BUDGET`
eilučių `source=structural`; task 012 preflight skelbė `tier=large model=opus
max_turns=180`, dispatch davė `tier=small max_turns=20` su sonnet. Įvielinti realią
attempt rezoliuciją (arba globalaus supervisor sprendimo veidrodžio `decision.json`
fallback'ą su `task_id` nuosavybės patikra kaip `coordinator-adapters.ts:243`), kad
dispatch turn langas ir modelis remtųsi preflight sprendimu (task 0941 kontraktas).

## Agentai
readme-guard -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/composition/agent/dispatch-adapters.ts`
- `src/interfaces/cli/dispatch/claude-dispatch/dispatch-invocation.ts`
- `src/interfaces/cli/dispatch/claude-dispatch/dispatch-ports.ts`
- `src/tests/**`
- `migration-coverage.json`

Draudžiama:
- `.env`
- `.env.*`
- `node_modules/**`
- `dist/**`

## Dependencies
depends_on: none

## Veiksmas
- Pakeisti stub `resolveAttempt` realia rezoliucija per `activeAttemptResolution` (`src/infrastructure/state/active-attempt.ts`) su attempt `decision` skaitymu; jei attempt nepasiekiamas — fallback į globalų supervisor sprendimo veidrodį su task_id nuosavybės patikra.
- Išvalyti negyvą šaką `dispatch-invocation.ts:48` (`decision.task_id?.trim()` skaitomas prieš decision užpildymą).
- `dispatch-invocation.ts:86`: kai decision tuščias, log'o `selected=` rašyti `none` vietoje klaidinančio hardcoded `sonnet`.
- Atnaujinti pasenusį komentarą dispatch-adapters.ts (101-104 eil., „loop dar nemigruotas").
- Testas: preflight paskelbus tier=large, `resolveDispatchTurnTier` gauna publishedTier ir turn log'e `source=token-budget`.
- Pažymėti suvienodinimą `migration-coverage.json` įraše.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Sustoti, kai patikros praeina ir dispatch decision kanalas padengtas testu.

## Neįtraukta
- `dispatchMaxTurns` lubų keitimas (atskiras task 016).
- Biudžeto vartų modelio pataisymas (atskiras task 017).
- Queue loop vykdymas.
