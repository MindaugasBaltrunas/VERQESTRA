# Verification run 2026-08-07 — BENCH-016 (queue task 0017)

Verdict: **blocked**. Closure was not taken.

- HEAD: `88a23a5c1fe5b6cb188e08276bc74a4085a103d4`
- Host: Windows 11, Node `v24.11.0`, 16 CPUs
- Chain: `readme-guard → reviewer → security → tester → supervisor`

This file is the evidence a checkbox in [`tasks.md`](tasks.md) may be checked against. It
records what was executed and what came back, including the failures. Nothing here is a
claim about AG Loop's effectiveness: no benchmark number exists yet (see § Benchmark
evidence), so no such claim is possible, and the "best on the market" claim the
[proposal](proposal.md) § *Ne pažadas* bans is not made.

## Commands executed

| Command | Repetitions | Result |
|---|---|---|
| `pnpm --dir AG/benchmark test` | 2 | ✅ 543 tests: 540 pass, 0 fail, 3 skipped |
| `pnpm --dir . test` | 1 | ✅ 2369 / 2369, 0 fail, 0 skipped |
| `pnpm --dir ./ui-app test` | 4 | ❌ **3 failures in 4 runs** |
| `pnpm --dir ./ui-app build` | 1 | ✅ pass |
| `ag release-check` | 1 | ✅ `ok`, `failed_parts: none` |
| `ag final-audit --json` | 1 | ❌ `not_complete` |
| `ag converge` | 0 | ⛔ not executable from this session (below) |

The 3 skipped benchmark tests are the symlink-containment cases, each skipped with the
stated reason `this host does not permit creating symbolic links`:

| Test | File |
|---|---|
| `a symbolic link out of the checkout is refused, whether it is the target or a parent` | `src/tests/workspace-file-writer.test.ts:104` |
| `a symbolic link inside a fixture is refused, not followed` | `src/tests/fixture-repository.test.ts:184` |
| `a fixture directory that is itself a symbolic link is refused` | `src/tests/fixture-repository.test.ts:218` |

All three are symlink variants of containment rules already proven on this host by their
non-symlink paths, and they execute on the `ubuntu-latest` leg of `ci.yml`. They are
skipped, not weakened.

### Commands the task specified that could not be run as written

