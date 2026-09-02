# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Žingsnis 0 — ar jau įgyvendinta?
Jei (a) `src/composition/cli/main.ts` catch šaka `WorkflowInfrastructureError`
grąžina jos `exitCode` (ne `UNEXPECTED_ERROR_EXIT_CODE`), (b)
`src/composition/loop/command.ts` `runChild` vaiko exit kodą, kurį
`isInfrastructureExitCode` klasifikuoja infra, perduoda AUKŠČIAU ne kaip
`false` (task-failed), o kaip atskirą infra baigtį, IR (c)
`src/application/scheduling/worker-integration.ts` tokio slot'o NEparkuoja
`task-failed` — ALREADY_IMPLEMENTED: cituok visas tris vietas ir testą, kuris
usage-limit vaiko baigtį veda per pilną kelią.

## Tikslas
Įrodymas (GeoGravity `vq/logs/orchestrator.log` 2026-09-01 21:17–21:31): Claude
5 val. usage limitas (`rate_limit_event five_hour utilization=1`, 429). Vaiko
(`process-queued-task`) koordinatorius elgėsi teisingai —
`claude-dispatch-outcome.ts:145` pažymėjo `DISPATCH USAGE LIMIT … marking infra
(75)`, `run-coordinator-terminal.ts:298-310` grąžino task'ą į queue KOPIJOJE ir
metė `WorkflowInfrastructureError(exitCode=75, taskReturnedToQueue=true)`. Toliau
grandinė sugriūva trijose vietose:

1. `src/composition/cli/main.ts:56-61` — catch'as `WorkflowInfrastructureError`
   nemato: `infrastructureExitCodeForError` atpažįsta tik errno klaidas, tad
   vaikas baigia `UNEXPECTED_ERROR_EXIT_CODE` (1). Žurnale:
   `process-queued-task: dispatch infrastructure failure exit=75` ir po jo
   `WAVE SLOT CHILD EXIT 1`. Exit kodų lentelė (`shared/exit-codes.ts`) sako,
   kad 75 yra „wait-and-resume", bet per proceso ribą jis pranyksta.
2. `src/composition/loop/command.ts:300` `runChild` grąžina
   `result.code === 0` — vienas bitas. `slot-task-runner.ts:156` jį perduoda
   kaip slot'o sėkmę, `wave-outcome.ts:70-93` fiksuoja `task_failed`.
3. `src/application/scheduling/worker-integration.ts:245-253` ir `292-299` —
   `!slot.succeeded` su `worktree_path` = parkavimas `task-failed` į
   human-review. Rezultatas: 20 task'ų (1232–1254) per 12 minučių po ~5 s
   kiekvienas (`events=0`) atsidūrė human-review, o ciklas rašė
   `WAVE SLOT ENDED NONZERO … CONTINUING QUEUE` ir degino eilę toliau. Tas pats
   limitas pirminio medžio slot'e (1248, in-process kelias) loop'ą sustabdė
   (`LOOP ABORT (infrastruktura)` → metimas iki `loop` komandos) — dvi
   nesuderintos semantikos tam pačiam įvykiui.

Sprendimo kryptis (invariantai, kurių architektas negali silpninti):
- Infra baigtis NIEKADA nėra `task-failed` parkas: task failas lieka queue
  (pagrindiniame medyje jis ir taip neliestas — vaikas judino tik kopiją),
  kopija ir šaka paliekamos, kaip dabar.
- Usage-limit (75) ir kiti `isInfrastructureExitCode` kodai vaiko slot'e
  elgiasi KAIP pirminio medžio slot'e: bangos daugiau neužpildomos, loop'as
  baigiasi tuo pačiu infra kodu (arba laukia, jei toks mechanizmas jau yra —
  architektas patikrina `empty-queue-adapters.ts:130` `isInfrastructureExitCode`
  naudojimą ir `loop-cycle.ts` refill/hold kelią prieš išradinėdamas naują).
- Exit kodų reikšmės (`cli-exit-contracts.json` charakterizacija) NEKINTA:
  keičiasi tik tai, kad `WorkflowInfrastructureError.exitCode` pasiekia
  proceso exit'ą.

Atmesta alternatyva: parsinti vaiko stdout tekstą „infrastructure failure
exit=75" tėve — trapus kontraktas per žmogui skirtą eilutę; exit kodas jau
yra kryžminio proceso kontraktas, juo ir naudotis.

