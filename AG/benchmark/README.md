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
| `.github/workflows/ci.yml` (push / pull request) | `pnpm test:benchmark` (unit + fixture + suite validation) and `pnpm smoke:benchmark` | never — the smoke refuses to declare `--allow-network`, and both networked modes are asserted to be refused without it |
| `.github/workflows/benchmark-full.yml` (manual / scheduled) | two jobs: the whole suite offline (`deterministic-control`) on a schedule and on dispatch, and the networked modes only on dispatch | the paid job requires all three of `workflow_dispatch`, `allow_network: true` and the protected `benchmark-paid` environment; the schedule can never reach it |
| `ag final-audit` | `benchmark_evidence` gate over `reports/benchmark-report.json` | never — it only reads the report |

The smoke is `src/interfaces/cli/offline-smoke.ts`: a fixed list of invocations
and the exit code each must answer with. Two of them ask for a networked mode
without permission and are required to be refused, so a regression that made
`--allow-network` optional fails a pull request instead of producing a bill.

Both rows above were written before either was true. `ci.yml` ran the package's
tests but never the smoke, and `benchmark-full.yml` did not exist at all, so from
2026-08-07 until 2026-08-22 this table described a CI contract nothing executed —
and the one check whose whole purpose is to stop an accidental bill was the one
not running. A gate stated in a README and absent from CI is a promise, not a
gate; that is the reason this paragraph names the gap rather than quietly
dropping it.

## Status

Last verified 2026-08-22 (VQ-802). `pnpm --dir AG/benchmark test` is green:
734 tests, 731 pass, 3 skipped — the symlink-containment cases, which this
Windows host cannot create.

Scenarios, the sample store, the isolated runner, the verifier, the metrics, the
baseline, the reports, the read-only HTTP contract, the UI page and the CI and
release gates are implemented. **The run pipeline is wired**: `run`,
`baseline create`, `compare`, `report` and `verify` execute against the authored
suite and the run ledgers of this package. That closes what this section
described as open until 2026-08-22 — the text below it claimed those commands
answered `BenchmarkCapabilityUnavailableError`, which stopped being true and was
not noticed, because nothing fails when a README goes stale.

### What has been measured

A three-scenario pilot on 2026-08-22 (`bugfix-i18n-missing-key`,
`refactor-summary-duplication`, `security-log-session-tokens`), both networked
modes, three repetitions:

| scenario | mode | accepted | billable tokens (median) |
|---|---|---|---|
| bugfix-i18n-missing-key | ag-loop | 3/3 | 41 183 |
| bugfix-i18n-missing-key | agent-solo | 3/3 | 15 487 |
| refactor-summary-duplication | ag-loop | 3/3 | 34 599 |
| refactor-summary-duplication | agent-solo | 3/3 | 12 868 |
| security-log-session-tokens | agent-solo | 0/3 | 15 959 |
| security-log-session-tokens | ag-loop | refused before dispatch | 0 |

These are three scenarios out of twenty-four. **They are not a suite result and
no claim about the loop's effectiveness may be drawn from them** — they are the
evidence that the pipeline measures what it says it measures. The full suite has
not been run.

No baseline is comparable yet: the two committed ones predate the manifest
schema this build reads (`baselines/README.md` states why), so
`benchmark-report.json` still renders with `verdictBasis: no-baseline` and the
`benchmark_evidence` release gate still blocks a completion claim. That is the
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
