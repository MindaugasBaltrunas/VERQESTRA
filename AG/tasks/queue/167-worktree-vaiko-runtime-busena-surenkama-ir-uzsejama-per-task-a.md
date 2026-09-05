# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Priklausomybės
- 168-vienas-koordinatoriaus-portu-fabrikas-visiems-trims-iejimams

## Žingsnis 0 — ar jau įgyvendinta?
Jei `src/composition/loop/wave-integration-adapters.ts` harvest'as (dabar `collectWorktreeTelemetry`,
`TELEMETRY_LOG_NAMES` 50 eil.) į pirminį medį perkelia ne tik `context-size.jsonl` ir
`token-usage.jsonl`, bet ir `task-ledger.json`, `retry-counts.json`,
`last-error-signatures.json`, `cheap-finish/*`, `task-events.jsonl`, o
`src/infrastructure/git/worktrees/worktree-runtime.ts` `ensureWorktreeRuntime` kopiją užsėja
to task'o retry būsena — ALREADY_IMPLEMENTED: cituok harvest sąrašą ir seed kelią.

## Tikslas
Pilnas auditas 2026-09-05 (`docs/audits/full-audit-2026-09-05.md`, L6; pilna ataskaita
`audit-composition.md` P1-2, P2-5): worktree vaiko runtime būsena išmetama su kopija.
`wave-integration-adapters.ts:50` surenka tik du telemetrijos žurnalus; vaiko `runtimeRoot` =
`<worktree>/vq` (gitignored, `context.ts:124-131` per `CLAUDE_PROJECT_DIR=worktreeAbs`,
`command.ts:276`), `cleanupWorktree` → `removeTaskWorktree` katalogą ištrina. Prarandama:
`task-ledger.json` (`coordinator-adapters.ts:166-193` `done` įrašas), `retry-counts.json`,
`last-error-signatures.json`, `state/cheap-finish/*.json`, `logs/task-events.jsonl`
(learning emitter + analytics). Pasekmės pirminiame medyje: `ledgerDuplicate`
(`wave-scheduler-adapters.ts:406`, `wave-scheduler.ts:292`) w2+ task'ams niekada `true`;
`release-notes`, `task-ledger-sync`, UI ir learning jų nemato; kopija turi `-a<attempt>`
(`worktree-layout.ts:453`), tad kiekvienas bandymas gauna tuščią `retry-counts.json` →
`MAX_RETRIES_PER_ERROR`, `failedAttempts` (`coordinator-execution-adapters.ts:140-143`) ir
cheap-finish „vieną kartą" galioja per bandymą, ne per task'ą — tas pats task'as w1 elgiasi kitaip.
P2-5: `collectWorktreeTelemetry` (243-244) kelią `"vq","logs"` hardcode'ina; sutampa su
`command.ts:290` tik todėl, kad `RUNTIME_DIR = "vq"` (`context.ts:17`).

