# @verqestra/benchmark

Measures what AG Loop actually costs and delivers, against the same agent
running without AG Loop and against a deterministic control. The package is a
separate pnpm workspace member so the thing being measured cannot reach into the
thing measuring it.

Specification: [`AG/openspec/changes/ag-loop-benchmark-v1/spec.md`](../openspec/changes/ag-loop-benchmark-v1/spec.md).
Design: [`design.md`](../openspec/changes/ag-loop-benchmark-v1/design.md).

## Layers

| Layer | Directory | Responsibility |
|---|---|---|
| Domain | `src/domain` | Scenario, sample, metric, baseline and verdict contracts. Pure types and pure functions. |
| Application | `src/application` | Ports and the public `BenchmarkApplicationApi` — validate, run, baseline, compare, report, verify. |
| Infrastructure | `src/infrastructure` | Adapters: Git worktrees, processes, JSONL storage, environment capture, workspace path containment. |
| Interfaces | `src/interfaces` | Delivery contracts: the CLI command surface and, later, the read-only HTTP contract for the UI. |
| Tests | `src/tests` | Unit, contract and architecture-boundary tests. |

## Dependency direction

```text
interfaces ──┐
             ├──> application ──> domain
infrastructure ┘
```

- `domain` depends on nothing but itself. No filesystem, Git, process, HTTP or
  React import may appear in it — a domain that can read a file can be told what
  to conclude by whoever writes that file.
- `application` depends on `domain` and on its own ports. It never imports an
  adapter or a delivery concern; implementations are injected.
- `infrastructure` and `interfaces` implement and call inward. `infrastructure`
  never imports `interfaces`.
- Nothing in this package imports AG orchestrator or UI internals
  (`src`, `dist`, `ag-ui`). Documented AG
  contracts may be used; internal implementation is not an API.
- Consumers import the package barrel (`@verqestra/benchmark`), not deep paths.

`src/tests/architecture-boundaries.test.ts` enforces all of the above on every
`pnpm --dir AG/benchmark test`, so a violation fails the build rather than
waiting for review.

## Commands

```bash
pnpm --dir AG/benchmark typecheck
pnpm --dir AG/benchmark test         # builds, then runs node --test over dist/tests
pnpm --dir AG/benchmark build
pnpm --dir AG/benchmark benchmark:smoke   # the deterministic offline smoke CI runs on every PR
pnpm --dir AG/benchmark benchmark:report  # writes reports/benchmark-report.{json,md}
```

## CI and release gates (BENCH-12)

| Where | What runs | Paid model |
|---|---|---|
| `.github/workflows/ci.yml` (push / pull request) | `pnpm --dir AG/benchmark test` (unit + fixture + suite validation) and `benchmark:smoke` | never — the smoke refuses to declare `--allow-network`, and both networked modes are asserted to be refused without it |
| `.github/workflows/benchmark-full.yml` (manual / scheduled) | the full suite, network modes only when the operator opts in | only behind `workflow_dispatch`, a protected environment and an explicit input |
| `ag final-audit` | `benchmark_evidence` gate over `reports/benchmark-report.json` | never — it only reads the report |

The smoke is `src/interfaces/cli/offline-smoke.ts`: a fixed list of invocations
and the exit code each must answer with. Two of them ask for a networked mode
without permission and are required to be refused, so a regression that made
`--allow-network` optional fails a pull request instead of producing a bill.

## Status

Last verified 2026-08-07 (task 0017, HEAD `88a23a5`). Evidence:
[`verification-2026-08-07.md`](../openspec/changes/ag-loop-benchmark-v1/verification-2026-08-07.md).

Scenarios, the sample store, the isolated runner, the verifier, the metrics, the
baseline, the reports, the read-only HTTP contract, the UI page and the CI and
release gates are implemented, and `pnpm --dir AG/benchmark test` is green
(540 pass, 0 fail, 3 skipped — the symlink-containment cases, which this Windows
host cannot create).

The run pipeline is still not wired into the CLI composition root: `run`,
`baseline create`, `compare`, `report` and `verify` answer
`BenchmarkCapabilityUnavailableError`
(`src/interfaces/cli/benchmark-cli-composition.ts`). So the sample ledger is
empty, `reports/benchmark-report.json` covers **0 samples** with
`verdictBasis: no-baseline`, and **no benchmark number exists yet — none may be
quoted, and no claim about AG Loop's effectiveness may be made from this
package.** Re-running `benchmark:report` does not change that: the generator
renders the ledger, and the ledger has no record.

Task `0017` verified this state; it did not close it, and it is not the task that
will — closing it means wiring the run pipeline (BENCH-011). Until then the
`benchmark_evidence` release gate blocks a completion claim, which is the
intended behaviour rather than a defect. Never hand-edit
`reports/benchmark-report.json`, `scenarios/suite.lock.json` or a baseline
manifest to move that gate.

### Context Compression v2 measurement (task 0029)

The package can now say what a compression feature costs, and does not yet say
it. `src/domain/compression` adds a second dimension beside `ExecutionMode` — a
frozen cohort of nine variants, a canonical variant identity, a fold to tokens
per verified-accepted task, and a rollout verdict — and the report gained a
`## Compression` section. Design and the reasoning behind every rule:
[`docs/context-compression-v2-measurement.md`](docs/context-compression-v2-measurement.md).

**No compression number exists either.** The sample ledger is empty, so every
variant verdict in the generated report is `not_measured`, the JSON report
carries no tokens-per-accepted-task key at all, and the Markdown says no
compression sample has been recorded. Character counters are diagnostics and may
never decide a verdict; a token total is refused outright unless every conclusive
sample in the population reported captured usage. No production flag was turned
on by this task — `vq/config/context-compression.json` still ships every flag
`false`.
