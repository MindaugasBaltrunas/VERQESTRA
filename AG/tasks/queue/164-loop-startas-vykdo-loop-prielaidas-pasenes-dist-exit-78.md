# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Žingsnis 0 — ar jau įgyvendinta?
Jei `src/composition/cli/commands-ops.ts` `loop` komandos `run` kviečia `evaluateLoopPreconditions`
PRIEŠ `runLoopCommand(` ir neišlaikytas `fresh-dist` grąžina `DIST_STALE_EXIT_CODE` (grep
`DIST_STALE_EXIT_CODE` per `src/composition` ir `src/application/scheduling/loop-preconditions.ts`
randa emiterį) — ALREADY_IMPLEMENTED: cituok kvietimą ir exit kodo šaką.

## Tikslas
Pilnas auditas 2026-09-05 (`docs/audits/full-audit-2026-09-05.md`, L2, patikrinta ✓):
`verqestra loop` nevykdo loop prielaidų. `runLoopCommand` (`composition/loop/command.ts:490-500`) →
`recoverFromCrash` → `runLoopCycle`; portas `preconditions` naudojamas tik
`productTreeDirtyEntries` (`command.ts:397`). `evaluateLoopPreconditions` (stable-ref, index.lock,
git repo, stale dist) kviečiama TIK `loop-guard` komandoje (`commands-ops.ts:357`); UI „Paleisti"
spawn'ina `["loop"]` (`composition/ui/lifecycle-adapters.ts:133`), tad ir jis be vartų.
`DIST_STALE_EXIT_CODE` turi tik apibrėžimą (`shared/exit-codes.ts:13,45`) ir nė vieno emiterio.
README:104 žada, kad stale dist nutraukia loop'ą — netiesa: po `src` redagavimo be build'o ciklas
suka seną dist, o kopijos gauna tą patį seną dist su šviežiu `.buildstamp`
(`worktree-runtime.ts:303-311`), tad ir vaiko hook'ai mato „fresh". Praleidžiami ir
`valid-stable-ref`, `no-stale-index-lock`, `git-repository` vartai — `loop-preconditions.ts:51-53`
pačių aprašyta etalono pamoka: pakibęs index.lock sudegino 208/209 į human-review.

Kryptis (audito „Ką daryti pirmiausia" 3): `loop` startas kviečia `evaluateLoopPreconditions` su
TAIS PAČIAIS portais kaip `loop-guard`; stale dist → exit 78. Vartai dedami kvietėjo pusėje
(`commands-ops.ts`, kaip UI autostart 2026-08-24), ne `runLoopCommand` viduje — `command.ts` yra
168/169 task'ų scope.

## Agentai
readme-guard -> debugger -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/composition/cli/commands-ops.ts` (`loop` run 249-347; `loop-guard` 353-368 dalijasi vienu evaluate kvietimu)
- `src/application/scheduling/loop-preconditions.ts` (exit kodo atvaizdis iš report'o)
- `src/tests/interfaces-cli-dispatch.test.ts`
- `src/tests/composition-ui-autostart.test.ts` (44-47 tikrina kvietimų tvarką `commands-ops.ts` šaltinyje — gali reikėti atnaujinti)
- `src/tests/composition-loop-preconditions-wiring.test.ts` (numatomas naujas; jei šaltinio tvarkos asercijai užtenka `composition-ui-autostart.test.ts` — tas failas vietoje šio, įrašyti į ataskaitą)

Draudžiama:
- `src/composition/loop/command.ts` (`runLoopCommand` nekinta — 168/169 scope)
- `src/interfaces/cli/dispatch/loop-guard.ts`
- `src/infrastructure/process/dist-freshness.ts` (importuojamas per portus, nekeičiamas)
- `src/shared/exit-codes.ts`
- `src/interfaces/http/**`
- `ui-app/**`
- `README.md`
- `dist/**`
- `node_modules/**`

## Veiksmas
- `commands-ops.ts`: `loop-guard` `evaluate` kvietimas (357-366: `loopPreconditionPorts()`,
  `packageRoot()` dist'ui, `state` katalogas, `{ reapDeadLeases }`) iškeliamas į vieną lokalią
  funkciją; `loop` `run` ją kviečia po `ensureRuntimeDirs` ir PRIEŠ `ensureUiRunning`/`runLoopCommand`;
  report'as spausdinamas per `renderLoopPreconditionReport` į `io`, `!report.ok` → grąžinamas
  `loopPreconditionExitCode(report)` ir į `orchestrator.log` rašoma
  `LOOP PRECONDITIONS BLOCKED: <neišlaikytų vartų vardai>`.
- `loop-preconditions.ts`: `loopPreconditionExitCode(report)` — neišlaikytas `fresh-dist` (140 eil.)
  → `DIST_STALE_EXIT_CODE`; bet kuris kitas → `LOOP_BLOCKED_EXIT_CODE`. `loop-guard` savo `0/1`
  kontrakto NEkeičia.
- Testai: `interfaces-cli-dispatch.test.ts` — exit kodo atvaizdis (stale dist → 78; index.lock → 1;
  žalia → nėra); šaltinio tvarkos testas — `evaluateLoopPreconditions(` (arba iškeltos funkcijos
  vardas) `loop` run kūne yra PRIEŠ `runLoopCommand(`; `composition-ui-autostart.test.ts` lieka
  žalias arba atnaujinamas, jei jo indeksų asercija reaguoja į naują kvietimą.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei `fresh-dist` patikra `packageRoot()` prieš
`projectRoot` dev checkout'e blokuoja kiekvieną startą (pvz. UI autostart konteksto `cwd`) — tada
ne silpninti vartą, o pranešti; sprendimas apie `dist` šaltinį priklauso operatoriui.

## Neįtraukta
- `quarantineStaleDist` prijungimas: jo pranešimas yra Stop hook'o degradacija („Stop hook absorbed,
  commit skipped", `dist-freshness.ts:108`), vieta — `interfaces/hooks/on-stop`, ne loop startas;
  `dead-export-gate.test.ts:283-285` KNOWN_UNCALLED įrašas lieka, atskiras hooks task'as.
- README:104 formuluotė ir exit kodų lentelė — dokumentacijos autorius.
- UI mygtuko reakcija į exit 78 (`interfaces/http/loop-lifecycle`) — po šio signalo duomenų.
- Bangos viduryje perstatytas dist (L8) — task 169.
