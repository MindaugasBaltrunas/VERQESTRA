# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Priklausomybės
- `154-kohortu-arm-as-skaitomas-tik-is-pack-o-irasu-finalize-nedemotuoja` (duoda `describesContextPack` predikatą `src/application/context-pack/metrics.ts`)

## Tikslas
34 iš 34 užbaigtų canary task'ų kohortų raporte pateko į control, nes vėlesnė finalize eilutė be `canary_features` perrašo pack'o eilutės narystę pagal „vėliausias laimi". Analytics skaitytojai turi remtis TIK pack'o įrašais: sintetinės eilutės arm'o nekeičia ir dispatch'ų skaičiaus nepučia.

## Agentai
PRIVALOMA grandinė šia tvarka: readme-guard -> architect -> schedule-domain -> coder -> reviewer -> tester.

## Failai
Leidžiama:
- `src/application/analytics/attempt-identity-join.ts`
- `src/application/analytics/compression-cohorts.ts`
- `src/application/analytics/cohort-model.ts`
- `src/tests/analytics-cohorts.test.ts`

Draudžiama:
- `src/application/context-pack/metrics.ts`
- `src/interfaces/cli/dispatch/claude-dispatch/worker-prompt-preparation.ts`
- `src/application/analytics/post-run-truth-join.ts`
- `src/application/release-readiness/compression-quality-evidence.ts`
- `dist/**`
- `node_modules/**`

## Veiksmas
- `cohort-model.ts` + `compression-cohorts.ts` `selectCohortContextSizeRecords` (~395 eil.): `CohortContextSizeRecord` projekcija perneša lauką, iš kurio `describesContextPack` sprendžia — kitaip UI kelias taisyklės nemato.
- `attempt-identity-join.ts`: `assignArms` (~130-151 eil.) ir `resolveAssignmentByKey` (~223-235 eil.) praleidžia ne-pack įrašus PRIEŠ „vėliausias laimi" ir PRIEŠ `dispatchCount += 1`.
- `analytics-cohorts.test.ts`: (1) pack'o eilutė su features + vėlesnė finalize eilutė be jų → arm `canary`, `dispatchCount` 1; (2) du pack'o įrašai su skirtinga naryste → laimi vėliausias PACK'O įrašas; (3) tik sintetinės eilutės → task'as arm'o negauna (ne control).

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai abi patikros žalios. Sustok ir klausk, jei predikatui reikėtų lauko, kurio kohortų projekcija principiškai neturi.

## Neįtraukta
- `worker-prompt-preparation.ts` kill-switch skaitiklis — kita eilės užduotis.
- `compression-quality-evidence.ts` `canary-not-observed` skaitiklis — atskiras P3.
- Trijų „vėliausias" taisyklių suliejimas į vieną — čia jos tik gauna bendrą predikatą.
