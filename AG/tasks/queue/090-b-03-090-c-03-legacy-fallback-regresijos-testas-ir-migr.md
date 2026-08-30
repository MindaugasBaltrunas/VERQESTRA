# Task

## Spec source
openspec/changes/verqestra-backlog-v1

## Žingsnis 0 — ar jau įgyvendinta?
Jei `src/tests/task-execution-run-claude-log.test.ts` jau turi testą, tvirtinantį, kad attempt'as
BE `logs/claude-last.log` skaitomas per legacy globalų veidrodį (`origin` ne `attempt`), IR
`migration-coverage.json` 2026-08-25 įrašas mini įvielintą claude-last log kanalą —
ALREADY_IMPLEMENTED: cituok testo pavadinimą ir JSON eilutę.

## Tikslas
Priklauso nuo 090-b-02 — vykdyti tik jam užsidarius. Užfiksuoti, kad attempt log kanalo
įvielinimas NEsulaužė backward compatibility seniems attempt'ams, ir užrašyti nukrypimo statusą
ten, kur jis buvo deklaruotas atviras.

## Agentai
readme-guard -> debugger -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/tests/task-execution-run-claude-log.test.ts`
- `migration-coverage.json`

Draudžiama:
- `src/composition/agent/dispatch-adapters.ts`
- `src/interfaces/cli/dispatch/claude-dispatch/command.ts`
- `src/composition/quality/diagnose-adapters.ts`
- `dist/**`
- `node_modules/**`

## Veiksmas
- `task-execution-run-claude-log.test.ts`: pridėk testą — attempt katalogas be `claude-last.log`
  toliau grąžina globalaus veidrodžio turinį per legacy fallback'ą, be lūžio.
- `migration-coverage.json`: papildyk 2026-08-25 įrašą (area „interfaces/cli/claude-dispatch —
  supervisor sprendimo kanalas (0941)...") pastaba, kad claude-last LOG kanalas įvielintas, o
  likusi `DispatchAttemptView` dalis tebeatvira.
- Jokio produkcinio kodo šiame task'e nekeisk.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Sustok ir klausk, jei testas parodo, kad legacy fallback'as sulūžo — tai reiškia regresiją
ankstesniame task'e, taisoma ten, ne testo silpninimu. Commit'ink tik kai `pnpm test` žalias.

## Neįtraukta
Attempt decision, promote-execution-context, promote-context-pack ir execution-result kanalų
vielinimas; `verify-task.ts` dispositions taisyklės; skaitymo pusės fallback eilutės keitimas.
