# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Priklausomybės
- 197-preserved-ref-gamintojas-raso-task-id-ir-reconcile-prijungtas-prie-retencijos

## Žingsnis 0 — ar jau įgyvendinta?
Jei `src/infrastructure/git/preserved-ref-retention.ts` ir
`src/infrastructure/git/worktrees/orphan-worktree-reaper.ts` task'o bucket'ą sprendžia per VIENĄ bendrą
funkciją (`infrastructure/state/task-file-locator.ts` ar lygiavertę), kuri atpažįsta
`task-state-store.ts` `uniquePathUnderLock` kolizijos formą `<id>-<n>.md` — ALREADY_IMPLEMENTED: cituok
abu importus.

## Tikslas
Pilnas auditas 2026-09-05 (`docs/audits/full-audit-2026-09-05.md`, P2 Infrastructure; infrastructure
F13). `preserved-ref-retention.ts:89-97` `locateTaskBucket` ieško tik `AG/tasks/<bucket>/<taskId>.md`;
`orphan-worktree-reaper.ts:86-92` `resolvedTaskBucket` lygina `basename(file, ".md") === taskId`.
`task-state-store.ts:191-203` `candidateCollisionPath`/`uniquePathUnderLock` kolizijai duoda
`<id>-2.md`, `<id>-3.md`… Po kolizijos retencija task'o neranda → `unknown` → `unknown-task-status` →
ref'as laikomas AMŽINAI; orphan eskalacija (:125-128) `bucket === undefined` → task'as „dingęs" →
kopija ESKALUOJAMA. Ta pati klaida, priešingi poveikiai dviejuose moduliuose. Kryptis: vienas
`locateTaskFile(agRoot, taskId)` → `{ bucket, path } | undefined` (`infrastructure/state`, greta
kolizijos gramatikos šaltinio): pirma tikslus `<id>.md`, tada TIK `<id>-<n>.md` su plikais sveikais
`n ≥ 2` BE vedančio nulio (kolizijos forma), kad zero-padded task id dalys (`105-a-02` nėra `105-a`
kolizija) nebūtų supainiotos. Priklausomybė nuo 197: tas task'as keičia `preserved-ref-retention.ts`.

## Agentai
readme-guard -> debugger -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/infrastructure/state/task-file-locator.ts` (numatomas naujas)
- `src/tests/infrastructure-task-file-locator.test.ts` (numatomas naujas)
- `src/infrastructure/git/preserved-ref-retention.ts` (`locateTaskBucket` per locator)
- `src/infrastructure/git/worktrees/orphan-worktree-reaper.ts` (`resolvedTaskBucket` per locator)
- `src/tests/infrastructure-preserved-ref-retention.test.ts`
- `src/tests/infrastructure-orphan-reaper.test.ts`

Draudžiama:
- `src/infrastructure/state/task-state-store.ts` (task 203; kolizijos gramatika skaitoma, ne keičiama)
- `src/infrastructure/git/worktrees/worktree-reaper.ts` (task 198)
- `src/tests/infrastructure-worktrees.test.ts` (task 198)
- `dist/**`
- `node_modules/**`

## Veiksmas
- `task-file-locator.ts`: `locateTaskFile(agRoot, taskId, buckets = taskBuckets)` — kiekviename bucket'e
  `nodeFsAdapter.listMarkdownFiles`; kandidatas tinka, kai stem `=== taskId` ARBA
  `/^<escaped id>-([1-9]\d*)$/` su `n ≥ 2`; grąžina pirmą pagal bucket'ų tvarką; taskId validuojamas
  `[A-Za-z0-9._-]+` (kitaip `undefined`). Eksportuoti ir `taskBucketOf(agRoot, taskId)` → bucket | undefined.
- `preserved-ref-retention.ts` `locateTaskBucket` → per locator: `done` → `"done"`, kitas bucket'as →
  `"not-done"`, `undefined` → `"unknown"`; `orphan-worktree-reaper.ts` `resolvedTaskBucket` → `taskBucketOf`.
- Testai: locator — `042.md`, `042-2.md` (randa kolizijos formą kai tikslaus nėra), `105-a-02.md` NĖRA
  `105-a` atitikmuo, `042-02.md` NĖRA `042` kolizija, tuščias/neegzistuojantis bucket'as → undefined;
  retencija — įrašas task'ui, kurio failas `done/<id>-2.md` → `done` → `expired`; orphan — kopija task'ui su
  `queue/<id>-2.md` (jaunas) → NEeskaluojama (bucket'as rastas, ne `done`).

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei rasi trečią bucket'o paiešką pagal `<id>.md` už
scope ribų (Grep `\`${taskId}.md\`` per `src/**`) — ją įvardyk ataskaitoje kaip atskirą task'ą, čia
neliesk.

## Neįtraukta
- Kolizijos gramatikos keitimas `task-state-store.ts` (pvz. tapatybė iš turinio, ne vardo) — task 203
  scope'e tas failas, bet ši tema atskira.
- `orphan-worktree-reaper.ts` amžiaus vartų ir archyvo logika — nekinta.
