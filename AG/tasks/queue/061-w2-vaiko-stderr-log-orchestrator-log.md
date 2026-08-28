# Task

HUMAN-REVIEW-APPROVED: mindebaltru 2026-08-28 operatoriaus pavedimu („kurk task taisyk verqestra") po visos dienos aklų w2 lūžių GeoGravity projekte

## Spec source
openspec/changes/verqestra-backlog-v1

## Žingsnis 0 — ar jau įgyvendinta?
Jei `src/composition/loop/command.ts` `runChild` nesėkmingo exit atveju jau
log'ina vaiko stderr/stdout uodegą per `deps.log` (`WAVE SLOT CHILD EXIT ...`)
— ALREADY_IMPLEMENTED.

## Tikslas
2026-08-28 GeoGravity projekte w2 worktree vaikai (`process-queued-task`
kopijos medyje) lūžo šimtais bandymų per kelias valandas, o vienintelis
pėdsakas buvo beveidis `task_failed reason=branch-blocked=N`:

```text
runChild: run(process.execPath, [cli, PROCESS_QUEUED_TASK_COMMAND, slot.file], ...)
return result.code === 0;   // stderr ir stdout IŠMETAMI
```

Vaiko stderr niekur nepatenka: jo paties `vq/logs` miršta kartu su procesu
ankstyvo lūžio atveju, o tėvas tikrina tik exit kodą. Rezultatas — šešios
infrastruktūros kliūtys (gitignore, MAX_PATH, buildstamp, CRLF lockfile,
necommit'inta queue, dispatch launch) diagnozuotos rankiniu log'ų
archeologijos darbu vietoj vienos žurnalo eilutės.

Taisymas: `runChild` nesėkmės atveju log'ina vaiko stderr ir stdout uodegą
(apribotą ~4000 simbolių, kad stack trace nepaskandintų orchestrator.log)
kaip `WAVE SLOT CHILD EXIT <code>: slot=<id> task=<id>` eilutę per `deps.log`.

## Agentai
readme-guard -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/composition/loop/command.ts` (runChild)
- `src/tests/composition-loop-command.test.ts` (jei toks yra / numatomas naujas)

Draudžiama:
- `src/application/scheduling/slot-task-runner.ts` (sprendimo logika nesikeičia)
- `dist/**`
- `node_modules/**`

## Veiksmas
- `runChild` po `run(...)`: jei `result.code !== 0`, per `deps.log` įrašyti
  `WAVE SLOT CHILD EXIT <code>` su stderr ir stdout uodegomis (tail ~4000),
  tuščias srautas praleidžiamas be sekcijos.
- Elgsenos grąžinama reikšmė nesikeičia (`result.code === 0`).

## Patikra
- `pnpm typecheck`
- `pnpm lint`
- `pnpm test:only`

## Stop
Commit'ink, kai patikros žalios.

## Neįtraukta
Pačios 7-os kliūties (dispatch launch lūžio w2 kontekste) taisymas — ji bus
diagnozuota iš naujos log eilutės ir taisoma atskiru task'u. Vaiko vq/logs
persistencija į tėvo pusę. Retry/parkavimo politika.
