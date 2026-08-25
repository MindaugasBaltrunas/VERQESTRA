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
openspec/changes/verqestra-backlog-v1

## Tikslas
Įrodyti testu, kad preflight skelbiama `max_turns` sutampa su dispatch vykdoma reikšme tam pačiam tier'ui (0033 kalibracija `large=180` nebeanuliuojama lubų). Produkcinis kodas jau suvielintas — šis darbas tik jį užrakina testu.

## Agentai
PRIVALOMA grandinė, be nukrypimų: readme-guard -> tester -> reviewer.

## Failai
Leidžiama:
- `src/tests/quality-gates-preflight.test.ts`

Draudžiama:
- `src/application/policy-governance/preflight-limits-policy.ts`
- `src/interfaces/cli/dispatch/claude-preflight/index.ts`
- `vq/config/preflight-limits.json`
- `.env`
- `.env.*`
- `node_modules/**`
- `dist/**`

## Veiksmas
- Perskaityk `resolveMaxTurns` (`src/application/token-governance/turn-budget.ts`) ir `publishedMaxTurns` skaičiavimą `claude-preflight/index.ts:259-264`.
- Pridėk testą: tam pačiam `tier="large"`, `phase="implementation"`, tai pačiai `turnLimits` lentelei ir `ceiling = DEFAULT_PREFLIGHT_LIMITS.dispatchMaxTurns` preflight ir dispatch kelias grąžina tą pačią reikšmę (180), o ne `min(180, 120)=120`.
- Nekeisk produkcinio kodo: jei reikšmės nesutampa, sustok ir pranešk.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Sustoti po sėkmingų patikrų ir commit'o. Sustoti nedelsiant, jei testas rodo preflight↔dispatch neatitikimą arba prireiktų liesti produkcinį failą.

## Neįtraukta
- Config drift vartas (`dispatchMaxTurns >= turnLimits.large`) — atskira sekanti užduotis.
- `turnLimits` lentelės reikšmių keitimas.
- Attempt rezoliucijos vielinimas (task 015) ir queue loop vykdymas.
