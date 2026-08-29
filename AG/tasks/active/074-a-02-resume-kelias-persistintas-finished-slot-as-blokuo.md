# Task

## Spec source
openspec/changes/verqestra-backlog-v1 — audito P1 (2026-08-29): po loop'o lūžio task'as su neintegruota šaka dispatch'inamas iš naujo ir darbas dubliuojamas.

## Tikslas
Atkurti `finishedSlots` būseną iš wave snapshot'o resume metu ir neleisti task'o dispatch'inti iš naujo, kol jo šaka neišspręsta (integruota arba parked). Priklauso nuo jau įgyvendinto `finished_slots` snapshot'o lauko.

Žingsnis 0: jei resume kelias jau skaito `finished_slots` ir blokuoja dispatch'ą — ALREADY_IMPLEMENTED su eilučių įrodymu.

## Agentai
Privaloma grandinė: `readme-guard -> architect -> schedule-domain -> coder -> reviewer -> tester`. readme-guard pirmas.

## Failai
Leidžiama:
- `src/application/scheduling/wave-scheduler-state.ts`
- `src/application/scheduling/wave-scheduler.ts`
- `src/application/scheduling/wave-integration-coordinator.ts`
- `src/tests/scheduling-wave-integration-coordinator.test.ts`

Draudžiama:
- `src/application/scheduling/wave-snapshot.ts`
- `src/infrastructure/git/worktrees/worktree-branch-integration.ts`
- `dist/**`
- `node_modules/**`

## Veiksmas
- `wave-scheduler-state.ts`: pridėk būsenos atkūrimo įėjimą, kuris iš snapshot'o `finished_slots` užpildo `finishedSlots` Map'ą resume metu.
- `wave-scheduler.ts`: atkurtas finished slot'as laiko savo `task_id` neleistiną dispatch'ui, kol integracijos koordinatorius jo neišsprendžia (integruotas arba `parked`).
- Testas: resume su persistintu finished slot'u → task'as NEdispatch'inamas; po išsprendimo → dispatch'as vėl leidžiamas.

## Patikra
- `pnpm typecheck`
- `pnpm test`

## Stop
Commit'ink, kai abi patikros žalios. Stop ir klausk, jei blokavimas reikalautų keisti `wave-scheduler` public kontraktą arba silpninti esamą dispatch testą.

## Neįtraukta
Snapshot schemos keitimai (jau padaryti). Orphan reaper eskalacija (kita užduotis). Merge logika. UI atvaizdavimas (065-b).
