# VERQESTRA

Spec-first orchestration framework for bounded AI coding agents — the canonical
rebuild of AG Loop. Every module arrives optimized into the target architecture;
there is no legacy class and no baseline exemption by construction.

Migration source of truth: `D:\React\AG_loop` (read-only behavioural etalon) —
see `AG/openspec/changes/ag-loop-v2-7-architecture-upgrade` there for the plan
(E0–E8), the frozen baseline (VQ-001) and the characterization fixtures the code
in this repository must satisfy verbatim (PAR-1).

## Layout

```text
src/
├── shared/          # primitives: result, errors, ids, json, markdown, hash, paths
├── domain/          # pure rules — no filesystem, no process, no clock
├── application/     # use-cases + ports; IO only through injected ports
├── infrastructure/  # adapters implementing application ports
├── interfaces/      # delivery: cli, hooks, http, ui-model
├── composition/     # manual DI wiring; nothing imports composition
├── tests/           # node --test suites + characterization fixtures
└── cli.ts           # the only entrypoint
```

## Gates — fail-closed from the first commit

| Gate | Rule |
|---|---|
| file-length | every source file ≤ 500 lines, NO baseline |
| boundary | layer import direction (see `src/tests/architecture-gates.test.ts`), zero exceptions |
| classification | every `src/**` file must belong to a known layer/role |
| cycles | module import graph must be acyclic |
| strict TS | `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` in the BASE tsconfig |

`pnpm test` runs the gates with the unit suite; a violation fails the build.

## Commands

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

## Migration coverage

`migration-coverage.json` tracks every live AG_loop module
(`pending | migrated | wont-migrate(reason)`). Cutover (E8) requires 0 `pending`.
The file moves to `vq/state/` when the repo becomes self-hosting (E7).
