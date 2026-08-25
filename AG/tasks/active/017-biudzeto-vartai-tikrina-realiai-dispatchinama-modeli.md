# Task

## Spec source
openspec/changes/verqestra-backlog-v1
AG/openspec/changes/verqestra-backlog-v1/tasks.md

## Tikslas
P1 (2026-08-25 optimizavimo auditas): biudžeto vartai
(`src/application/task-execution/dispatch-task.ts:192-201`) `enforceBudget` kviečia su
`decision.selected_model ?? "sonnet"` (preflight pasirinkimas), o realų modelį parenka
nepriklausomas `routeModel` kelias `claude-dispatch` viduje (`command.ts` naudoja
`claudeModel`). `modelAllowed` verdiktas taikomas modeliui, kuris nebus paleistas
(012 atvejis: gate tikrino opus, dirbo sonnet) — gali ir klaidingai blokuoti, ir
klaidingai praleisti. Vartai turi vertinti routing'o rezultatą: `routeModel` yra
grynas ir deterministinis, tad sprendimą galima suskaičiuoti prieš vartus su tais
pačiais įėjimais, išlaikant „vetuota prieš paleidimą" kontraktą.

## Agentai
readme-guard -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/application/task-execution/dispatch-task.ts`
- `src/application/task-execution/run-coordinator-ports.ts`
- `src/composition/loop/coordinator-adapters.ts`
- `src/composition/loop/coordinator-execution-adapters.ts`
- `src/tests/**`

Draudžiama:
- `.env`
- `.env.*`
- `node_modules/**`
- `dist/**`

## Dependencies
depends_on: 015-ivielinti-dispatch-attempt-rezoliucija-preflight-sprendimas

## Veiksmas
- Prieš `enforceBudget` suskaičiuoti routing sprendimą tais pačiais įėjimais kaip dispatch (`routeModel` + provider atvaizdavimas per portą) ir vartams paduoti realiai dispatch'inamą modelį.
- Jei pilnas routing prieš vartus per brangus, alternatyva: vartų `modelAllowed` patikrą kartoti dispatch viduje po `resolveDispatchRoutingPlan` — pasirinkimą pagrįsti ataskaitoje.
- Testas: kai `modelAllowed` draudžia routing parinktą modelį (nors decision skelbia kitą), kvietimas blokuojamas; ir atvirkščiai — leidžiamas routing modelis nepraleidžia draudžiamo decision modelio pro vartus.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Sustoti, kai patikros praeina ir vartų tikrinamas modelis sutampa su dispatch'inamu.

## Neįtraukta
- Routing taisyklių (`routeModel`) keitimas.
- Attempt rezoliucijos vielinimas (task 015).
- Queue loop vykdymas.
