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
Užrakinti testu, kad `vq/config/preflight-limits.json` ir `DEFAULT_PREFLIGHT_LIMITS` `dispatchMaxTurns` niekada nenukrenta žemiau kalibruotos `turnLimits.large` reikšmės — būtent tylus 120 lubų atvejis anuliavo 0033 kalibraciją.

## Agentai
PRIVALOMA grandinė, be nukrypimų: readme-guard -> tester -> reviewer.

## Failai
Leidžiama:
- `src/tests/quality-gates-preflight.test.ts`

Draudžiama:
- `vq/config/preflight-limits.json`
- `src/application/policy-governance/preflight-limits-policy.ts`
- `.env`
- `.env.*`
- `node_modules/**`
- `dist/**`

## Veiksmas
- Įkelk realų `vq/config/preflight-limits.json` per `loadPreflightLimits` ir patikrink, kad `dispatchMaxTurns >= turnLimits.large`.
- Tą pačią invariantą patikrink ir `DEFAULT_PREFLIGHT_LIMITS` su `DEFAULT_TURN_LIMITS`.
- Testo žinutėje nurodyk priežastį (0033 kalibracija, HUMAN-REVIEW-APPROVED), kad ateities operatorius matytų, kodėl vartas krenta.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Sustoti po sėkmingų patikrų ir commit'o. Sustoti nedelsiant, jei vartas krenta ant esamo config'o — tai realus radinys, ne testo problema.

## Neįtraukta
- `turnLimits` lentelės reikšmių keitimas.
- Produkcinio kodo ar config failo redagavimas.
- Attempt rezoliucijos vielinimas (task 015) ir queue loop vykdymas.
