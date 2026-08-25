## Žingsnis 0 — ar jau įgyvendinta?
Prieš keisdamas kodą patikrink, ar ## Tikslas ir ## Patikra jau tenkinami esamame kode.
Jei taip — NEDARYK jokių pakeitimų ir galutinę ataskaitą pradėk atskira eilute:
ALREADY_IMPLEMENTED: <failai/eilutės, įrodančios kad darbas jau padarytas>

## Sandbox taisyklės (privaloma — taupo turns)
- Po BET KOKIO `src` pakeitimo `dist` pasensta ir hook'ai blokuoja bash komandas. Pirma perbuild'ink TIKSLIA forma be pipe/redirect: `pnpm build`
- Patikroms naudok tik: `pnpm build` ir `pnpm test` (be `--`, be pipe į kitas komandas).
- `echo`, `sed`, `node -e` ir kompound komandos su neleistinais segmentais VISADA atmetamos — nekartok jų kitomis formomis; failams skaityti naudok Read/Grep tools.

# Task

## Spec source
openspec/changes/verqestra-backlog-v1/ (tasks.md eilutė: dispatch flow matavimas)

## Tikslas
Pakeisti stub'ą `resolveAttempt` (`src/composition/agent/dispatch-adapters.ts:130-136`) realia attempt rezoliucija, kad preflight paskelbtas `token_budget_tier` ir `selected_model` pasiektų dispatch'ą per attempt namespace, o ne tik per globalų veidrodį. Įrodymas dabar: 17/17 `DISPATCH TURN BUDGET` eilučių `source=structural`.

## Agentai
PRIVALOMA grandinė šia tvarka: readme-guard -> coder -> reviewer -> tester. readme-guard eina pirmas ir grąžina ribų santrauką.

## Failai
Leidžiama:
- `src/composition/agent/dispatch-adapters.ts`
- `src/tests/**`

Draudžiama:
- `src/interfaces/cli/dispatch/claude-dispatch/dispatch-invocation.ts`
- `migration-coverage.json`
- `.env`
- `.env.*`
- `dist/**`
- `node_modules/**`

## Veiksmas
- Įvielinti `resolveAttempt` per `activeAttemptResolution` (`src/infrastructure/state/active-attempt.ts:254`, pavyzdys `src/composition/runtime/node-adapters.ts:199`) ir grąžinti `ResolveAttemptResult` su gyvu attempt view (`readDecision`); kai runtime attempt nepasiekiamas — grąžinti tą patį įvardytą warning'ą, kad globalaus veidrodžio fallback'as liktų nepaliestas.
- Atnaujinti pasenusį JSDoc bloką (100-110 eil.), kuris tvirtina, kad dispatch attempt kanalas neįvielintas.
- Pridėti testą `src/tests/`: preflight paskelbus `tier=large`, `resolveAttempt` grąžina attempt su decision ir `resolveDispatchTurnTier` gauna publishedTier (turn log `source=token-budget`, ne `structural`).

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Sustoti, kai `pnpm build` ir `pnpm test` praeina ir naujas testas įrodo `source=token-budget`. Tada commitinti vienu commit'u ir sustoti. Sustoti nedelsiant, jei taisymas reikalautų keisti `dispatch-ports.ts` public kontraktą arba silpninti esamą testą.

## Neįtraukta
- `dispatch-invocation.ts` valymai (child task).
- `migration-coverage.json` įrašas (child task).
- `dispatchMaxTurns` lubos (task 016) ir biudžeto vartų modelis (task 017).
