## Žingsnis 0 — ar jau įgyvendinta?
Prieš keisdamas kodą patikrink, ar ## Tikslas ir ## Patikra jau tenkinami esamame kode.
Jei taip — NEDARYK jokių pakeitimų ir galutinę ataskaitą pradėk atskira eilute:
ALREADY_IMPLEMENTED: <failai/eilutės, įrodančios kad darbas jau padarytas>

## Sandbox taisyklės (privaloma — taupo turns)
- Po BET KOKIO `src` pakeitimo `dist` pasensta ir hook'ai blokuoja bash komandas. Pirma perbuild'ink TIKSLIA forma be pipe/redirect: `pnpm build`
- Patikroms naudok tik: `pnpm build` ir `pnpm test` (be `--`, be pipe į kitas komandas).
- `echo`, `sed`, `node -e` ir kompound komandos su neleistinais segmentais VISADA atmetamos — nekartok jų kitomis formomis; failams skaityti naudok Read/Grep tools.

# Task

## Spec source
openspec/changes/verqestra-backlog-v1
`src/domain/diagnosis/dispositions.ts:256` (`resolveNoCommitReviewReason`)
`src/infrastructure/adapters/claude-tool-schema.ts:177` (`classifyDispatchWriteOutcome`)

## Tikslas
Praplėsti `DiagnosisRulesPort` rašymo-aktyvumo ir priežasties nariais ir surišti juos composition adapteryje su jau esančiomis grynomis funkcijomis. `verify-task.ts` šiame darbe NELIEČIAMAS.

## Agentai
readme-guard -> architect -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/application/task-execution/run-coordinator-ports.ts`
- `src/composition/loop/coordinator-execution-adapters.ts`

Draudžiama:
- `src/application/task-execution/verify-task.ts`
- `src/domain/**`
- `src/infrastructure/**`
- `src/tests/**`
- `node_modules/**`
- `dist/**`

## Veiksmas
- `run-coordinator-ports.ts`: `DiagnosisRulesPort.resolveNoCommitDisposition` įėjimai gauna `writeActivity?: ExecutorWriteActivity` (tipas importuojamas iš `domain/diagnosis/dispositions.js`), o pats port'as — DU naujus narius: `readExecutorWriteActivity(claudeLog: string): ExecutorWriteActivity` ir `resolveNoCommitReviewReason(inputs): string`.
- Abu nauji nariai deklaruojami OPCIONALŪS (`?`) su JSDoc paaiškinimu, kad tai laikina pakopa: privalomais juos padarys sekantis task, kai fake port'ai gaus implementaciją. Privalomas narys dabar sulaužytų `src/tests/helpers/fake-task-run-ports.ts` literalą.
- `coordinator-execution-adapters.ts`: `coordinatorRulesPort` implementuoja abu narius — priežastį per domain `resolveNoCommitReviewReason`, aktyvumą per `classifyDispatchWriteOutcome(extractDispatchToolUsage(claudeLog))` iš `infrastructure/adapters/claude-tool-schema.js`. Jokios naujos logikos adapteryje.

## Patikra
- `pnpm typecheck`
- `pnpm test`

## Stop
Commit'ink, kai abi patikros žalios. Sustok nedelsiant, jei tektų keisti `domain/**` ar `infrastructure/**` (grynos funkcijos jau egzistuoja — jei netinka, tai kontrakto klausimas, ne perrašymo), arba jei naujas narys reikalautų liesti `verify-task.ts`.

## Neįtraukta
- `verify-task.ts` prijungimas ir priežasties eilutės keitimas (sekantis task).
- Fake port'ų implementacija ir nauji testai (sekantis task).
- Skaidymo taisymas (task 033) ir `ALREADY_IMPLEMENTED` semantika.
