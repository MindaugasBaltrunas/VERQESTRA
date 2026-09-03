# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Žingsnis 0 — ar jau įgyvendinta?
Jei `src/application/analytics/attempt-identity-join.ts` `assignArms` ir
`src/interfaces/cli/dispatch/claude-dispatch/worker-prompt-preparation.ts` „vėliausias
`canary_features`" žemėlapis abu praleidžia įrašus, kurie neaprašo pack'o
(`max_context_chars === 0`), ir `src/tests/analytics-cohorts.test.ts` turi atvejį „sintetinė
finalize eilutė be `canary_features` nedemotuoja canary į control" — ALREADY_IMPLEMENTED:
cituok predikatą, abu jo kvietėjus ir testo pavadinimą.

## Tikslas
Kompresijos A/B eksperimentas per 6 dienas nesurinko nė vieno galiojančio canary stebėjimo
(auditas `docs/audits/compression-audit-2026-09-03.md`, §3). Kiekvienam canary task'ui
`vq/logs/context-size.jsonl` turi dvi eilutes: pack'o eilutę su `canary_features` ir vėlesnę
`src/infrastructure/adapters/claude-dispatch-finalize.ts:167-186` eilutę (`worker_prompt_chars`,
`context_chars: 0`, `max_context_chars: 0`) BE `canary_features`. Pavyzdys: task
`141-b-03-…` — `2026-09-03T11:53:03` `["symbol_slices","dispatch_tool_schema"]`, paskui
`2026-09-03T12:24:10` be lauko. Skaitytojai taiko „vėliausias laimi", o tuščias masyvas pagal
`metrics.ts:259-262` kontraktą reiškia control — todėl **34 iš 34 užbaigtų canary task'ų raporte
yra control**. Pasekmės: kohortų raportas amžinai `insufficientSample`, control kohorta užteršta
canary task'ais, K trigger'is (human-review arrest) miręs visiems užbaigtiems dispatch'ams,
`symbol_slices` kokybės hipotezė nepatikrinama.

Sprendimas — skaitytojo pusėje, viena taisyklė vienoje vietoje: **arm'o įrodymas ir dispatch'ų
skaičius imami TIK iš įrašų, kurie aprašo context pack'ą.** Sintetiniai įrašai (finalize
`worker_prompt_chars`, tool-schema shadow, hook digest) pack'o neaprašo ir arm'o nekeičia.
Atmesta alternatyva — rašytojui nešti `canary_features`: finalize kohortos nežino, rašytojų yra
trys (finalize ×2, hooks), o „empty means control" kontraktas išliktų dviprasmis. Predikato
kandidatas: `max_context_chars > 0` (visi trys sintetiniai rašytojai jį EKSPLICITIŠKAI nustato 0;
pack'o eilutė visada neša biudžetą). Architektas patvirtina arba pasiūlo tikslesnį
(`cache_status !== "unknown"` yra ekvivalentus).

## Agentai
readme-guard -> architect -> schedule-domain -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/application/context-pack/metrics.ts` (predikatas šalia `ContextSizeMetricsRecord`)
- `src/application/analytics/cohort-model.ts` (`CohortContextSizeRecord` gauna lauką sprendimui)
- `src/application/analytics/attempt-identity-join.ts` (`assignArms`, `resolveAssignmentByKey`)
- `src/application/analytics/compression-cohorts.ts` (`selectCohortContextSizeRecords` projekcija)
- `src/interfaces/cli/dispatch/claude-dispatch/worker-prompt-preparation.ts` (vėliausio įrašo žemėlapis)
- `src/tests/analytics-cohorts.test.ts`
- `src/tests/interfaces-cli-dispatch-runtime.test.ts` (worker-prompt-preparation testai gyvena čia)
- `src/tests/context-pack-metrics.test.ts`

Draudžiama:
- `src/infrastructure/adapters/claude-dispatch-finalize.ts` (rašytojas lieka — jo eilutės tarnauja post-run join'ui)
- `src/application/analytics/post-run-truth-join.ts` (savas `attempt_id` join'as, arm'o nesprendžia)
- `src/application/release-readiness/compression-quality-evidence.ts`
- `dist/**`
- `node_modules/**`

## Veiksmas
- `metrics.ts`: vienas eksportuotas predikatas (pvz. `describesContextPack(record)`), doc'as
  įvardija tris sintetinius rašytojus ir kodėl jie arm'o įrodymu nėra.
- `attempt-identity-join.ts`: `assignArms` (130-151 eil.) ir `resolveAssignmentByKey`
  (223-235 eil.) įrašus be pack'o praleidžia PRIEŠ „vėliausias laimi" ir PRIEŠ
  `dispatchCount += 1` — sintetinės eilutės nebepučia ir dispatch'ų skaičiaus.
- `compression-cohorts.ts` `selectCohortContextSizeRecords` (395 eil.) ir `cohort-model.ts`:
  projekcija perneša lauką, iš kurio predikatas sprendžia — kitaip UI kelias taisyklės nematytų.
- `worker-prompt-preparation.ts` 59-69 eil.: tas pats predikatas prieš `latest.set` — kill-switch
  skaitiklis vėl mato canary narystę užbaigtiems dispatch'ams.
- Testai: (1) pack'o eilutė su features + vėlesnė finalize eilutė be jų → arm `canary`,
  `dispatchCount` 1; (2) du pack'o įrašai su skirtinga naryste → vėliausias PACK'O įrašas laimi
  (0034 politika išlieka); (3) tik sintetinės eilutės → task'as arm'o negauna (ne control);
  (4) `worker-prompt-preparation` analogas su fake `readContextSizeMetrics`; (5) predikato
  ribiniai atvejai `context-pack-metrics.test.ts` (0/0, teigiamas biudžetas, trūkstamas laukas
  senuose įrašuose — senas pack'o įrašas visada turi `max_context_chars`, tad trūkstamas laukas
  yra ne-pack'as).

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei paaiškėtų, kad kuris nors gyvas pack'o
rašytojas gali rašyti `max_context_chars: 0` (tada predikatas turi būti kitas, ne taisomas
rašytojas).

## Neįtraukta
- Sintetinių eilučių įtaka `compression-quality-evidence.ts` „silent canary" skaitikliui
  (`canary-not-observed`) — atskiras P3 iš audito 2.
- Trijų „vėliausias" taisyklių suliejimas į vieną (ts vs append tvarka) — čia jos tik gauna
  bendrą predikatą.
- `dispatch_tool_schema` shadow poros rašymas (finalize `input.toolSchema.shadow` visada
  `undefined`) — audito 2 radinys #152, atskiras task'as.
