# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Priklausomybės
159 (main claude_task) — turn-budget.ts/token-budget-optimizer.ts eskalacijos šaka turi būti patvirtinta pirma.

## Tikslas
Patikrinti, ar `dispatch-budget-plan.ts` `DispatchBudgetPlanInput.escalated` laukas jau perduodamas į `resolveDispatchTurnTier`, o `command.ts` (255-267 eil.) jau skaičiuoja `escalated: routing.tier !== routing.base_tier`. Jei taip — NEDARYTI pakeitimų, ataskaitą pradėti `ALREADY_IMPLEMENTED:` eilute cituojant konkrečias eilutes.

## Agentai
readme-guard -> architect -> schedule-domain -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/interfaces/cli/dispatch/claude-dispatch/dispatch-budget-plan.ts`
- `src/interfaces/cli/dispatch/claude-dispatch/command.ts`
- `src/tests/interfaces-cli-dispatch-plan.test.ts` (dengia dispatch-budget-plan.ts escalated lauko kelią į resolveDispatchTurnTier)
- `src/tests/interfaces-cli-dispatch-command.test.ts` (dengia command.ts, importuoja claudeDispatch)

Draudžiama:
- `src/interfaces/cli/dispatch/claude-dispatch/dispatch-routing-plan.ts`
- `src/application/**`
- `templates/**`
- `dist/**`

## Veiksmas
- Perskaityti `dispatch-budget-plan.ts` DispatchBudgetPlanInput.escalated lauką ir jo perdavimą į resolveDispatchTurnTier.
- Perskaityti `command.ts` 255-267 eil. ir patvirtinti escalated: routing.tier !== routing.base_tier.
- Jei abu wiring'ai atitinka tikslą, ataskaitą pradėti `ALREADY_IMPLEMENTED:`.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Jei wiring neatitinka (escalated laukas neperduodamas arba palyginimas kitoks), sustok ir eskaluok.

## Neįtraukta
- Preflight LLM modelis — task 160.
