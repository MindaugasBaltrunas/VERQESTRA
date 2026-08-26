# Tasks

- [ ] Perskaityti `readme-guard` ribų santrauką ir šio change'o spec/design/proposal.
- [ ] (architect) Suprojektuoti numerio→šeimos žemėlapio pure funkciją: kur ji gyvena (`src/domain/tasks/**` ar `src/application/task-planning/**`), signatūrą ir sąsają su `splitChildParentStemCandidates`/`parentTaskFamily` logika iš `enqueue-child-tasks.ts`.
- [ ] (schedule-domain/coder) Įgyvendinti numerio→šeimos žemėlapio funkciją.
- [ ] (coder) Sukurti KNOWN kolizijų sąrašą (numeris, abi šeimos, priežastis) remiantis realiu `AG/tasks/*` turiniu 2026-08-26 audito metu.
- [ ] (tester) Parašyti `src/tests/task-number-uniqueness.test.ts`: naujos kolizijos aptikimas, pasenusio KNOWN įrašo aptikimas, žalias status quo su teisingu KNOWN sąrašu.
- [ ] (coder) Pridėti `numberIsUnique: boolean` parametrą `taskWorkEvidenceGrepArgs` (`src/infrastructure/git/work-evidence.ts`), atnaujinti `WorkEvidenceInput` ir kvietėjus (`taskCommittedProductWorkSha`, `taskCommittedWorkSha`).
- [ ] (tester) Regresijos testas: `taskWorkEvidenceGrepArgs(taskId, true)` === senas `taskWorkEvidenceGrepArgs(taskId)` masyvas kiekvienam ne-split-child pavyzdžiui.
- [ ] (tester) Naujas testas: `taskWorkEvidenceGrepArgs(taskId, false)` grąžina tik pilno id grep'ą.
- [ ] (coder) Įgyvendinti `taskGenerate` skyrimo lenktynių pertikrinimą + ribotą retry (`src/application/task-planning/generate.ts`).
- [ ] (tester) Testas, simuliuojantis lygiagretų failo atsiradimą tarp numerio parinkimo ir rašymo; patikrinti retry ir klaidą viršijus limitą.
- [ ] (coder) Atnaujinti `enqueue-child-tasks.ts` galvutės komentarą (viena pastraipa apie vartą #1).
- [ ] (reviewer) Patikrinti sluoksnių ribas: infrastruktūra negauna naujo fs skaitymo, žinojimas ateina per parametrą.
- [ ] (tester) `pnpm typecheck && pnpm test` (lint → build → testai) žali.
- [ ] (documenter) Jei reikia, atnaujinti šalia esančią dokumentaciją apie `work-evidence` grep semantiką (komentaras jau faile, patikrinti ar reikia papildyti).

## AG Queue Tasks

- `037-task-numeris-vienareiksmis-per-visa-gyvavimo-cikla` — šis change'as; vykdymo grandinė `readme-guard -> architect -> schedule-domain -> coder -> reviewer -> tester`, failai apriboti iki `src/infrastructure/git/work-evidence.ts`, `src/application/task-planning/**`, `src/application/task-execution/enqueue-child-tasks.ts`, `src/domain/tasks/**`, `src/tests/**`; `AG/tasks/**` esamų failų NEpervadinti.
