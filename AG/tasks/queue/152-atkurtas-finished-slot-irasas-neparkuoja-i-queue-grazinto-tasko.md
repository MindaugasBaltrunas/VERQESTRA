# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Priklausomybės
- 148-b-03-infra-baigtis-nebeparkuojama-kaip-task-failed-work

Reali failų sankirta, ne atsargumas: 148-b-03 (queue, 2026-09-02) keičia tas pačias
`worker-integration.ts` `!slot.succeeded` šakas (245-253, 292-299) ir rašo į
`scheduling-pool.test.ts`. Šis task'as prideda TREČIĄ baigties rūšį („atkurta, baigtis
nežinoma") šalia 148-b-03 infra baigties — statyti reikia ant jau sulieto jo darbo, kad
`succeeded`/infra/restored semantikos nesusipintų dviejuose lygiagrečiuose merge'uose.

## Žingsnis 0 — ar jau įgyvendinta?
Jei `src/application/scheduling/wave-scheduler-state.ts` `restoreFinishedSlots` jau rašo
atkurtam įrašui atskirą žymą (grep `restored` arba `succeeded: undefined` toje funkcijoje) IR
`src/application/scheduling/worker-integration.ts` `planWorkerIntegration` turi šaką, kuri
tokį slot'ą su task'u `queue` praleidžia (grep `restored-requeued` arba analogišką
`WorkerIntegrationSkip.reason` narį) IR `src/application/scheduling/wave-integration-coordinator.ts`
prieš planavimą kviečia `ports.locateTask` atkurtiems slot'ams —
ALREADY_IMPLEMENTED: nurodyk failus ir eilutes kaip įrodymą. Jei rasta tik dalis (pvz. žyma
yra, o koordinatorius jos nenaudoja) — tikrink po punktą ir baik trūkstamą dalį.

## Tikslas
Operatoriaus į `queue` grąžintas task'as po loop'o restarto vėl išmetamas į `human-review`
be jokios naujos nesėkmės — jį parkuoja iš `vq/state/wave-snapshot.json` atkurtas
`finished_slots` įrašas.

Įrodymas (`vq/logs/orchestrator.log`, 2026-09-02 UTC, task 148-c-04):
- 09:14:55 worktree vaikas baigė sėkmingai (`CLAUDE DIAGNOSIS (local) verdict=done`,
  `TASK DONE`; šaka `ag/worker/1ab3d8ef-…/148-c-04-…-0e8a3dbb/a1`, commit 1d74941).
- 09:15:01 `WORKER INTEGRATION PARKED: task=148-c-04 reason=merge-dirty-primary-tree` —
  task'as į human-review, slot'as liko snapshot'o `finished_slots` sąraše.
- Operatorius `verqestra requeue 148-c-04`; loop'as sustabdytas ir paleistas iš naujo.
- 09:31:15 `WAVE RESUME: discard-stale task=148-c-04 (rr1:discard-stale graph-hash-mismatch)`.
- 09:32:48 `ORPHAN KEPT: path=…w1-148-c-04-…-0e8a3dbb-a1 reason=unmerged-commits`.
- 09:50:13 `WORKER INTEGRATION INCREMENTAL PARK: task=148-c-04 live=118-…` ir
  `WORKER INTEGRATION PARKED: task=148-c-04 reason=task-failed task_file=moved — slot=w1
  baigė nesėkme — kopija …0e8a3dbb-a1 ir jos šaka paliekamos peržiūrai`. Tarp 09:31 ir
  09:50 jokio `SLOT PROVISIONED`/dispatch'o 148-c-04 nebuvo.

