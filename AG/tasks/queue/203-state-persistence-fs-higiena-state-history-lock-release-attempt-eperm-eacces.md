# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Žingsnis 0 — ar jau įgyvendinta?
Jei VISI keturi: `src/infrastructure/state/task-state-store.ts` `moveTaskState` kviečia
`appendStateHistory`; `taskMoveLockReleaseDecision({ state: "absent" }, …)` grąžina `"keep"`;
`src/infrastructure/persistence/runtime-artifact-store.ts` `createAttempt` win32 EPERM/EACCES
NEklasifikuoja `already-exists`; `src/infrastructure/fs/node-fs-adapter.ts` `listFiles`/`listDirectory`/
`listSubdirectories`/`listMarkdownFiles`/`statPath`/`statKind` ne-ENOENT/ENOTDIR klaidas META —
ALREADY_IMPLEMENTED: cituok keturias vietas. Dalinis įgyvendinimas — tikrinti po punktą.

## Tikslas
Pilnas auditas 2026-09-05 (`docs/audits/full-audit-2026-09-05.md`, P2 Infrastructure; infrastructure
F4, F6, F7, F15):
- F4 `state-history.ts:45` `appendStateHistory` neturi produkcinio rašytojo (tik
  `infrastructure-persistence.test.ts:175,182`); skaitytojai `composition/quality/final-audit-adapters.ts:125`
  (`humanReviewResolved`) ir `interfaces/cli/reports/report.ts:152` → `resolveHumanReviewStatus`
  produkcijoje NIEKADA negrąžina `"resolved"` — kanalas miręs. Rašytojas natūraliai gyvena ten, kur
  task'as realiai juda tarp bucket'ų: `task-state-store.ts:322` `moveTaskState`.
- F6 `task-state-store.ts:162-173` `absent → release` (rekursinis `rm`), nors `shared/owned-lock.ts:21-23`
  tą pačią būseną vertina „nežinia NĖRA leidimas trinti". Langas: A stovi > 30 s → B perima (`rename`),
  `mkdir`, dar be `owner.json`; A `finally` skaito `absent` → `rm -r` B katalogo → C laimi → B ir C
  kritinėje sekcijoje. Testas `:61` pin'ina `release`.
- F7 `runtime-artifact-store.ts:112-124`: `createLockDirectory` win32 EPERM/EACCES/EBUSY klasifikuoja
  „exists" (lock semantika, `task-state-store.ts:185-189`), todėl `createAttempt` teisių klaidą praneša
  `already-exists`, o `active-attempt.ts:180-189` bando `nextAttemptId` ir vėl gauna tą patį — diagnozė
  meluoja apie priežastį.
- F15 `node-fs-adapter.ts:135-159,181-213`: `catch {}` ryja EACCES/EIO/EPERM kaip „nėra"; vartotojai
  (`dist-freshness`, `preserved-ref-retention.readPreservedRefRecords`, `orphan-worktree-reaper`) tada
  mato „nieko nėra" ir priima sprendimus (`missing`, `unknown`); antraštė (:19) žada tik nebuvimą.

