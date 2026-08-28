# Task

HUMAN-REVIEW-APPROVED: mindebaltru 2026-08-28 operatoriaus pavedimu — GeoGravity w1/w2 worktree vaikai lūžo „tool budget not found" iškart po delegavimo

## Spec source
openspec/changes/verqestra-backlog-v1

## Žingsnis 0 — ar jau įgyvendinta?
Jei `WorktreeRuntimeLayout` turi `configDirs`, `ensureWorktreeRuntime` juos
kopijuoja rekursyviai, o `src/composition/loop/command.ts` perduoda
`vq/config` katalogą — ALREADY_IMPLEMENTED.

## Tikslas
2026-08-28 GeoGravity: po 061 stderr log'o pirmoji reali w2 (ir worktree
w1) lūžio priežastis pasirodė esanti:

```text
process-queued-task: tool budget not found: <worktree>\vq\config\tool-budget.json
```

Bootstrap'as kopijavo TIK `vq/config/local.env` (`configFiles` sąrašas su
vienu failu), o `loadToolBudget` fail-closed reikalauja
`vq/config/tool-budget.json`. Ta pati klaida jau buvo atrasta
benchmark-loop-cell 2026-08-22 („Aprūpinama VISA konfigų aibė, o ne po
failą") — bet worktree bootstrap'as liko su senu sąrašu.

Taisymas: layout gauna `configDirs?: readonly string[]`; bootstrap'as juos
kopijuoja rekursyviai (`cp recursive`, idempotentiškai perrašant);
kompozicija perduoda visą `vq/config`. `configFiles` paliekamas dėl
suderinamumo.

## Agentai
readme-guard -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/infrastructure/git/worktrees/worktree-runtime.ts`
- `src/composition/loop/command.ts` (tik layout eilutės)
- `src/tests/worktree-runtime-bootstrap.test.ts`

Draudžiama:
- `src/application/**`
- `dist/**`
- `node_modules/**`

## Veiksmas
- `WorktreeRuntimeLayout.configDirs` + rekursyvi kopija po `configFiles`
  ciklo (nesantis šaltinio katalogas — švarus praleidimas).
- Kompozicijoje `configDirs: [vq/config]` (santykinis nuo projectRoot).
- Testas: katalogas su `tool-budget.json` ir įdėtu pakatalogiu atsiranda
  kopijoje; `local.env` paritetas išlieka.

## Patikra
- `pnpm typecheck`
- `pnpm lint`
- `pnpm test:only`

## Stop
Commit'ink, kai patikros žalios.

## Neįtraukta
`.claude/agents` kopijavimas (vaiko preflight'ui jo užteko iš checkout);
AG/config (versijuojamas, ateina su checkout); benchmark provisioning
kelias (jau turi savo pilną aprūpinimą).