Kryptis (audito „Ką daryti pirmiausia" 7): harvest'as = ledger merge, `retry-counts`/
`last-error-signatures` raktinti per task'ą pirminiame medyje, `task-events.jsonl` append; simetriškai
— užsėjimas per task'ą kuriant kopiją, kad bandymas N+1 matytų bandymų 1..N istoriją. Atmesta
alternatyva — vaikui rašyti tiesiai į pirminį `vq/state`: kopijos izoliacija (env išvalymas
`slot-task-runner.ts:117`) yra sąmoninga, o du procesai ant vieno `retry-counts.json` be lock'o yra
būtent tai, ko izoliacija saugo. Priklausomybė nuo 168: abu liečia `command.ts`.

## Agentai
readme-guard -> architect -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/application/scheduling/worktree-runtime-harvest.ts` (numatomas naujas; grynos merge/seed taisyklės be FS)
- `src/composition/loop/wave-integration-adapters.ts` (40-102 harvest, 241-256 keliai per `RUNTIME_DIR`)
- `src/composition/loop/command.ts` (323-346 `prepareWorktree` layout — seed sąrašas; `createWaveIntegrationAdapters` deps)
- `src/infrastructure/git/worktrees/worktree-runtime.ts` (`ensureWorktreeRuntime` layout — state seed kopijavimas)
- `src/tests/scheduling-worktree-runtime-harvest.test.ts` (numatomas naujas)
- `src/tests/composition-wave-integration-adapters.test.ts` (108-145 harvest atvejai)
- `src/tests/worktree-runtime-bootstrap.test.ts`

Draudžiama:
- `src/application/scheduling/wave-integration-step.ts` (harvest'o kvietimo vieta 224 apylinkėse — porto vardas ir semantika „kviečiama prieš cleanup" nekinta)
- `src/application/scheduling/wave-integration-ports.ts` (kontraktas nekinta — praplečiama esamo porto reikšmė)
- `src/infrastructure/git/worktrees/worktree-removal.ts` (kito autoriaus scope)
- `src/composition/loop/coordinator-adapters.ts` (ledger rašytojas vaike nekinta — 173 scope)
- `src/composition/loop/adapters.ts` (`retryCountsStore` nekinta)
- `src/application/scheduling/slot-task-runner.ts` (vaiko env izoliacija nekinta)
- `dist/**`
- `node_modules/**`

## Veiksmas
- Naujas `worktree-runtime-harvest.ts`: grynos funkcijos — `mergeTaskLedger(main, child)` (įrašai
  pagal `task_id`, vaiko naujesnis `updated_at` laimi, ta pati forma kaip `task-ledger-rules`),
  `mergeRetryCounts(main, child)` (per raktą `max`), `mergeErrorSignatures(main, child, taskId)`
  (vaiko reikšmė to task'o raktams), `dedupeEventLines(main, child)` (raktas ts+task_id+event, kaip
  `telemetryLineKey`), `seedFilesForTask(taskId)` (kurie `state/` failai/raktai keliauja į kopiją).
- `wave-integration-adapters.ts`: `collectWorktreeTelemetry` išplečiamas į pilną harvest (vardas
  gali likti — kontraktas nekinta); keliai `path.join(deps.projectRoot, RUNTIME_DIR, ...)` per
  importuotą konstantą (P2-5), ne literalą; kiekvieno failo klaida — `detail`, ne metimas
  (esama taisyklė 253-255); antras kvietimas idempotentinis.
- `worktree-runtime.ts` `ensureWorktreeRuntime`: layout gauna `stateSeed` (failų sąrašas + `taskId`);
  prieš vaiko startą į `<worktree>/vq/state` kopijuojami TIK to task'o raktai iš pirminio
  `retry-counts.json`/`last-error-signatures.json` ir `cheap-finish/<taskId>*.json`; trūkstamas
  šaltinis — tyla. `command.ts:323-346` `prepareWorktree` paduoda `stateSeed` su `slot.task_id`.
- Testai: naujas harvest testas — merge taisyklės (dublikatai, max, naujesnis laimi);
  `composition-wave-integration-adapters.test.ts` — ledger/retry/events surenkami ir antras
  kvietimas nieko nepridėda; `worktree-runtime-bootstrap.test.ts` — seed kopijuoja tik to task'o
  raktus, svetimi raktai nekeliauja.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei paaiškėja, kad `wave-integration-step.ts`
harvest'ą kviečia TIK sėkmingo merge šakoje (parkuoto/refused task'o būsena vis tiek prarastų) —
tada kvietimo vietos perkėlimas yra step'o kontrakto keitimas už šio scope ribų.

## Neįtraukta
- `wave-integration-step.ts`/`wave-integration-ports.ts` kontrakto keitimas (harvest porto
  pervadinimas) — po šio task'o, kai reikšmė jau platesnė.
- Dist perstatymo signalas bangos viduryje (L8) — task 169.
- `orchestrator.log` uodegos surinkimas nesėkmės atveju (`command.ts:289-291`) — jau veikia,
  nekinta.
