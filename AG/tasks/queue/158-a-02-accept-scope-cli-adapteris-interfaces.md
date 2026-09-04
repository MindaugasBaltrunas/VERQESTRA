# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Priklausomybės
- 158-accept-scope-komanda-human-review-isejimas-be-requeue

Prielaida iš Dalies 1: `src/domain/tasks/failai-scope-edit.ts` privalo egzistuoti ir eksportuoti
`acceptScopePaths`. Jei jo nėra — STOP, nekurk jo čia.

## Žingsnis 0 — ar jau įgyvendinta?
Jei `src/interfaces/cli/task-queue/accept-scope.ts` egzistuoja ir
`src/tests/interfaces-cli-task-queue.test.ts` turi jo testus — ALREADY_IMPLEMENTED su citatomis.

## Tikslas
CLI adapteris `accept-scope <task-file-or-name> <path…>`: priima human-review task'ą, įrašo
trūkstamą kelią į `## Failai` per `acceptScopePaths` ir perkelia failą į `done` bucket'ą.

## Agentai
readme-guard -> architect -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/interfaces/cli/task-queue/accept-scope.ts`
- `src/tests/interfaces-cli-task-queue.test.ts`

Draudžiama:
- `src/interfaces/cli/task-queue/requeue.ts`
- `src/interfaces/cli/task-queue/task-move.ts`
- `src/application/task-execution/bucket-transition.ts`
- `src/domain/tasks/failai-scope-edit.ts`
- `src/composition/cli/commands-tasks.ts`
- `dist/**`
- `node_modules/**`

## Veiksmas
- Sekk `requeue.ts` formą: deps `store`, `readTextFile`, `writeTextFile`, `isFile`, `projectRoot`,
  `io`; šaltinis TIK `AG/tasks/human-review/<name>.md`; be argumentų arba ne human-review — exit 2.
- Kiekvienas kelias privalo egzistuoti projekte (`isFile`), kitaip exit 2 — priimamas realus failas,
  ne rašybos klaida; po redagavimo `moveTaskToBucket(store, agRoot, source, "done", name,
  { updateCurrent: false })`; išvestis `accepted: <name> paths=<n>` plius `merge hint: git merge
  --no-ff <šaka>` tik jei šaka jau žinoma iš turimų deps — nespėk.
- Testai `interfaces-cli-task-queue.test.ts`: usage → 2, ne human-review → 2, neegzistuojantis
  kelias → 2, sėkmė → failas `done` bucket'e su pakeistu tekstu ir `accepted:` eilute.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Privaloma nurodyta agentų grandinė. Commit'ink, kai patikros žalios. Stop ir klausk, jei šakos
vardo šaltinis reikalautų naujo porto ar lease store skaitymo — tada „merge hint" lieka be šakos.

## Neįtraukta
- Komandos registravimas `commands-tasks.ts` ir README eilutė — vėlesnės dalys.
- Git merge iš CLI — operatoriaus darbas.
- Bet koks `requeue.ts` ar `bucket-transition.ts` keitimas.
