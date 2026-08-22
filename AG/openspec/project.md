# VERQESTRA OpenSpec

## Purpose

Spec-first orkestratorius apribotiems AI kodavimo agentams. Produktas paima užduotį, surenka
jai kontekstą, paleidžia agentą su griežtomis ribomis, patikrina rezultatą vartais ir tik tada
leidžia jam patekti į git istoriją. Kanoninis AG Loop perstatymas švaria architektūra.

## Architecture

Sluoksniai ir jų kryptis (tikrina `src/tests/architecture-gates.test.ts`):

```text
domain          → domain, shared
application     → application, domain, shared
infrastructure  → infrastructure, application, domain, shared
interfaces      → interfaces, application, domain, shared      (NE infrastructure)
composition     → viskas
```

- `domain` neturi JOKIO `node:` importo — net `node:path`.
- IO visada per portus; portai deklaruojami `application`, realizuojami `infrastructure`,
  surišami `composition`. Jokio importo iš `composition` į kitą pusę.
- Kiekvienas `src` failas ≤ 500 eilučių, be baseline išimčių.
- Importų grafas aciklinis, įskaitant type-only ryšius.

Atskiri workspace paketai: `AG/benchmark` (matuoja orkestratorių per CLI, jo šaltinių
neimportuoja — BENCH-1) ir `ui-app` (React dashboard'as).

## Conventions

- TypeScript strict + `exactOptionalPropertyTypes` + `noUncheckedIndexedAccess`; jokio naujo
  `any` ar `@ts-ignore` be techninio pagrindimo.
- Tik LF, be NUL, NFC normalizacija.
- Runtime keliai `vq/{state,config,logs,project,architecture,generated}`; darbo eilė ir spec
  kontraktai lieka `AG/{tasks,spec,openspec,benchmark}`.
- Testai neweakinami, kad praeitų: jei testas teisus, o kodas ne — taisomas kodas.
- Komanda egzistuoja tik tada, kai ji yra `src/composition/cli-registry.ts` registre IR
  README `## Main Commands` sąraše. `readiness-audit` tikrina abi kryptis.

## Acceptance Gates

```bash
pnpm typecheck
pnpm test          # lint → build → testai
pnpm test:benchmark
pnpm typecheck:ui && pnpm test:ui
```

Papildomai prieš išleidimą: `verqestra build-gate`, `verqestra quality-gates`,
`verqestra milestone-check`, `verqestra release-check`, `verqestra readiness-audit`.
