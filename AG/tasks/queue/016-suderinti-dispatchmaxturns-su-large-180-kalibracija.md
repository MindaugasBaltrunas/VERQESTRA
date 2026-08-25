# Task

## Spec source
openspec/changes/verqestra-backlog-v1
AG/openspec/changes/verqestra-backlog-v1/tasks.md

## Tikslas
P1 (2026-08-25 optimizavimo auditas): `dispatchMaxTurns: 120` default'as
(`src/application/policy-governance/preflight-limits-policy.ts:81` ir
`vq/config/preflight-limits.json`) tyliai anuliuoja HUMAN-REVIEW-APPROVED 0033
kalibraciją `large=180` — `resolveMaxTurns` grąžina `min(180, 120) = 120`, t. y.
reikšmę, kuri 0033 audite pripažinta nepakankama. Papildomai preflight log'as
(`claude-preflight/index.ts:245`) skelbia `max_turns=180` be lubų ir be config
`turnLimits` — deklaruojama niekada neįgyvendinama reikšmė. Suderinti lubas su
kalibracija ir padaryti preflight max_turns teisingą.

## Agentai
readme-guard -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `vq/config/preflight-limits.json`
- `src/application/policy-governance/preflight-limits-policy.ts`
- `src/interfaces/cli/dispatch/claude-preflight/index.ts`
- `src/tests/**`

Draudžiama:
- `.env`
- `.env.*`
- `node_modules/**`
- `dist/**`

## Dependencies
depends_on: 015-ivielinti-dispatch-attempt-rezoliucija-preflight-sprendimas

## Veiksmas
- Pakelti `dispatchMaxTurns` iki 180 config'e ir `DEFAULT_PREFLIGHT_LIMITS` — lubos nebeturi kirsti kalibruotos `turnLimits.large=180` lentelės.
- Atnaujinti 77-80 eil. komentarą preflight-limits-policy.ts (dabar cituoja 2026-08-07 būseną, prieštaraujančią 0033).
- Preflight `optimizeTokenBudget` kvietimui (`claude-preflight/index.ts:233`) paduoti config `turnLimits`, kad log/decision max_turns atitiktų dispatch vykdomą reikšmę.
- Testas: `resolveMaxTurns({tier:"large", ceiling: <naujas default>})` = 180; preflight max_turns su config lentele sutampa su dispatch reikšme.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Sustoti, kai patikros praeina ir preflight bei dispatch max_turns tam pačiam tier'ui sutampa.

## Neįtraukta
- Attempt rezoliucijos vielinimas (task 015).
- `turnLimits` lentelės reikšmių keitimas.
- Queue loop vykdymas.
