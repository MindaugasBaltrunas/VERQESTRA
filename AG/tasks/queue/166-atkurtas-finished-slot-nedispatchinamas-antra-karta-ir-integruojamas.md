# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Žingsnis 0 — ar jau įgyvendinta?
Jei `src/application/scheduling/wave-scheduler.ts` `planPool` kandidatus filtruoja per
`started ∪ finishedSlots` (ne tik `selectNextWaveTask` 412-413) IR `recoverFromCrash` po
`restoreFinishedSlots` kviečia `integration.integrateFinishedSlots(...)` — ALREADY_IMPLEMENTED:
cituok abi vietas ir `src/tests/scheduling-wave-restored-slots.test.ts` atvejus.

## Tikslas
Pilnas auditas 2026-09-05 (`docs/audits/full-audit-2026-09-05.md`, L4 patikrinta ✓ struktūriškai,
L5): atkurtas finished slot'as (a) dispatch'inamas antrą kartą ir (b) niekada neintegruojamas, jei
nebaigia joks kitas task'as.
(a) `wave-scheduler.ts:412-413` `selectNextWaveTask` filtruoja `started ∪ finishedSlots`, bet
`planPool(current)` (433) → `toWorkerCandidates(current.ready)` (`wave-provisioning.ts:311-331`) be
filtro → `planWorkerPool` (`wave-pool-planning.ts:65-76`) ima kandidatus iš viso `ready`, o
`planWaveDispatch` dispatch'ina `pool.slots`, ne `selection.task` (`wave-dispatch.ts:29-39`). Po
crash'o su nesulieta w2 šaka task'as bėga antrą kartą, `finishedSlots.set` perrašo pirmąjį įrašą —
šaka našlaitė.
(b) `recoverFromCrash` (`wave-scheduler.ts:327-402`) integracijos nekviečia; vienintelis
`integrateFinishedSlots` kvietėjas — `wave-outcome.ts:202-228` po KITO task'o baigties. Likus vienam
task'ui eilėje → `exhausted/already-started` → exit 1 kiekvieną restartą, kol operatorius neištrina
wave snapshot'o. Testas `scheduling-wave-integration-coordinator.test.ts:483-488` šį dizainą
komentaru patvirtina („bet koks kito task'o rezultatas suveda integracijos tikrinimą").

Kryptis (audito santrauka L4/L5): `planPool` filtruoti tomis pačiomis aibėmis kaip
`selectNextWaveTask`; atkurtus slot'us integruoti `recoverFromCrash` metu (arba iškart po jo, prieš
pirmą `nextTask`), ne laukiant svetimos baigties.

## Agentai
readme-guard -> debugger -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/application/scheduling/wave-scheduler.ts` (`planPool`/`nextTask` 404-442, `recoverFromCrash` 327-402)
- `src/application/scheduling/wave-pool-planning.ts` (`PlanWavePoolInput` — filtruotas `ready` arba `excludedTaskIds`)
- `src/tests/scheduling-wave-restored-slots.test.ts`
- `src/tests/scheduling-wave-scheduler.test.ts`
- `src/tests/scheduling-wave-inputs.test.ts` (importuoja `planWavePool`)
- `src/tests/scheduling-wave-integration-coordinator.test.ts` (477-491 komentaras ir asercija)

Draudžiama:
- `src/application/scheduling/wave-provisioning.ts` (`toWorkerCandidates` gauna jau filtruotą sąrašą — nekinta)
- `src/application/scheduling/wave-dispatch.ts` (174 scope)
- `src/application/scheduling/wave-outcome.ts`
- `src/application/scheduling/wave-integration-coordinator.ts` (`integrateFinishedSlots` kontraktas nekinta)
- `src/application/scheduling/loop-cycle.ts` (169 scope)
- `src/composition/loop/command.ts` (167/168/169 scope)
- `dist/**`
- `node_modules/**`

## Veiksmas
- `wave-scheduler.ts` `planPool` įėjime: `current.ready` be `state.started` ir
  `state.finishedSlots.keys()` — VIENA aibė, kurią naudoja ir `selectNextWaveTask` (412-413), kad
  abu keliai niekada neišsiskirtų; `wave-pool-planning.ts` `planWavePool` gauna filtruotą `ready`
  (arba `excludedTaskIds`, jei taip aiškiau testui) ir `rememberCandidate` nemato atkurto task'o.
- `wave-scheduler.ts` `recoverFromCrash`: po `state.restoreFinishedSlots(...)` (342) ir
  `decideResume` — jei `finishedSlots` netuščias, kviesti
  `integration.integrateFinishedSlots(evaluateIntegrationCheckpoint({ live: <gyvi slot'ai> }))`
  (tas pats objektas, kurį 286 eil. jau perduoda), su `safeLog`/`safeEvent`
  (`resume_integration`); integracijos klaida atkūrimo NEnutraukia. Atkurtas slot'as išsprendžiamas
  (suliejamas / parkuojamas / requeue per 152 `restored-requeued`) PRIEŠ pirmą `nextTask`.
- Testai: `scheduling-wave-restored-slots.test.ts` — (1) atkurtas w2 slot'as + du ready task'ai →
  `pool.slots` be atkurto `task_id`; (2) vienas task'as eilėje su atkurtu slot'u → po
  `recoverFromCrash` slot'as integruotas/parkuotas ir `nextTask` NĖRA `exhausted/already-started`;
  `scheduling-wave-integration-coordinator.test.ts:477-491` — komentaras ir eiga be „kito task'o
  rezultato"; `scheduling-wave-inputs.test.ts` — `planWavePool` filtras; `scheduling-wave-scheduler.test.ts`
  regresija žalia.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei integracijai `recoverFromCrash` metu trūksta
`WaveIntegrationIo` duomenų, kuriuos `command.ts` (kito task'o scope) dar neduoda — tada integraciją
kviesti pirmame `nextTask` ėjime tame pačiame faile, bet ne keisti `command.ts`.

## Neįtraukta
- `wave-dispatch.ts:146` nuoseklus `beginTask` prieš `runTask` (antro metimas palieka pirmą
  `running`) — task 174.
- 152 `restored-requeued` semantika — nekinta, tik pasiekiama anksčiau.
- `command.ts` surišimo pakeitimai — 167/168/169.
