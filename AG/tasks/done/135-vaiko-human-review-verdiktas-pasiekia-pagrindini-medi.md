# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Priklausomybės
- 113-hard-cap-atsisakymo-zinute-sako-tiesa-apie-indeksus

## Žingsnis 0 — ar jau įgyvendinta?
Jei nesėkmingo worktree slot'o parkavimas nebelaukia pilnos tylos —
`planWorkerIntegration` (`worker-integration.ts`) nesėkmingus slot'us
grąžina park'ui ir ne-quiescent režime (arba refill'as juos išima iš
re-dispatch aibės iki parkavimo) IR yra regresijos testas „worktree vaikas
su human_review verdiktu → failas pagrindiniame human-review, dingsta iš
queue" — ALREADY_IMPLEMENTED: cituok plano/koordinatoriaus kodą ir testą
kaip įrodymą.

## Tikslas
Gyvo churn ciklo P0 šaknis #2 (2026-09-01): worktree vaiko human-review
verdiktas NEPASIEKIA pagrindinio medžio, ir task'ai sukasi re-dispatch ratu.
Įrodymai: visi 9 šiandienos parkavimai įvyko worktree kopijose
(`.ag/worktrees/*/AG/tasks/human-review/` turi failus), pagrindinis
`AG/tasks/human-review/` — tik 3 senus; visi 9 task'ai tebeguli pagrindinėje
queue ir re-dispatch'inami (WORKER POOL REFILL episode=11 @10:31). Tai 123
task'o Neįtrauktoje užfiksuotas defektas, dabar įrodytas masiškai.
MECHANIZMAS PATIKRINTAS — parkavimo kelias EGZISTUOJA ir yra teisingas:
`createHumanReviewPark` (`wave-integration-ports.ts:98-122`) →
`relocateTask(taskId, "human-review")` su TĖVO agRoot
(`wave-integration-adapters.ts:127-136` — `deps.agRoot` yra pagrindinio
medžio). Skylė yra JO PASIEKIAMUME: (1) vaikas savo verdiktą pritaiko TIK
savo kopijos AG/tasks (applyTerminal vaiko procese — kopija išmetama);
(2) tėvo pusėje `planIncrementalStep` (`worker-integration.ts:177`)
nesėkmingą slot'ą BLOKUOJA nuo inkrementinio kelio („parkavimas sprendžiamas
tyloje"), o koordinatorius incremental režime parkavimų NEVYKDO
(`wave-integration-coordinator.ts:86-95` — „Praleidimai ir parkinimai čia
nevykdomi"); (3) gyvame cikle su nuolatiniu refill'u tyla neateina, o queue
failas laisvai imamas kito refill'o — parkavimas atidėtas neribotam laikui,
re-dispatch'as ne. SVARBU: parkavimas yra TIK failo perkėlimas
(`createHumanReviewPark` jokių šakos/kopijos operacijų nedaro — jos lieka
tylos keliui), tad jo atidėjimas tylai nėra būtinas dėl merge saugumo.
Kryptis (architect patvirtina): nesėkmingų slot'ų parkavimas vykdomas ir
ne-quiescent momentu (plano `park` išraiška incremental režimui + jos
vykdymas koordinatoriuje), o šakos/kopijos tvarkymas (WorkerIntegrationPark
worktree_path saugojimas) LIEKA tylos sprendimu; alternatyva — refill
exclusion (finished-failed slot'o task'as neimamas į re-dispatch iki
parkavimo) — įvertinti, ar reikalinga papildomai lenktynių langui uždengti.

## Agentai
readme-guard -> architect -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/application/scheduling/worker-integration.ts`
- `src/application/scheduling/wave-integration-coordinator.ts`
- `src/application/scheduling/wave-refill.ts` (tik jei pasirenkamas
  papildomas refill exclusion — kitaip neliečiamas)
- `src/tests/scheduling-pool.test.ts` (planWorkerIntegration testai gyvena
  čia — todėl priklausomybė nuo 113, kuris deklaruoja tą patį failą)
- `src/tests/scheduling-wave-integration-coordinator.test.ts`
- `src/tests/scheduling-wave-refill.test.ts` (tik su refill exclusion šaka)

Draudžiama:
- `src/composition/loop/wave-integration-adapters.ts` (`relocateTask` su
  tėvo agRoot teisingas — nekeičiamas)
- `src/application/scheduling/wave-integration-step.ts` (integracijos
  žingsnio tvarka nekinta — keičiasi tik KADA vykdomi park'ai)
- `src/application/scheduling/wave-provisioning.ts`,
  `wave-pool-planning.ts`, `worker-pool-plan.ts` (114/116/113 gamybos
  failai)
- `dist/**`
- `node_modules/**`

## Veiksmas
- `worker-integration.ts`: ne-quiescent šaka (232-240 eil. sritis) greta
  `incremental`/`waiting` išveda ir PARK sąrašą nesėkmingiems slot'ams su
  worktree_path (esama `WorkerIntegrationPark` forma) — su doc'u, KODĖL
  failo perkėlimas saugus be tylos (jokių git operacijų), o kopijos/šakos
  valymas lieka tylai; `planIncrementalStep` 177 eil. blokavimo tekstas
  atnaujinamas pagal naują tiesą.
- `wave-integration-coordinator.ts` (85-96 eil.): incremental režimas
  vykdo plano park'us (runner.park + finishedSlots.delete), integracijos
  žingsniai lieka kaip yra; log eilutės skiria „parked (incremental)" nuo
  tylos parkavimo.
- Regresijos testas (koordinatoriaus lygio): finished slot'as su
  `succeeded:false` + gyvi kiti slot'ai (ne-quiescent) → `relocateTask`
  kviestas su „human-review", slot'as išimtas iš finishedSlots — task'as
  nebegrįžta į re-dispatch; tylos kelio esami testai žali.
- Įvertinti (ataskaitoje) lenktynių langą tarp vaiko pabaigos ir tėvo
  checkpoint'o: jei refill gali pagriebti task'ą DAR PRIEŠ pirmą
  integracijos checkpoint'ą — refill exclusion šaka reikalinga; jei
  checkpoint'as visada įvyksta pirmas, užfiksuoti įrodymą.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei diagnozė parodytų, kad
churn'o priežastis KITA nei atidėtas parkavimas (pvz. finishedSlots įrašo
apskritai nėra, nes vaiko baigtis pametama dar iki plano — tada defektas
`wave-outcome`/`recordOutcome` kelyje ir apimtis persvarstoma).

## Neįtraukta
- Vaiko proceso pusės keitimai (applyTerminal vaiko kopijoje) — vaikas
  elgiasi teisingai savo ribose; tiesa taikoma tėvo kelyje.
- Worktree kopijų `AG/tasks` turinio sinchronizacija atgal — kopija lieka
  išmetama; vienintelė tiesa yra tėvo bucket'ai.
- Jau parkuotų 9 task'ų rankinis sutvarkymas — operatoriaus veiksmas.
- 134 (pnpm aplinka) — atskira šio churn'o šaknis, nepriklausomas scope.
