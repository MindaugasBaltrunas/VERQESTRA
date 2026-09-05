# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Žingsnis 0 — ar jau įgyvendinta?
Jei `src/shared/owned-lock.ts` `stealStaleOwnedLock` `isForeign` (327-328 eil.) grąžina `true`, kai
`stolen !== undefined` ir `observed === undefined` (t. y. `observed !== undefined &&` sąlygos nebėra),
arba `src/shared/lock-steal.ts` `stealStaleLock` pats atsisako `remove`, kai perimta tapatybė yra,
o stebėtos nebuvo — ir `src/tests/shared-owned-lock.test.ts` tai pina — ALREADY_IMPLEMENTED: cituok
sąlygą ir testą.

## Tikslas
Pilnas auditas 2026-09-05 (`docs/audits/full-audit-2026-09-05.md`, D6, PLAUSIBLE — pradėti nuo
įrodančio testo). `lock-steal.ts:80` `if (options.isForeign(observed, stolen) && !exists(lockPath))`
grąžina perimtą lock'ą tik kai `isForeign` — `true`; `owned-lock.ts:327-328` `isForeign` =
`observed !== undefined && stolen !== undefined && stolen.lock_id !== observed.lock_id`. Kai
`observed === undefined` (owner.json dar neįrašytas arba neįskaitomas, o `isStale` per mtime → true),
tarp `readIdentity` ir `rename` B perima, C sukuria naują katalogą su savo `lock_id`; A `rename`
paima C katalogą → `stolen` = C, `observed` = undefined → `isForeign` false → `remove(stealPath)` —
C lock'as dingsta, D įeina kartu su C. Antraštė (315-318 eil.) žada „perėmus SVETIMĄ tapatybę lock'as
grąžinamas, o ne sunaikinamas". Testo fake'as (`interfaces-hooks-ledger-lock.test.ts:168`) naudoja
GRIEŽTESNĘ taisyklę `Boolean(stolen) && stolen !== observed` nei produkcija — todėl žalias.
Kryptis: nuosavybė nepatvirtinta = svetima. Jei `stolen` turi tapatybę, o `observed` ne — grąžinti;
jei abi neapibrėžtos (katalogas be owner.json abu kartus) — naikinti kaip dabar (tai ir yra pakibęs
lock'as). Sprendimas fiksuojamas ir `lock-steal.ts` kontrakto doc'e, kad kiti `isForeign` adapteriai
nekartotų klaidos.

## Agentai
readme-guard -> debugger -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/shared/lock-steal.ts` (`stealStaleLock` 79-90 eil.; `isForeign` kontrakto doc)
- `src/shared/owned-lock.ts` (`stealStaleOwnedLock` 320-333 eil.)
- `src/tests/shared-owned-lock.test.ts`
- `src/tests/interfaces-hooks-ledger-lock.test.ts` (fake'o `isForeign` 168 eil. suderinamas su produkcijos taisykle)

Draudžiama:
- `src/infrastructure/**` (lock'o IO adapteriai nekinta — taisoma taisyklė, ne IO)
- `dist/**`
- `node_modules/**`

## Veiksmas
- Pirma — įrodantis testas `shared-owned-lock.test.ts`: scenarijus A stebi katalogą be owner.json
  (`readOwner` → undefined, mtime pasenęs), tarp `readIdentity` ir `rename` fake IO pakeičia katalogą
  nauju savininku su `lock_id: "C"`; po `stealStaleOwnedLock` C lock'as privalo EGZISTUOTI
  `lockDir` kelyje. Jei testas žalias su dabartiniu kodu — ALREADY_IMPLEMENTED su testu kaip įrodymu.
- Jei raudonas: `owned-lock.ts` `isForeign` → `stolen !== undefined && (observed === undefined ||
  stolen.lock_id !== observed.lock_id)`; `lock-steal.ts` doc prie `isForeign` įrašyti kontraktą
  „nepatvirtinta nuosavybė = svetima", kad adapteriai jį laikytų.
- `interfaces-hooks-ledger-lock.test.ts:168` fake'ą suderinti su produkcijos taisykle (arba importuoti
  ją), kad testas nebebūtų griežtesnis už kodą.
- Regresija: abu `undefined` → `remove` (pakibęs katalogas be savininko išvalomas); `observed` ir
  `stolen` su tuo pačiu `lock_id` → `remove`; skirtingi id → grąžinama (esami testai).

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei „abu undefined → naikinti" atvejis prieštarauja
kuriam nors esamam `shared-owned-lock.test.ts` streso testui (12 procesų) — tada reikia operatoriaus
sprendimo tarp stringančių lock'ų ir retos kolizijos.

## Neįtraukta
- Heartbeat/fencing logika `owned-lock.ts` (auditas: švaru) — nekeičiama.
- Infrastruktūros ledger lock adapteris ir `task-state-store.ts:162` `absent → release` (infra P2) —
  kitas autorius.