Šaknis (patikrinta kode 2026-09-02):
- `src/application/scheduling/wave-scheduler-state.ts:211-223` `restoreFinishedSlots`
  VISADA rašo `succeeded: false` (komentaras 205-209: „fail-closed, koordinatorius praleis arba
  parkuos"). Atkurtas įrašas neturi nei `write_set`, nei `lease`, tad sėkmės įrodyti nėra iš ko —
  bet tai yra „baigtis NEŽINOMA", o kodas ją užrašo kaip „NESĖKMĖ".
- `src/application/scheduling/worker-integration.ts:245-253` (inkrementinis kelias) ir
  `292-299` (tylos kelias): `slot.worktree_path && !slot.succeeded` → `park` su
  `reason: "task-failed"` ir tekstu „baigė nesėkme" — nepriklausomai nuo to, ar slot'as baigė
  šiame procese, ar atkeliavo iš snapshot'o; task'o bucket'o planas neklausia.
- `src/application/scheduling/wave-scheduler.ts:340-342` `recoverFromCrash` atkuria
  `finished_slots` BESĄLYGIŠKAI, prieš `decideResume`. `discard-stale` verdiktas
  (`src/application/scheduling/resume-run.ts:160-161`) sprendžia tik apie CHECKPOINT'O task'ą ir
  `finished_slots` neliečia — todėl „discard-stale" log eilutė ir vėlesnis parkas iš to paties
  įrašo neprieštarauja vienas kitam: tai du nesusiję keliai. `resume-run.ts` keisti nereikia.
- `src/interfaces/cli/task-queue/requeue.ts:44-47` valo ledger'į ir LLM biudžetą, snapshot'o
  nemato — ir matyti negali: `wave-snapshot-store` gyvena infrastruktūroje, o kai loop'as
  gyvas, jis snapshot'ą perrašo iš atminties, tad CLI valymas būtų lenktynės.
- `src/application/scheduling/wave-scheduler.ts:410-413` `nextTask` blokuoja atkurto slot'o
  task'ą (`already-started`), kol koordinatorius įrašo neišima — todėl task'as tarp 09:31 ir
  09:50 negalėjo būti dispatch'intas, o vienintelis „išėmimas" buvo parkas.

Invariantas, kurį task'as įveda: **task'as, kurio bucket'as yra `queue`, NIEKADA nėra
parkuojamas iš snapshot'o atkurto `finished_slots` įrašo**. Atkurtas įrašas be įrodymo yra
„nežinoma baigtis" — jo šaka niekada nesuliejama (fail-closed lieka), bet ir nesėkme
nevadinama.

Pasirinkta kryptis (a): baigtis skiriama TEN, kur snapshot'as VARTOJAMAS (koordinatorius +
planas), ne ten, kur task'as grąžinamas. Atmesta kryptis (b) — `requeue` valo
`finished_slots`: du requeue įėjimai (`requeue.ts` ir
`src/interfaces/http/ui-task-actions.ts:195-207`), abu `interfaces` sluoksnyje be prieigos prie
`infrastructure/state/wave-snapshot-store.ts`, o gyvo loop'o persist'as iš atminties valymą
perrašytų. (b) būtų tik lopas vienam įėjimui; (a) laiko invariantą nepriklausomai nuo to,
KAIP task'as atsidūrė `queue`.

