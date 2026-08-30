# Task

## Spec source
openspec/changes/verqestra-backlog-v1

## Žingsnis 0 — ar jau įgyvendinta?
Jei `src/composition/agent/dispatch-adapters.ts` `resolveAttempt` nebegrąžina
besąlygiško `reason=no-runtime` stub'o (t. y. per `input.resolution.resolveActiveAttempt`
išsprendžia attempt'ą ir launch/finalize kanalams paduoda attempt-scoped
`claude-last` kelią), o testas tvirtina, kad po dispatch'o attempt kataloge
guli `logs/claude-last.log` ir `readClaudeSessionLog` grąžina
`origin === "attempt"` — ALREADY_IMPLEMENTED: cituok `resolveAttempt` kūną
ir testo pavadinimą kaip įrodymą.

## Tikslas
2026-08-30 05:26 task'as 066-b-03 klaidingai parkuotas į human-review su
„TASK NOT DONE: executor made no write-tool calls", nors darbas buvo
ALREADY_IMPLEMENTED (run aada40ec-fa05-4abf-a3b2-cec517cbf97f, w1, attempt a1;
orchestrator.log: „WRITE ACTIVITY LOG FALLBACK ... origin=legacy").

Grandinė: `verify-task.ts:161` (`ports.state.readClaudeLog`) skaito žurnalą
attempt-first per `readClaudeSessionLog`
(`src/composition/quality/diagnose-adapters.ts:83`, kviečiama
`src/composition/loop/coordinator-adapters.ts:353`), bet attempt kataloge
`vq/runtime/runs/<run>/workers/<w>/tasks/<task>/attempts/<a>/logs/claude-last.log`
NIEKADA neatsiranda — ir suveikia fallback į globalų `vq/logs/claude-last.log`,
kurį lygiagretus worker'is perrašo: ALREADY_IMPLEMENTED markeris ir
write-activity įrodymai pralaimi lenktynes.

Šaknis (patikrinta 2026-08-30): `src/composition/agent/dispatch-adapters.ts:130-136`
`resolveAttempt` yra stub'as, VISADA grąžinantis „be attempt'o"
(`reason=no-runtime`) — užfiksuotas nukrypimas `migration-coverage.json`
(2026-08-25 įrašas, „pilnas attempt kanalo vielinimas lieka atviras darbas").
Dėl to `prepareDispatchArtifacts` (`dispatch-artifacts.ts:36`) negauna
`active?.claudeLogPath`, `attemptClaudeLog` lieka `undefined`, ir
`writeClaudeLastLog` (`src/infrastructure/adapters/claude-last-log.ts`) rašo
TIK globalų veidrodį, nors attempt kanalą jau moka.

Sprendimas: įvielinti dispatch'o attempt LOG kanalą — `resolveAttempt`
kompozicijoje per `input.resolution.resolveActiveAttempt(taskId)` (portas jau
perduodamas per `ClaudeDispatchAdapterInput.resolution`) išsprendžia attempt
ref ir `attemptLogPath(runtimeRoot, ref, "claude-last")` kelią, kuris
pasiekia `launchProcess`/finalize `logChannels.attemptPath`. Atmesta
alternatyva: koordinatoriaus kopijavimas iš globalaus veidrodžio po
dispatch'o — lenktynės su kitu worker'iu tuo metu jau gali būti pralaimėtos,
rašyti privalo pats dispatch procesas. Fallback'as skaityme LIEKA kaip
backward compatibility seniems attempt'ams; naujam bėgimui
„WRITE ACTIVITY LOG FALLBACK" eilutė = regresija.

## Agentai
readme-guard -> debugger -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/composition/agent/dispatch-adapters.ts`
- `src/interfaces/cli/dispatch/claude-dispatch/dispatch-ports.ts`
- `src/interfaces/cli/dispatch/claude-dispatch/dispatch-artifacts.ts`
- `src/interfaces/cli/dispatch/claude-dispatch/command.ts`
- `migration-coverage.json` (2026-08-25 P0-1 įrašo papildymas: log kanalas įvielintas)
- `src/tests/interfaces-cli-dispatch-command.test.ts`
- `src/tests/interfaces-cli-dispatch-plan.test.ts`
- `src/tests/task-execution-run-claude-log.test.ts`
- `src/tests/composition-dispatch-attempt-channel.test.ts` (numatomas naujas;
  jei persistinimo integracijos testas natūraliau gula į esamą
  `interfaces-cli-dispatch-command.test.ts` — ten vietoje šio, įrašyti į ataskaitą)

Draudžiama:
- `dist/**`
- `node_modules/**`
- `src/application/task-execution/verify-task.ts` (dispositions/verify taisyklės nekeičiamos)
- `src/application/task-execution/dispositions.ts`
- `src/composition/loop/coordinator-adapters.ts` (skaitymo pusė ir fallback log eilutė lieka kaip yra)
- `src/composition/quality/diagnose-adapters.ts` (readClaudeSessionLog elgesys nekeičiamas)
- `src/infrastructure/adapters/claude-last-log.ts` (dviejų kanalų rašytojas jau teisingas)

## Veiksmas
- `src/composition/agent/dispatch-adapters.ts`: pakeisti `resolveAttempt`
  stub'ą (eil. 130-136) — per `input.resolution.resolveActiveAttempt(taskId)`
  išspręsti attempt'ą ir grąžinti rezultatą, kurio pakanka, kad
  `command.ts` → `launchProcess` (`logChannels.attemptPath`) ir finalize
  kelias gautų attempt-scoped `claude-last` kelią
  (`attemptLogPath(runtimeRoot, ref, "claude-last")` iš
  `src/infrastructure/runtime-paths.ts:280`). KAIP — spręsk pats: arba
  `ResolveAttemptResult` praplėtimas (`dispatch-ports.ts:101`), arba dalinis
  `DispatchAttemptView` su realiu `claudeLogPath`; svarbu, kad likę attempt
  kanalai (decision, promote*, execution-result) NEpakeistų dabartinio
  elgesio — jų vielinimas lieka atviras migration-coverage darbas.
- `src/interfaces/cli/dispatch/claude-dispatch/dispatch-artifacts.ts` /
  `command.ts`: pratekinti attempt log kelią iki `attemptClaudeLog`, kad
  `writeClaudeLastLog` gautų `attemptPath` (rašytojas
  `claude-dispatch-process.ts:82,187` jau naudoja `logChannels` — jo keisti
  nereikia).
- Nesėkmės kryptis fail-open: attempt rezoliucijai nepavykus dispatch'as
  toliau rašo globalų veidrodį su MATOMU warning'u (kaip dabartinės
  `resolveAttempt` warnings eilutės) — log kanalo trūkumas negali stabdyti
  dispatch'o.
- `migration-coverage.json`: papildyti 2026-08-25 įrašą (area
  „interfaces/cli/claude-dispatch — supervisor sprendimo kanalas (0941)...")
  pastaba, kad claude-last LOG kanalas įvielintas šiuo task'u, likusi view
  dalis tebeatvira.
- Testų lūkesčiai: (1) dispatch grandinė su attempt namespace — po proceso
  attempt kataloge yra `logs/claude-last.log` su sesijos srautu ir
  `readClaudeSessionLog` grąžina `origin === "attempt"`; (2) resolveAttempt
  rezultatas pasiekia `launchProcess` `logChannels.attemptPath`
  (`interfaces-cli-dispatch-command.test.ts` jau turi fake view šabloną);
  (3) attempt rezoliucijai nepavykus — global-only rašymas su warning'u,
  be lūžio; (4) seno attempt'o be `claude-last.log` skaitymas toliau
  grįžta per legacy fallback'ą (`task-execution-run-claude-log.test.ts`
  esami atvejai nepakinta).

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei paaiškėtų, kad log
kanalo neįmanoma įvielinti nepakeitus supervisor decision kanalo elgesio
(`readSupervisorDecision` veidrodžio kelias turi likti nepaliestas).

## Neįtraukta
Pilnas `DispatchAttemptView` įvielinimas (decision skaitymas iš attempt
namespace, `promoteExecutionContext`/`promoteContextPack`,
`writeExecutionResult` CAS) — lieka atviras `migration-coverage.json`
2026-08-25 įrašo darbas, atskiras task'as. Dispositions/verify taisyklių
keitimas (`verify-task.ts`, `dispositions.ts`) — draudžiamas šio task'o
apribojimu. `readClaudeSessionLog` legacy fallback'o šalinimas — sąmoningai
paliktas backward compatibility seniems attempt'ams. 066-b-03 parkavimo
rankinis atstatymas iš human-review — operatoriaus veiksmas, ne šio task'o.