## Agentai
readme-guard -> debugger -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/infrastructure/state/state-history.ts`
- `src/infrastructure/state/task-state-store.ts` (`moveTaskState` istorijos įrašas, `taskMoveLockReleaseDecision`)
- `src/infrastructure/persistence/runtime-artifact-store.ts` (`createAttempt` katalogo kūrimas)
- `src/infrastructure/fs/node-fs-adapter.ts` (`list*`, `statPath`, `statKind`, naujas `createDirectoryExclusive`)
- `src/tests/infrastructure-persistence.test.ts`
- `src/tests/infrastructure-task-move-lock-contention.test.ts`
- `src/tests/infrastructure-task-state-store.test.ts`
- `src/tests/infrastructure-node-fs-adapter-errors.test.ts` (numatomas naujas; fs adapterio testai rašomi TIK čia — `infrastructure-fs.test.ts` priklauso task 194)

Draudžiama:
- `src/tests/infrastructure-fs.test.ts` (task 194)
- `src/shared/owned-lock.ts` (etalonas, nekinta)
- `src/composition/quality/final-audit-adapters.ts` (skaitytojas nekinta)
- `src/infrastructure/fs/project-containment.ts` (F8 PLAUSIBLE — žr. Neįtraukta)
- `src/infrastructure/state/task-file-locator.ts` (task 202)
- `dist/**`
- `node_modules/**`

## Veiksmas
- F4: `moveTaskState` po sėkmingo `rename` (dar lock'o viduje) kviečia `appendStateHistory(stateHistoryPath(runtimeRoot), …)`
  su `previous_folder`/`next_folder` (bucket'ų vardai), `result`: `"routed"` kai `next === "human-review"`,
  `"resolved"` kai `previous === "human-review"`, kitaip `"moved"`, `reason` iš `options` ar
  `operationName`. Istorijos rašymo nesėkmė perkėlimo NEatšaukia — `process.stderr` eilutė
  (`[task-state-store] state-history append failed: …`). `readStateHistory` korumpuoto failo elgsena
  (meta) lieka — tai sąmoningas fail-closed; antraštėje tai įrašyti.
- F6: `absent → "keep"` (nėra ko trinti; trynimas gali nušluoti perėmėjo katalogą); testas `:61` →
  `"keep"`; `releaseTaskMoveLock` komentaras paaiškina langą.
- F7: `node-fs-adapter.createDirectoryExclusive(dir)` → `"created" | "exists"`, `exists` TIK `EEXIST`,
  kita klaida metama; `createAttempt` (:115) naudoja jį; EPERM tada eina `io` nesėkme su tikra žinute.
  `createLockDirectory` lock semantika NEKINTA (owned-lock/state-file-lock jos reikalauja).
- F15: `list*`/`statPath`/`statKind`: `ENOENT`/`ENOTDIR` → `[]`/`absent`; kiti kodai metami. PRIEŠ
  keičiant Grep visus kvietėjus (`listFiles|listDirectory|listSubdirectories|listMarkdownFiles|statPath|statKind`
  per `src/**`) ir pilnas `pnpm test`: kvietėjas, kuriam „bet kokia klaida = nėra" yra sąmoningas
  (pvz. Windows junction EPERM `worktree-runtime.ts`), įvardijamas ataskaitoje ir gauna savo `try` —
  ne adapterio ryjimą.
- Testai: persistence — `moveTaskState` roundtrip palieka `state-history.json` įrašą, o
  `resolveHumanReviewStatus` po `human-review → queue` grąžina `"resolved"`; lock contention — `absent` →
  `keep`; fs (`infrastructure-node-fs-adapter-errors.test.ts`) — `createDirectoryExclusive` EEXIST vs kita
  klaida; `listFiles` ant failo (ENOTDIR) → `[]`, ant neprieinamo katalogo (chmod 000, praleidžiamas
  win32) → meta; esami `infrastructure-fs.test.ts` testai lieka žali be pakeitimų.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei F15 kvietėjų grep'as parodo daugiau nei du
kvietėjus, kurie sąmoningai remiasi „bet kokia klaida = nėra" — tada F15 skeliamas į atskirą task'ą su
tais failais, o čia lieka F4/F6/F7.

## Neįtraukta
- F8 `project-containment.ts:73-77` `realRoot` kešas neegzistuojančiai šakniai — PLAUSIBLE, reikia
  reprodukcijos (tmp šaknis po symlink'u + `makeDirectory` prieš sukuriant šaknį); atskiras task'as po
  patvirtinimo.
- `readStateHistory` tolerancija korumpuotam JSON — sąmoningai ne.
- `active-attempt.ts:180-189` retry logika — po F7 ji gauna teisingą `io` priežastį, nekeičiama.
