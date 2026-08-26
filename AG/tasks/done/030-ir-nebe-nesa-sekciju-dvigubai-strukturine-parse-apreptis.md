### Repair Task (kontekstas)
## Tikslas
Pataisyk aiškią lokalią implementacijos klaidą.

## Agentas
debugger

## Klaida
clear local issue: AssertionError [ERR_ASSERTION]: IR average 2703.0 chars vs raw average 2277.2 chars over 57 task file(s) is a 18.7% duplication (limit 2%) — a structured sectio

## Veiksmas
Remkis vq/logs/checks-last.log ir pataisyk tik šios užduoties allowed paths apimtyje.

## Patikra
- `pnpm typecheck`
- `pnpm test`
## Stop
Sustok, kai patikros praeina.

## Neįtraukta
- Model-based diagnosis.
- Rollback.

## Failai
Leidžiama:
- `src/application/context-pack/worker-task-ir.ts`
- `src/application/context-pack/worker-task-ir-schema.ts`
- `src/application/context-pack/compact-dsl/**`
- `src/tests/**`

Draudžiama:
- `AG/**` (etalonas read-only)
- `vq/**`
- `.env`

## Spec source
docs/audits/ (kompresoriaus auditas 2026-08-26)
src/application/context-pack/worker-task-ir.ts (NO SILENT LOSS taisyklė)
AG/openspec/changes/auto-030-ir-nebe-nesa-sekciju-dvigubai-strukturine-pars/spec.md

## Cheap finish
Ankstesnis bandymas paliko dalinį darbą. Pataisyk TIK šią klaidą, nieko neperrašinėk:
AssertionError [ERR_ASSERTION]: IR average 2486.4 chars vs raw average 2277.2 chars over 57 task file(s) is a 9.2% duplication (limit 2%) — a structured section
Repair kontekstas:
### Repair Task (kontekstas)
## Tikslas
Pataisyk aiškią lokalią implementacijos klaidą.

## Agentas
debugger

## Klaida
clear local issue: AssertionError [ERR_ASSERTION]: IR average 2486.4 chars vs raw average 2277.2 chars over 57 task file(s) is a 9.2% duplication (limit 2%) — a structured section

## Veiksmas
Remkis vq/logs/checks-last.log ir pataisyk tik šios užduoties allowed paths apimtyje.

## Patikra
- `pnpm typecheck`
- `pnpm test`
## Stop
Sustok, kai patikros praeina.

## Neįtraukta
- Model-based diagnosis.
- Rollback.

## Failai
Leidžiama:
- `src/application/context-pack/worker-task-ir.ts`
- `src/application/context-pack/worker-task-ir-schema.ts`
- `src/application/context-pack/compact-dsl/**`
- `src/tests/**`

Draudžiama:
- `AG/**` (etalonas read-only)
- `vq/**`
- `.env`

## Spec source
docs/audits/ (kompresoriaus auditas 2026-08-26)
src/application/context-pack/worker-task-ir.ts (NO SILENT LOSS taisyklė)
AG/openspec/changes/auto-030-ir-nebe-nesa-sekciju-dvigubai-strukturine-pars/spec.md
