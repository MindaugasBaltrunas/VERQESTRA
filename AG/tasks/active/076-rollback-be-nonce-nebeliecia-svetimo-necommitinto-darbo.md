# Task

HUMAN-REVIEW-APPROVED: mindebaltru 2026-08-29 operatoriaus užsakytas w1/w2 auditas — rollback saugumo skylė be dispatch nonce (P1)

## Spec source
openspec/changes/verqestra-backlog-v1

## Priklausomybės
- 078-worktree-bootstrap-buildstamp-ir-pnpm-path-spragos
- 079-orphan-valymas-iveikia-untracked-failus-ir-fs-liekanas
- 080-vaiko-exit-visada-palieka-diagnoze-ir-stderr

## Žingsnis 0 — ar jau įgyvendinta?
Jei `taskScopeRestorePaths` be sesijos nonce NEgrąžina svetimų sesijų kelių
į atstatymo aibę (arba juos grąžina atskirtus ir kvietėjas jų neliečia be
aiškaus `--include-foreign` tipo sprendimo) — ALREADY_IMPLEMENTED su
eilučių įrodymu.

## Tikslas
Audito P1 radinys (2026-08-29): kai `AG_DISPATCH_NONCE` tuščias
(interaktyvi sesija, rankinis `rollback-stable --allow-task-changes`),
`src/application/task-execution/session-write-owners.ts:97-99`:

```ts
if (!session) {
  return { paths: [...paths], foreign: [] };
}
```

— į atstatymo aibę patenka VISAS bendras `session-writes.json`, įskaitant
kito task'o kelius. Commit'intas svetimas darbas saugus
(`committedTaskWorkSince` vartas, patvirtinta audito), bet svetimas
NECOMMIT'INTAS darbas revertinamas: nufotografuojamas į preserved ref'ą,
tačiau iš medžio dingsta be įspėjimo apie svetimumą. GeoGravity, kur w1 ir
w2 rašo lygiagrečiai, tai realus lygiagretaus darbo praradimo kelias.

Taisymas: be nonce svetimų sesijų keliai atskiriami kaip `foreign` (ta
pati semantika kaip su nonce — savininkystė nustatoma iš rašymo įrašų
sidecar'o, ne iš kvietėjo tapatybės); kvietėjas (`rollback-stable`)
foreign kelius praleidžia ir išvardija ataskaitoje. Jei savininkystės
nustatyti neįmanoma (senas ledger'is be sidecar'o) — fail-closed: kelias
NEliečiamas ir raportuojamas, ne tyliai revertinamas.

## Agentai
readme-guard -> architect -> schedule-domain -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/application/task-execution/session-write-owners.ts`
- `src/interfaces/cli/bootstrap/rollback-stable.ts`
- `src/tests/task-execution-session-write-owners.test.ts` (numatomas; jei
  testas gyvena kitur — tas failas vietoje šio, įrašyti į ataskaitą)
- `src/tests/interfaces-cli-rollback-stable.test.ts`

Draudžiama:
- `src/infrastructure/git/rollback-scope.ts` (atstatymo mechanika
  teisinga — keičiasi tik aibės parinkimas)
- `dist/**`
- `node_modules/**`

## Veiksmas
- Architect: savininkystės šaltinis be nonce (rašymo įrašų sidecar'ai) ir
  fail-closed taisyklė nenustatomai savininkystei.
- Tester: be nonce + svetimos sesijos kelias → kelias NEatstatomas ir
  išvardytas ataskaitoje; savas kelias → atstatomas kaip iki šiol; senas
  įrašas be savininkystės → fail-closed praleidimas su raportu.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Testų nesilpninti.

## Neįtraukta
`rollback-scope.ts` mechanika. Preserved ref'ų retencija (075). UI.