## Agentai
readme-guard -> architect -> schedule-domain -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/application/scheduling/wave-scheduler-state.ts`
- `src/application/scheduling/worker-integration.ts`
- `src/application/scheduling/wave-integration-coordinator.ts`
- `src/tests/scheduling-pool.test.ts`
- `src/tests/scheduling-wave-integration-coordinator.test.ts` (490 eil. — TIK esamų
  `restoreFinishedSlots` testų 323-353 ir 475-490 lūkesčių pataisa; naujų testų čia nedėti)
- `src/tests/scheduling-wave-restored-slots.test.ts` (numatomas naujas; jei tester'is
  randa tinkamesnį esamą failą su vieta iki 500 eil. — tas vietoje šio, įrašyti į ataskaitą)

Draudžiama:
- `src/application/scheduling/wave-scheduler.ts` (lygiai 500 eil. — vartas; sprendimas
  privalo tilpti į koordinatorių ir planą, kurie jau turi `locateTask` portą)
- `src/application/scheduling/wave-snapshot.ts` ir `wave-snapshot-persist.ts` (schemos
  keitimas — ne šio task'o kelias: atkūrimo žyma yra atminties faktas, ne disko laukas)
- `src/application/scheduling/resume-run.ts`
- `src/application/scheduling/loop-cycle.ts` (148-c-04 scope, human-review)
- `src/application/scheduling/wave-outcome.ts` (148-b-03 scope)
- `src/interfaces/cli/task-queue/requeue.ts`
- `src/interfaces/http/ui-task-actions.ts`
- `src/infrastructure/state/wave-snapshot-store.ts`
- `dist/**`
- `node_modules/**`

## Veiksmas
- `worker-integration.ts` `FinishedWorkerSlot`: atskira atkūrimo žyma (pvz. `restored: true`
  arba baigties enum'as vietoje `boolean succeeded`) — architektas renkasi formą, kuri
  nesusipina su 148-b-03 įvesta infra baigtimi; `succeeded`/merge sprendimui atkurtas slot'as
  toliau yra fail-closed (NIEKADA `integrate`).
- `wave-scheduler-state.ts` `restoreFinishedSlots`: rašo tą žymą; komentaras 205-209
  perrašomas, kad nebežadėtų „parkuos", o įvardytų „nežinoma baigtis — sprendžia
  koordinatorius pagal task'o bucket'ą".
- `worker-integration.ts` `planWorkerIntegration`: naujas įėjimas su atkurtų task'ų vieta
  (pvz. `taskLocations?: ReadonlyMap<string, TaskLocation>`; funkcija lieka gryna ir
  sinchroninė). Atkurtas slot'as: vieta `queue` → `skipped` su nauju `reason` nariu (pvz.
  `restored-requeued`), `park` tuščias; vieta `terminal-bucket` → `skipped` (pvz.
  `restored-terminal`); vieta `active`/`absent`/`unknown` → parkas LIEKA (fail-closed), bet
  `reason`/`detail` įvardija atkūrimą ir nežinomą baigtį, ne „baigė nesėkme". Abi šakos
  (inkrementinė ir tylos) elgiasi vienodai — praleidimas, kaip ir task 135 parkas, yra tik
  atminties/bucket veiksmas be git operacijų, tad jam tylos laukti nereikia.
- `wave-integration-coordinator.ts` `integrateFinishedSlots`: atkurtiems slot'ams prieš
  planavimą `await ports.locateTask(task_id)` (portas jau yra:
  `wave-integration-ports.ts:67`, composition grąžina tikslų `"queue"`,
  `src/composition/loop/wave-integration-adapters.ts:134-139`); praleistą atkurtą slot'ą IŠIMA
  iš `finishedSlots` ABIEJUOSE režimuose (inkrementiniame irgi — kitaip užimtame cikle
  requeue'intas task'as lieka `already-started` iki tylos); kopija ir šaka NELIEČIAMOS
  (reaper'is jas jau mato kaip `unmerged-commits`); nauja žurnalo eilutė, pvz.
  `WORKER INTEGRATION RESTORED SKIP: task=… location=queue — snapshot'o įrašas, ne šio proceso
  baigtis; kopija … ir šaka paliekamos`, plius `safeEvent` su savo `event` vardu.
- Testų lūkesčiai:
  - `scheduling-pool.test.ts`: atkurtas slot'as + `queue` → `park` tuščias, `skipped` su
    nauju reason (tylos IR inkrementiniame kelyje); atkurtas slot'as + `active` → parkas su
    atkūrimo tekstu, ne `task-failed` tekstu; atkurtas slot'as niekada `integrate`.
  - `scheduling-wave-integration-coordinator.test.ts`: testas 323 („succeeded visada
    false") perrašomas į naują semantiką (žyma yra, merge fail-closed); testas 475 („po
    koordinatoriaus sprendimo (parkinimo) dispatch'as vėl leidžiamas") — su `locateTask: () =>
    "queue"` (resumeSchedulerDeps 413) sprendimas dabar yra PRALEIDIMAS, ne parkas: tvirtinti,
    kad `relocateTask` į human-review NEkviestas ir dispatch'as leidžiamas.
  - `scheduling-wave-restored-slots.test.ts` (naujas): koordinatorius su atkurtu slot'u ir
    `locateTask → "queue"` — `finishedSlots.size === 0`, log turi `RESTORED SKIP`, nė vieno
    `WORKER INTEGRATION PARKED`; tas pats su `"terminal-bucket"`; su `"active"` — parkas su
    atkūrimo priežastimi; inkrementinis režimas (gyvas slot'as) praleidžia irgi.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei: sprendimas netelpa be
`wave-scheduler.ts` keitimo (jis 500 eil. — reikėtų skėlimo task'o); 148-b-03 sulietas
darbas pakeitė `FinishedWorkerSlot` taip, kad atkūrimo žymos forma su juo konfliktuoja;
esamas testas reikalauja seno „atkurtas = task-failed" elgesio kitame nei čia išvardytame
faile (testas nesilpninamas — stabdoma).

## Neįtraukta
- Kryptis (b): `requeue`/HTTP triažo valymas `finished_slots` snapshot'e — atmesta (žr.
  Tikslas); jei operatorius vis dėlto jos norės — atskiras task'as su nauju portu
  `interfaces` sluoksniui.
- Lease atlaisvinimas praleistam atkurtam slot'ui: snapshot'o `finished_slots` neturi
  `lease_id` (`wave-snapshot.ts:115-127`), tad iš atkurto įrašo atlaisvinti nėra ko; lease
  miršta per TTL (`domain/scheduling/worker-lease-rules.ts:15`, 15 min). Jei paaiškės, kad
  TTL nepakanka — atskiras task'as su `lease_id` persistavimu snapshot'e.
- Integracijos checkpoint'o iškvietimas IŠ KARTO po `recoverFromCrash` (dabar jis įvyksta
  tik kito slot'o `recordOutcome` metu — log'e 19 min tarpas 09:31→09:50): reikalauja
  `wave-scheduler.ts`, kuris yra 500 eil.; atskiras task'as po skėlimo.
- `discard-stale` ir `finished_slots` ryšys `resume-run.ts` — patikrinta, kad keisti
  nereikia (verdiktas apie checkpoint'ą, ne apie slot'us).
- `merge-dirty-primary-tree` pirminė priežastis (svetimi necommitinti failai pirminiame
  medyje 09:15:01) — kitas scope (146/147 šeima).
- 148-c-04 (`loop-cycle.ts`, human-review) ir 149 (preambulė) — kiti scope'ai.
