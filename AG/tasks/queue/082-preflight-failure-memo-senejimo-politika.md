# Task

HUMAN-REVIEW-APPROVED: mindebaltru 2026-08-29 GeoGravity audito radinys — 8 memo stovi nuo 08-27, task'ai cikliškai laikomi „jau kritusiais"

## Spec source
openspec/changes/verqestra-backlog-v1

## Žingsnis 0 — ar jau įgyvendinta?
Jei preflight-failure-memo įrašai turi senėjimo/invalidacijos politiką
(galiojimas baigiasi pasikeitus task failo hash'ui ARBA po nustatyto
amžiaus / HEAD pasislinkimo) ir pasenęs memo nebeblokuoja task'o —
ALREADY_IMPLEMENTED su eilučių įrodymu.

## Tikslas
GeoGravity 2026-08-29 auditas: `vq/state/preflight-failure-memo` laiko 8
įrašus nuo 2026-08-27. Memo neturi jokio senėjimo — kartą kritęs
preflight'as task'ą žymi „jau kritusiu" amžinai, net kai priežastis
seniai pašalinta (task failas pataisytas, aplinka pasikeitė, HEAD
pajudėjo šimtus commit'ų). Pasekmė: task'ai cikliškai atmetami
preflight-retry-guard keliu (`preflight_retry_without_change=1 repeat=N`,
pvz. GeoGravity 1185 2026-08-28 10:57 — nors tikroji pirmojo kritimo
priežastis buvo dar 08-27 aplinkos era), o jų worktree kopijos gaminamos
po 3–4 kartus.

Taisymas:
1. Memo įrašas gauna galiojimo ribas: (a) invaliduojamas, kai task failo
   turinio hash'as nebesutampa su memo užfiksuotu (jau yra hash lauke —
   naudoti jį fail-open kryptimi), IR (b) amžiaus riba (pvz. 24 h) arba
   bazinio HEAD pasislinkimas — po jos memo laikomas pasenusiu ir
   trinamas su log eilute `PREFLIGHT MEMO EXPIRED: task=<id> age=<h>`.
2. Pasenusio memo trynimas vyksta skaitymo vietoje (lazy) — atskiro GC
   praėjimo nereikia.
3. `preflight_retry_without_change` logika lieka — ji tik nebesiremia
   pasenusiais įrašais.

## Agentai
readme-guard -> architect -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/application/` (preflight failure memo skaitymas/rašymas — konkretų
  failą įrašyti į ataskaitą)
- `src/infrastructure/` (memo store adapteris, jei atskiras)
- `src/tests/`

Draudžiama:
- `dist/**`
- `node_modules/**`
- `ui-app/**`

## Patikra
- `pnpm typecheck`
- `pnpm lint`
- `pnpm test:only`

## Stop
Commit'ink, kai patikros žalios.

## Neįtraukta
Retry limitų keitimas. Worktree kopijų valymas (079). Memo turinio
praturtinimas diagnostika (080 scope).