The task's `## Patikra` names `node dist/cli.js <command>`. That form is a
deliberate hard block in `src/policy/bash-policy.ts`, pinned by
`bash-policy-variants.test.ts` ("dist runtime nuoroda lieka hard-block, net su leidžiama
subkomanda"). The allowlisted equivalents `ag release-check` and `ag final-audit --json`
were used instead and are equivalent.

`ag converge` has **no** allowlisted form — neither the `dist` path nor the `ag` wrapper.
It was therefore not run directly. Its verdict was read from the `converge` gate that
`final-audit` evaluates internally, which is the same computation. No bypass was attempted.

## The UI regression: `ui-app` is not three-times green

`src/view/pages/BenchmarkPage.test.tsx > BenchmarkPage > "shows regression reasons and lets
a scenario be selected for drill-down"` failed on runs 1, 3 and 4 of 4:

```text
TestingLibraryElementError: Found multiple elements with the text:
  a new security violation appeared
```

Root cause: once the page has settled, the scenario's reason string is rendered **twice** —
once in the *Regression reasons* panel (`BenchmarkPage.tsx`, the `benchmark-regression-list`
section) and once in the drill-down of the scenario that the auto-selection effect picks
(`setSelectedScenarioKey(key(scenarios[0]))`). The test asserts with a singular
`getByText`, so whether it passes depends on whether the assertion lands before or after
that effect commits. The page is not wrong; the assertion is ambiguous by construction.

The fix belongs in `./ui-app/src/**` — either `getAllByText` in the test, or
scoping the query to the regression panel. Task 0017 explicitly forbids editing that path,
so this was **reported, not applied, and not worked around**. Re-running until a green run
appears would satisfy the letter of "three green runs" and falsify its point.

## `final-audit` gates

Two runs are recorded: the first against the untouched tree, the second against the tree
this task delivers. The second is the one that describes what is being committed.

| Gate | Before edits | After edits | Detail |
|---|---|---|---|
| `queue_empty` | ❌ | ❌ | 38 pending task files: 36 in `queue`, `delegated/0017` (this task), `human-review/0018` |
| `converge` | ❌ (4 issues) | ❌ (**6 issues**) | see below |
| `readiness` | ❌ | ✅ **fixed here** | was `commands:documentation:benchmark` |
| `backlog` | ✅ | ✅ | — |
| `release_check` | ✅ | ❌ **self-inflicted** | `release-check-result is stale: openspec`, `release-check-result is stale: source` |
| `rule_status` | ✅ | ✅ | — |
| `architecture_boundary` | ✅ | ✅ | — |
| `benchmark_evidence` | ❌ | ❌ | 0 samples; no baseline |

**`release_check` is ❌ in the delivered tree, and that is this task's own doing.**
`computeSourceState` hashes `README.md` and `checkReleaseFreshness` walks
`AG/openspec/changes`; this task edited both after `ag release-check` ran, so the stored
result now predates the source it describes. The check itself reported `ok` when it ran —
the *gate row* is what went stale. It clears when `ag release-check` is re-run after these
edits land, which is the orchestrator's normal post-commit step. Re-running it here would
only re-stale on the next doc edit, so the honest record is this row, not a green one.

**`converge` grew from 4 issues to 6, also this task's own doing.** Adding BENCH-017 and
BENCH-018 to `tasks.md` created two open OpenSpec items with no task file in any bucket:

```text
incomplete-work:delegated/0017-benchmark-final-verification-and-closure.md
incomplete-work:human-review/0018-remove-dead-log-api-and-trim-dashboard-payload.md
missing-task:bench-017-priri-ti-benchmark-reporto-provenance-prie-var
missing-task:bench-018-priri-ti-paid-model-arguments-prie-cli-opcij-l
stale-status:project/next-tasks.md
stale-status:project/status.md
```

Creating queue task files is orchestrator-owned and out of this task's scope, so the two
`missing-task` rows are **disclosed and routed, not resolved** — see § Routing. The
alternative, leaving the two findings out of `tasks.md` to keep converge at 4 issues, would
have traded a visible gap for an invisible one.

The 36 queued files are the `0018`–`0030` context-compression wave (13) and the
`1134`–`1159` mobile wave (23) — **unrelated to this change**. Counting `human-review/0018`
and excluding this task's own `delegated` slot, 37 pending files are unrelated to
`ag-loop-benchmark-v1`. Per the task's own instruction, closure is left open rather than
being declared around them.

### README authoring trap hit while fixing `readiness`

Worth recording so the next task does not rediscover it. The first draft of the benchmark
section put `pnpm --dir AG/benchmark benchmark:report` in a bash block under `## First run`.
That turned `pnpm --dir . test` red: `package-manager-docs.test.ts`'s
`README first-run commands reference real orchestrator scripts` collects every `^pnpm `
line in that section and takes the **first token after `pnpm`** as a script name, so it
asserted that `.` has a `--dir` script. The command moved into prose and the
suite returned to 2369/2369. Code blocks under `## First run` must use the
`npm run ag -- <command>` form; a `pnpm --dir …` example belongs outside that section or in
inline prose.

### `readiness` — fixed

`ag benchmark` was registered in `command-registry.ts` but missing from the README
`## Main Commands` table, which is the exact text `parseReadmeMainCommands`
(`src/orchestrator/readiness-audit.ts`) parses. Adding it to the *Quality & release* row
resolves the gate. This is the same defect class the 2026-08-06 run fixed for
`optimization-benchmark`.

### `converge` stale-status — NOT fixed, and deliberately not faked

`AG/project/status.md` and `AG/project/next-tasks.md` are generated by
`src/interfaces/cli/project-status.ts` via `ag project-status`, which is not on the
bash-policy allowlist and so cannot run from a Claude session. Two things were available
and both were rejected:

- Hand-writing the files would put invented queue counts into artifacts that
  `release-notes.ts` and `github-pr.ts` read as fact.
- The staleness test is an mtime comparison, so merely touching the files would clear the
  gate while changing nothing. That is gaming the gate.

Regenerating them is an orchestrator or human-terminal step: `ag project-status`.

## Benchmark evidence

`AG/benchmark/reports/benchmark-report.json` exists and is attributed to the current
commit, but reports:

- verdict `inconclusive`, basis `no-baseline`
- `sampleCount: 0`, no `configHash`, no `policyHash`
- no mode compared, no scenario compared

`ag final-audit` blocks on exactly this, with the two `benchmark evidence is incomplete`
messages. **This is the gate working, not a defect.**

The cause is upstream: `src/interfaces/cli/benchmark-cli-composition.ts` refuses `run`,
`createBaseline`, `compare`, `report`, `verify`, `loadBaseline` and `loadCurrentSummary`
with `BenchmarkCapabilityUnavailableError(RUN_PIPELINE_PROVIDER)`. Nothing can populate the
sample ledger, so the report renders an empty ledger honestly. Re-running
`benchmark:report` cannot change the outcome.

Consequently the task's "at least three repetitions where the explicit benchmark mode
allows" was executed to the extent the mode allows: **zero benchmark repetitions are
possible**, because `run` is refused before any repetition count is read. The three-way
repetition statistics themselves are covered by unit tests (BENCH-010), not by a live run.

## Why closure was not taken

Three independent conditions each block BENCH-016 on their own:

1. The benchmark measured 0 samples with no baseline — the central acceptance criterion
   ("reportas šviežias") cannot be met by a report that measured nothing.
2. `ui-app` is not green three times running.
3. 37 unrelated task files are still pending, so `final-audit` cannot report `complete`.

A fourth blocker surfaced during this run's review and is recorded in [`tasks.md`](tasks.md):

4. **BENCH-010 has no tests at all.** `summarizeDistribution`, `compareScenario` and
   `compareBenchmark` are imported by no test in `src/tests/**`; `compareBenchmark` has no
   caller anywhere and is not exported from the barrel. Its acceptance criterion is
   literally "…taisyklės ištestuotos", so the checklist could not have been honestly
   closed even if the other three blockers were absent.

## Checklist outcome

`[x]` — BENCH-001…009, 012, 013, 015 (**12 of 16**), each with per-item evidence.
`[ ]` — BENCH-010 (no tests), BENCH-011 (run pipeline unwired), BENCH-014 (flaky test),
BENCH-016 (this item).

Two follow-up items were added by this audit rather than silently absorbed: **BENCH-017**
(the `benchmark_evidence` gate verifies no hash or provenance, and the report it reads is
gitignored, so a hand-written report would be accepted at face value and would reach the
committed release proof) and **BENCH-018** (the paid-model flag list is a hand-maintained
mirror that nothing pins to the CLI option table).

## Routing

| Work | Agent | Scope it needs |
|---|---|---|
| BENCH-010 domain tests; `BenchmarkPage.test.tsx` query fix | `tester` | must include `./ui-app/src/**` |
| BENCH-011 run-pipeline wiring | `architect` | its own change; unblocks 012's real path, 016 |
| **Queue task files for BENCH-017 and BENCH-018** | orchestrator | `ag task-generate` — required to clear the two `missing-task` converge issues this audit created |
| Regenerate `AG/project/status.md` + `next-tasks.md` | orchestrator / human terminal | `ag project-status` |
| Re-run `ag release-check` after this commit | orchestrator | clears the two self-inflicted `stale:` rows |
