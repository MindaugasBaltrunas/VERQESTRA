# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Priklausomybės
- 164-loop-startas-vykdo-loop-prielaidas-pasenes-dist-exit-78

## Žingsnis 0 — ar jau įgyvendinta?
Jei `createRunCoordinator(` kvietėjai `src/composition/loop/command.ts`,
`src/composition/cli/commands-ops.ts` ir `src/composition/cli/commands-tasks.ts` visi trys eina per
VIENĄ fabriką (grep `coordinatorEntrypointPorts` ar jo atitikmuo visuose trijuose), kuris paduoda ir
`preservedWorkReview`, ir `cheapFinishOverlay` — ALREADY_IMPLEMENTED: cituok tris kvietimus ir
fabriko failą.

## Tikslas
Pilnas auditas 2026-09-05 (`docs/audits/full-audit-2026-09-05.md`, L7; pilna ataskaita
`audit-composition.md` P1-3): koordinatoriaus portai skiriasi pagal įėjimo tašką.
`command.ts:255-269` (in-process w1) paduoda `preservedWorkReview: preservedWorkReviewPort(...)` IR
`cheapFinishOverlay`; `commands-ops.ts:329-342` (`resumeTask`) — nė vieno;
`commands-tasks.ts:110-125` (`process-queued-task` = KIEKVIENAS worktree vaikas ir benchmark celė)
— su overlay, be `preservedWorkReview`. Pasekmės: `verify-task.ts:253`
`options.preservedWorkReview !== undefined` → be porto preserved darbas visada parkuojamas
`preserved_work=<ref>`, niekada `recovered` (w2+ vaikams ir kiekvienam resume);
`run-coordinator-cheap-finish.ts:41` / `run-coordinator-terminal.ts:339` be `ports.cheapFinish` →
tęsiamas task'as cheap finish negauna, terminalinis skaidymas mato 0 bandymų. Testas
`composition-preserved-work-wiring.test.ts:97-100` tikrina adapterį, ne kiekvieno įėjimo surišimą.
`command.ts:10-11` antraštė žada „in-process kelias yra TAS PATS koordinatorius, kurį kviečia
process-queued-task" — surišimas to nelaiko.

Kryptis (audito santrauka L7): vienas `taskRunPorts` fabrikas visiems trims įėjimams; skirtumas
tarp įėjimų lieka TIK overlay egzemplioriaus nuosavybė (vienas per paleidimą), ne portų rinkinys.
Priklausomybė nuo 164: abu liečia `commands-ops.ts` `loop` run bloką.

## Agentai
readme-guard -> architect -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/composition/loop/coordinator-entrypoint-ports.ts` (numatomas naujas; jei fabrikas natūraliau gyvena `preserved-work-adapters.ts` — tas failas vietoje šio, įrašyti į ataskaitą)
- `src/composition/loop/command.ts` (252-269 `runInProcess`; antraštė 10-11)
- `src/composition/cli/commands-ops.ts` (327-342 `resumeTask`)
- `src/composition/cli/commands-tasks.ts` (103-128 `process-queued-task`)
- `src/tests/composition-preserved-work-wiring.test.ts`
- `src/tests/composition-loop-command.test.ts`
- `src/tests/composition-coordinator-entrypoint-ports.test.ts` (numatomas naujas)

Draudžiama:
- `src/composition/loop/coordinator-execution-adapters.ts` (`taskRunPorts` — 163 scope; fabrikas jį importuoja)
- `src/composition/loop/preserved-work-adapters.ts` (importuojamas; keičiamas TIK jei fabrikas dedamas ten — tada įrašyti į Leidžiama ataskaitoje)
- `src/composition/loop/coordinator-adapters.ts` (173 scope)
- `src/application/task-execution/verify-task.ts`
- `src/application/task-execution/run-coordinator-cheap-finish.ts`
- `src/application/task-execution/run-coordinator-terminal.ts` (165 scope)
- `dist/**`
- `node_modules/**`

## Veiksmas
- Naujas fabrikas `coordinatorEntrypointPorts({ roots, cheapFinishOverlay, create: true })` →
  `{ ports: TaskRunPorts, options: { preservedWorkReview } }`: viduje `taskRunPorts(...)` +
  `preservedWorkReviewPort({ projectRoot })` + `cliChildRunner(projectRoot, overlay)` +
  `activeAttemptResolution({ create: true })`. Overlay PRIVALOMAS argumentas — jo nebuvimas buvo
  klaida, ne variantas.
- `command.ts` `runInProcess`, `commands-ops.ts` `resumeTask`, `commands-tasks.ts`
  `processQueuedTask`: visi trys → `createRunCoordinator(ports, options).start(...)` per fabriką.
  `resumeTask` overlay: vienas egzempliorius `loop` run scope'e (tas pats principas kaip
  `command.ts:263-264` — „vienas visam paleidimui"); jei `cheapFinishOverlay` gimsta
  `buildLoopCyclePorts` viduje, iškelti į `LoopCommandDeps`, kad resume ir in-process dalintųsi.
- Antraštė `command.ts:10-11` lieka teisinga — surišimas dabar ją įrodo.
- Testai: naujas `composition-coordinator-entrypoint-ports.test.ts` — fabriko rezultatas turi
  `options.preservedWorkReview` ir `ports.cheapFinish` (abu apibrėžti); šaltinio lygmens vartas —
  `createRunCoordinator(` per tris composition failus pasirodo TIK su fabriko rezultatu;
  `composition-preserved-work-wiring.test.ts` papildomas resume/process-queued-task keliais;
  `composition-loop-command.test.ts` žalias.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei bendras overlay resume keliui reiškia, kad
cheap finish „vienkartinė" teisė gali būti sunaudota resume'o, o ne naujo task'o — tada overlay
nuosavybės taisyklė yra operatoriaus sprendimas, ne surišimo detalė.

## Neįtraukta
- `taskRunPorts` vidus (`coordinator-execution-adapters.ts`) — 163.
- `verify-task.ts:253` `recovered` semantika — nekinta, tik pasiekiama visais įėjimais.
- Benchmark celės aprūpinimas — 175.