## Agentai
readme-guard -> architect -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/composition/cli/main.ts` (catch: WorkflowInfrastructureError exitCode)
- `src/composition/loop/command.ts` (runChild: infra klasifikacija iš result.code)
- `src/application/scheduling/slot-task-runner.ts` (runChild porto baigties tipas)
- `src/application/scheduling/worker-integration.ts` (infra baigtis be task-failed parko)
- `src/application/scheduling/wave-outcome.ts` (recordOutcome infra atšaka, jei architektas taip nusprendžia)
- `src/application/scheduling/loop-cycle.ts` (refill hold / abort po infra slot baigties)
- `src/tests/composition-cli.test.ts` (main catch: WorkflowInfrastructureError → jos exitCode)
- `src/tests/composition-loop-child-exit.test.ts` (runChild su code=75 → infra baigtis, ne false)
- `src/tests/scheduling-slot-task-runner.test.ts` (naujas baigties tipas per runner'į)
- `src/tests/scheduling-pool.test.ts` (worker-integration: infra slot'as neparkuojamas)
- `src/tests/scheduling-loop-cycle.test.ts` (po infra slot'o refill'ai sustoja / loop baigiasi infra kodu)

Draudžiama:
- `src/shared/exit-codes.ts` ir `src/tests/fixtures/characterization/cli-exit-contracts.json` (kodų reikšmės — kryžminis kontraktas)
- `src/application/task-execution/run-coordinator-terminal.ts` (vaiko pusė teisinga — neliesti)
- `src/infrastructure/adapters/claude-dispatch-outcome.ts` (usage-limit aptikimas teisingas)
- `src/application/scheduling/wave-provisioning.ts` (provision mechanika nekinta)
- `dist/**`
- `node_modules/**`

## Veiksmas
- ŽINGSNIS 1 (architect): apibrėžk slot baigties tipą vietoj `boolean`
  (pvz. `"succeeded" | "task-failed" | "infrastructure"` su exit kodu) ir kur
  jis virsta loop lygio sprendimu: `runChild` → `slot-task-runner` →
  `wave-dispatch`/`wave-outcome` → `worker-integration` (park sprendimas) →
  `loop-cycle` (refill hold arba abort). Įvardyk, ar infra vaiko baigtis meta
  tą pačią `WorkflowInfrastructureError` kaip in-process kelias (viena
  semantika), ar loop'as lieka gyvas su hold — ir kodėl.
- `main.ts`: `error instanceof WorkflowInfrastructureError` → grąžinti
  `error.exitCode` (arba jos lauką, jei vardas kitas — patikrink
  `shared/errors.ts:56-70`); errno kelias lieka kaip buvęs.
- `command.ts` `runChild`: `isInfrastructureExitCode(result.code)` → infra
  baigtis su kodu; diagnostikos blokas (`formatChildExitDiagnostics`) lieka
  ir infra atveju — operatorius turi matyti priežastį.
- `worker-integration.ts`: infra baigtis → nei `integrate`, nei `park`; slot'o
  lease atlaisvinimas ir kopijos paliekimas kaip `task-failed` kelyje, bet
  žurnalo eilutė aiškiai skiria (`WORKER INTEGRATION INFRA: task=… exit=75
  task_file=queue kopija paliekama`).
- `loop-cycle.ts`: po infra slot baigties refill'as negauna naujo darbo
  (esamas `SlotRefillHold` mechanizmas — naujas `kind`, pvz.
  `infrastructure-abort`), ciklas baigiasi infra kodu, ne
  `CONTINUING QUEUE`.
- Testų lūkestis: (1) `composition-cli`: WorkflowInfrastructureError su
  exitCode 75 → `runCli` grąžina 75, 124 → 124; paprasta Error → kaip iki šiol.
  (2) `composition-loop-child-exit`: vaiko code 75 → runChild baigtis infra,
  diagnostika vis tiek užrašyta. (3) `scheduling-pool`: finished slot su infra
  baigtimi ir worktree_path → `park` tuščias, `integrate` tuščias, žurnalas
  turi INFRA eilutę; `task-failed` (code 1) elgesys nepakitęs. (4)
  `scheduling-loop-cycle`: po infra slot'o refill hold, nė vienas kitas queue
  task'as nedispatch'inamas, ciklo baigtis infra.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei architekto verdiktas
reikalauja keisti `wave-scheduler-contract.ts` `recordOutcome` kontraktą taip,
kad lūžtų wave snapshot'o (`wave-scheduler-state.ts:205-219`) resume semantika —
tada šio task'o apimtis apsiriboja `main.ts` + `runChild` + `worker-integration`
(parko pašalinimas), o loop-lygio hold keliauja į atskirą task'ą.

## Neįtraukta
- Laukimas iki `resetsAt` ir automatinis atsinaujinimas (wait-and-resume) —
  atskiras task'as; čia tik korektiška baigtis ir sustojimas.
- GeoGravity 1232–1254 grąžinimas į queue — jau atliktas operatoriaus per
  `verqestra requeue` 2026-09-02.
- Dalinio darbo perėmimas iš paliktos kopijos naujam bandymui
  (`refs/verqestra/preserved` kelias) — esama preserved-work mechanika
  neliečiama.
- `child-exit-diagnostics.ts` teksto keitimas — eilutės grep'inamos
  operatoriaus, formatas nekinta.
