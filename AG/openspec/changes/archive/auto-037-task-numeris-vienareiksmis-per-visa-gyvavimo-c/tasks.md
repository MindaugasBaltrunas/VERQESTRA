# Tasks

- [x] Perskaityti `readme-guard` ribų santrauką ir šio change'o spec/design/proposal.
- [x] (architect) Suprojektuoti numerio→šeimos žemėlapio pure funkciją: kur ji gyvena (`src/domain/tasks/**` ar `src/application/task-planning/**`), signatūrą ir sąsają su `splitChildParentStemCandidates`/`parentTaskFamily` logika iš `enqueue-child-tasks.ts`.
- [x] (schedule-domain/coder) Įgyvendinti numerio→šeimos žemėlapio funkciją.
- [x] (coder) Sukurti KNOWN kolizijų sąrašą (numeris, abi šeimos, priežastis) remiantis realiu `AG/tasks/*` turiniu 2026-08-26 audito metu.
- [x] (tester) Parašyti `src/tests/task-number-uniqueness.test.ts`: naujos kolizijos aptikimas, pasenusio KNOWN įrašo aptikimas, žalias status quo su teisingu KNOWN sąrašu.
- [x] (coder) Pridėti `numberIsUnique: boolean` parametrą `taskWorkEvidenceGrepArgs` (`src/infrastructure/git/work-evidence.ts`), atnaujinti `WorkEvidenceInput` ir kvietėjus (`taskCommittedProductWorkSha`, `taskCommittedWorkSha`).
- [x] (tester) Regresijos testas: `taskWorkEvidenceGrepArgs(taskId, true)` === senas `taskWorkEvidenceGrepArgs(taskId)` masyvas kiekvienam ne-split-child pavyzdžiui.
- [x] (tester) Naujas testas: `taskWorkEvidenceGrepArgs(taskId, false)` grąžina tik pilno id grep'ą.
- [x] (coder) Įgyvendinti `taskGenerate` skyrimo lenktynių pertikrinimą + ribotą retry (`src/application/task-planning/generate.ts`).
- [x] (tester) Testas, simuliuojantis lygiagretų failo atsiradimą tarp numerio parinkimo ir rašymo; patikrinti retry ir klaidą viršijus limitą.
- [x] (coder) Atnaujinti `enqueue-child-tasks.ts` galvutės komentarą (viena pastraipa apie vartą #1).
- [x] (reviewer) Patikrinti sluoksnių ribas: infrastruktūra negauna naujo fs skaitymo, žinojimas ateina per parametrą.
- [x] (tester) `pnpm typecheck && pnpm test` (lint → build → testai) žali.
- [x] (documenter) Jei reikia, atnaujinti šalia esančią dokumentaciją apie `work-evidence` grep semantiką (komentaras jau faile, patikrinti ar reikia papildyti).

## AG Queue Tasks

- `037-task-numeris-vienareiksmis-per-visa-gyvavimo-cikla` — šis change'as; vykdymo grandinė `readme-guard -> architect -> schedule-domain -> coder -> reviewer -> tester`, failai apriboti iki `src/infrastructure/git/work-evidence.ts`, `src/application/task-planning/**`, `src/application/task-execution/enqueue-child-tasks.ts`, `src/domain/tasks/**`, `src/tests/**`; `AG/tasks/**` esamų failų NEpervadinti.
