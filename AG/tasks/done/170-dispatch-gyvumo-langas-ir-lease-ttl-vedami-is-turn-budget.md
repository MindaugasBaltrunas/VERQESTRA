# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Žingsnis 0 — ar jau įgyvendinta?
Jei `src/application/task-execution/session-baseline.ts` `LIVE_DISPATCH_MAX_AGE_MS` NĖRA literalas
`90 * 60 * 1000`, o vedamas iš `src/application/token-governance/turn-budget.ts` eksporto, ir yra
testas, tvirtinantis tvarką „numatytas large dispatch langas ≤ LIVE_DISPATCH_MAX_AGE_MS ≤
WAVE_SLOT_LEASE_TTL_MS" — ALREADY_IMPLEMENTED: cituok išvedimą ir invarianto testą.

## Tikslas
Pilnas auditas 2026-09-05 (`docs/audits/full-audit-2026-09-05.md`, L9): trys nesuderinti laiko
langai. `LIVE_DISPATCH_MAX_AGE_MS = 90 min` (`session-baseline.ts:79`, komentaras 77: „numatytas
dispatch wall-clock langas plius atsarga") < numatytas large dispatch langas 100 min
(`turn-budget.ts:44` `large: 180` × 20 s + `DISPATCH_TIMEOUT_OVERHEAD_MS` 40 min, 87 eil.) —
gyvas large dispatch'as po 90 min laikomas negyvu; konfigas leidžia iki
`MAX_DERIVED_DISPATCH_TIMEOUT_MS` 4 h (`token-budget-config.ts:95`) > `WAVE_SLOT_LEASE_TTL_MS` 3 h
(`loop-runtime-config.ts:13`, komentaras 6: „dengia visą 100 minučių dispatch'ą") → lease baigiasi
vaikui dar dirbant, o `loop-guard`/antras loop startas jį atlaisvina (`reapDeadLeases`). Trys
failai neša tą patį faktą trimis literalais, ir 159 (turn lubų kėlimas) jų nesujudino.

Kryptis (audito santrauka L9): `LIVE_DISPATCH_MAX_AGE_MS` vesti iš `turn-budget`, o lease TTL ir
maksimalų išvestą timeout'ą surišti vienu invariantu su testu — ne trys literalai, o viena tiesa.

## Agentai
readme-guard -> debugger -> coder -> reviewer -> tester

## Failai
> 2026-09-05: accept-scope patvirtinta (žmogaus peržiūra, be requeue)
Leidžiama:
- `src/application/token-governance/turn-budget.ts` (eksportas: didžiausias leidžiamas dispatch langas)
- `src/application/token-governance/token-budget-config.ts` (95: `MAX_DERIVED_DISPATCH_TIMEOUT_MS` ima iš `turn-budget`)
- `src/application/task-execution/session-baseline.ts` (79: išvedimas vietoje literalo)
- `src/application/scheduling/loop-runtime-config.ts` (13: TTL ≥ langas + atsarga; komentaras 6-11)
- `src/tests/interfaces-hooks-loop-runtime.test.ts` (255-274: `dispatchAttemptIsLive` langą pina datomis)
- `src/tests/token-governance-turn-budget.test.ts`
- `src/tests/scheduling-loop-runtime-config.test.ts` (numatomas naujas; invariantas tarp trijų konstantų)

- `src/tests/infrastructure-orphan-reaper.test.ts`
Draudžiama:
- `src/application/scheduling/worker-lease-store.ts` (171 scope)
- `src/interfaces/cli/dispatch/claude-dispatch/dispatch-timeout.ts` (vartotojas, nekinta)
- `templates/**`
- `docs/**`
- `dist/**`
- `node_modules/**`

## Veiksmas
- `turn-budget.ts`: vienas eksportas (pvz. `MAX_DISPATCH_WALL_CLOCK_MS`) — viršutinė riba, kurią
  konfigas gali išvesti; `token-budget-config.ts` `MAX_DERIVED_DISPATCH_TIMEOUT_MS` = tas eksportas
  (reikšmė 4 h lieka, keičiasi šaltinis). `DEFAULT_TURN_LIMITS` reikšmės NEKEIČIAMOS (159 sprendimas).
- `session-baseline.ts`: `LIVE_DISPATCH_MAX_AGE_MS` = riba + atsarga (pvz. +10 min); komentaras
  77 nebemeluoja. Sluoksnis: `task-execution` → `token-governance` yra tas pats application
  sluoksnis — jei `architecture-gates` praneša ciklą, riba keliauja į `shared`, ne atvirkščiai.
- `loop-runtime-config.ts`: `WAVE_SLOT_LEASE_TTL_MS` išvedamas iš tos pačios ribos su atsarga
  (pvz. +1 h), komentaras 6-11 aprašo invariantą, ne skaičių; pid-aware reaper'is
  (`leaseGuardsTask`) TTL naudoja tik kaip fallback'ą, tad ilgesnis TTL negyvų lease'ų nelaiko.
- Testai: naujas invarianto testas — `resolveDispatchTimeoutMs({ tier: "large" })` (numatytasis) ≤
  `LIVE_DISPATCH_MAX_AGE_MS` ≤ `WAVE_SLOT_LEASE_TTL_MS` ir `MAX_DERIVED_DISPATCH_TIMEOUT_MS` <
  `WAVE_SLOT_LEASE_TTL_MS`; `interfaces-hooks-loop-runtime.test.ts` 270/273 datos atnaujinamos pagal
  naują langą (etalono 9 taisyklė — testas pina reikšmę); `token-governance-turn-budget.test.ts`
  naujas eksportas.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei invariantui išlaikyti reikėtų mažinti
`MAX_DERIVED_DISPATCH_TIMEOUT_MS` žemiau esamo `vq/config/token-budget.json` išvesto timeout'o —
tai keičia operatoriaus konfigo galiojimą ir yra jo sprendimas.

## Neįtraukta
- Periodinis lease heartbeat vaiko vykdymo metu (`loop-runtime-config.ts:10-11` „sąmoningai
  nereikalingas") — alternatyva ilgesniam TTL, atskiras sprendimas.
- `worker-lease-store.ts:333` „15 min" komentaras — task 171.
- `docs/**` env kintamųjų (`CLAUDE_*_TIMEOUT_MS`) dokumentacija — dokumentacijos autorius.
