# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Tikslas
Jau atsiveruse spraga: `refs/verqestra/preserved/<sha>` be `rollback-preserved/<task>.json` iraso. Reikia sutaikinimo praejimo, kuris tokiam ref'ui atkuria metaduomenis is paties commit'o (zinute, diff paths, data), o neatkuriamą pazymi `unattributed` ir perduoda retencijai kaip kandidata. Remiasi ankstesniu darbu, kuris irasa jau raso i patvaria sakni.

## Agentai
readme-guard -> architect -> coder -> reviewer -> tester

## Failai
Leidziama:
- `src/infrastructure/git/preserved-ref-reconcile.ts`
- `src/tests/infrastructure-preserved-ref-reconcile.test.ts`

Draudziama:
- `src/interfaces/cli/bootstrap/rollback-stable.ts`
- `src/interfaces/cli/admin/status.ts`
- `src/infrastructure/git/preserved-ref-retention.ts`
- `dist/**`
- `node_modules/**`
- `ui-app/**`

## Veiksmas
- Naujas `preserved-ref-reconcile.ts`: enumeruoja `refs/verqestra/preserved/*` (prefiksas is `rollback-scope.ts`), sulygina su `vq/state/rollback-preserved/*.json` irasais ir grazina `attributed` / `restored` / `unattributed` sarasus; IO tik per injektuojamus portus, failas <= 500 eiluciu.
- Atkurimas: task id ir paths imami is preserved commit'o zinutes bei `diff --name-only`, data — is commit'o; irasas rasomas tuo paciu formatu, kuri skaito `preserved-ref-retention.ts`; egzistuojantis irasas NIEKADA neperrasomas.
- Testai: ref be iraso gauna atkurtus metaduomenis; ref, kurio task id neatkuriamas, pazymimas `unattributed` su log eilute ir perduodamas retencijai kaip kandidatas; ref su irasu lieka nepaliestas.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros zalios. Sustok, jei sutaikinimui prireiktu keisti `preserved-ref-retention.ts` public kontrakta.

## Neitraukta
Patvarus irasso rasymas preserve metu (ankstesnis darbas). Status komandos matomumas (kitas darbas). Ref'u trynimas (075 scope). Loop starto wiring composition sluoksnyje.
