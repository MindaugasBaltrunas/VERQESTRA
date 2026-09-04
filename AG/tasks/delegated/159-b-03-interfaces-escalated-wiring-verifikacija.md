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
