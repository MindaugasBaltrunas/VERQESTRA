# VERQESTRA

Spec-first orchestration framework for bounded AI coding agents — the canonical
rebuild of AG Loop. Every module arrived already shaped for the target architecture:
there is no legacy class and no baseline exemption by construction.

The behavioural etalon was `D:\React\AG_loop` (read-only); its migration plan lives in
`AG/openspec/changes/ag-loop-v2-7-architecture-upgrade` there (E0–E9, the frozen
baseline VQ-001 and the characterization fixtures this code satisfies verbatim). The
migration is complete — see [Migration coverage](#migration-coverage).

## Layout

```text
src/
├── shared/          # primitives: result, errors, ids, json, markdown, hash, paths, exit codes
├── domain/          # pure rules — no filesystem, no process, no clock, no `node:` imports
├── application/     # use-cases + ports; IO only through injected ports
├── infrastructure/  # adapters implementing application ports (git, fs, process, state)
├── interfaces/      # delivery: cli, hooks, http, ui-model
├── composition/     # manual DI wiring; nothing imports composition
│   ├── cli/         #   command registry + command groups
│   ├── hooks/       #   Claude Code hook wiring
│   ├── ui/          #   operator UI server, router, SSE
│   ├── loop/        #   wave scheduler, coordinator, worktree integration
│   ├── quality/     #   quality gates, audit, diagnose, readiness
│   ├── agent/       #   agent dispatch + preflight
│   └── runtime/     #   package roots, Node adapters, bootstrap
├── tests/           # node --test suites + characterization fixtures
└── cli.ts           # the only entrypoint

AG/tasks/            # the task queue (buckets: queue, active, delegated, done, human-review, error, failed)
AG/spec/, AG/openspec/   # spec contracts for machines and for people
AG/benchmark/        # separate package that measures this orchestrator through its CLI
ui-app/              # React operator dashboard (`pnpm build:ui` → ui-app/dist)
mobile-gateway/, mobile-app/   # mobile terminal: gateway service and Expo client
templates/           # what `verqestra install` seeds into a target project
vq/                  # RUNTIME: config, state, logs, cache — gitignored, seeded from templates/
docs/                # architecture, getting started, spec workflow, audits
```

## Gates — fail-closed from the first commit

| Gate | Rule |
|---|---|
| file-length | every source file ≤ 500 lines, tests included, NO baseline |
| boundary | layer import direction (see `src/tests/architecture-gates.test.ts`), zero exceptions |
| classification | every `src/**` file must belong to a known layer/role |
| cycles | module import graph must be acyclic, type-only edges included |
| strict TS | `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` in the BASE tsconfig |
| hygiene | LF only, no NUL bytes, NFC-normalized source |
| dead exports | every production export has a caller or a named reason |
| CSS coverage | every `className` in the dashboard has a rule in `dashboard.css` |

`pnpm test` runs lint → build → the gates and the unit suite → `ui-app` typecheck and tests.
A violation fails the build. The loop treats `pnpm test` as its only gate, so nothing that
CI would catch may be left out of it.

## Getting started

```bash
pnpm install          # root package + AG/benchmark + ui-app workspaces
pnpm typecheck        # types only, no emit
pnpm test             # lint -> build -> tests -> ui-app types and tests
pnpm build            # dist/ + .buildstamp (hooks and the loop execute dist)
pnpm build:ui         # dashboard into ui-app/dist
node dist/cli.js help # every command
```

Fast inner loop while developing: `pnpm build:watch` and `pnpm test:watch` in two
terminals, `pnpm test:file dist/tests/<name>.test.js` for a single suite, `pnpm test:grep
"<pattern>"` for a single case.

The mobile packages are not part of `pnpm test` on purpose (their `node_modules` are not
installed by default); run them by name: `pnpm test:mobile`, `pnpm test:mobile-app`,
`pnpm test:mobile-native`, `pnpm test:benchmark`.

The longer path — [`docs/getting-started.md`](docs/getting-started.md).
Architecture and the reasons behind it — [`docs/architecture.md`](docs/architecture.md).
Spec workflow — [`docs/spec-workflow.md`](docs/spec-workflow.md).
Context packs — [`docs/context-pack.md`](docs/context-pack.md).
Release process — [`docs/release.md`](docs/release.md).
Audit reports — [`docs/audits/`](docs/audits/README.md).

## How a task flows

1. **A task is a Markdown file** in `AG/tasks/queue/`, written strictly after the canonical
   template [`AG/tasks/examples/000-etalonas.md`](AG/tasks/examples/000-etalonas.md). Its
   `## Failai / Leidžiama` section is the write scope: the scheduler decides parallelism from
   it, and the post-run diagnosis checks the boundary against it. Concrete paths only —
   a directory wildcard silently serialises the whole queue.
2. **`verqestra loop`** builds a wave from the task graph (dependencies satisfied only by
   `done`), runs preflight gates (size, spec sources, budget, agent chain), assembles a
   context pack, and dispatches the executor model with a turn and token budget.
3. **Worker slots.** Slot `w1` runs in the primary tree. Additional slots run in git
   worktrees under `.ag/worktrees/<run>/` on their own branch
   (`ag/worker/<run>/<task>/a<attempt>`), owned by a lease with a heartbeat. A finished
   worktree branch is merged into the primary branch (`--no-ff`, directory-rename detection
   off, because `AG/tasks/<bucket>/` are state buckets, not renamed directories), `dist` is
   rebuilt if `src` changed, and the copy is removed.
4. **Outcomes.** A task moves to `done` when its checks are green and committed. It is
   parked in `human-review` when a gate refuses it (boundary violation, budget, retry limit,
   merge conflict) or when the run failed; `verqestra requeue` brings it back and resets its
   ledger and budget counters. Infrastructure failures (usage limit, timeout, stale dist)
   abort the loop with their exit code instead of blaming the task.
5. **Claude Code hooks** (`templates/.claude/settings.json`) enforce the same rules inside
   an interactive session: bash and write policy, README guard, secret scan, package and
   migration guards, and a Stop hook that runs the gates and commits.

Exit-code contract (`src/shared/exit-codes.ts`, shared across orchestrator, dispatch
children and CI): `0` success, `1` task failure or loop stopped with work left, `2` usage
error, `74` local IO failure, `75` model usage limit (wait and resume), `78` stale `dist`,
`79` invalid policy config, `80` token budget exceeded, `124` dispatch timeout.

## Runtime paths

`vq/` is the runtime of one installation and is not committed. `templates/vq` is its source;
`verqestra install` seeds it without overwriting existing files.

| Path | Contents |
|---|---|
| `vq/config/` | policies: quality, security, model, token and tool budgets, worktree, MCP, spec, GitHub |
| `vq/state/` | task ledger, task graph and wave snapshots, worker leases, scope locks, preserved-work records, stop evidence |
| `vq/logs/` | `orchestrator.log`, `session.md`, `hooks.log`, `token-usage.jsonl`, `context-size.jsonl`, per-slot child logs |
| `vq/project/`, `vq/architecture/`, `vq/generated/` | project profile, architecture graph, generated artefacts |

`AG/tasks`, `AG/openspec`, `AG/spec/changes` and `AG/benchmark` stay under `AG/` because the
queue and package contracts live there.

## Main Commands

Every command lives in one registry (`src/composition/cli/registry.ts`), and the CLI help
screen prints the same list in the same order. This list and the registry are checked
against each other: `verqestra readiness-audit` fails if a command exists but is not
documented here, or is documented but does not exist.

### Spec and plan

| Command | What it does |
|---|---|
| `verqestra export-json-schema [--out <dir>]` | Exports the policy JSON schemas into a directory |
| `verqestra export-api-contract [--out <file>]` | Exports the API contract of the active spec change |
| `verqestra learning <list\|approve\|reject> [id]` | Learning-memory entries and recommendation decisions |
| `verqestra plan [--force]` | Builds the architecture contract from the active specification |
| `verqestra task-generate [--change <id>] [--start <n>]` | Generates queue tasks from the spec plan |
| `verqestra spec-drift <change-id>` | Compares changed files against the spec change scope |
| `verqestra openspec-reconcile [--apply]` | Reconciles OpenSpec changes with task state |

### Task queue

| Command | What it does |
|---|---|
| `verqestra task-ledger-sync` | Reconciles the task ledger with the real bucket files |
| `verqestra task-move <task-file> <target-dir>` | Moves a task file to another bucket |
| `verqestra requeue <task-file-or-name>` | Returns a task from human-review to the queue (ledger and budget reset) |
| `verqestra accept-scope <task-file-or-name> <path…>` | Accepts paths missing from `## Failai` and moves the task from human-review straight to done (no requeue, no ledger/budget reset); merging the branch stays the operator's job |
| `verqestra status` | Summary of the queue, current task, tokens and stop evidence |
| `verqestra process-queued-task <task-file>` | Full cycle of one queued task (the loop's child executor) |
| `verqestra task-dependencies [list\|route-blocked <task-id>] [--json]` | Task dependencies and routing of blocked tasks |

### Audit, gates and policies

| Command | What it does |
|---|---|
| `verqestra backlog-audit [--json]` | Queue backlog audit (duplicates, superseded, empty tasks) |
| `verqestra security-verify [--json]` | Security policy check for changed files |
| `verqestra release-notes [--json]` | Generates release notes from the ledger and state |
| `verqestra quality-gates [scope] [--json] [--no-memo]` | Configured lint/typecheck/test/build gates with status and log |
| `verqestra converge` | Reconciles spec plans with queue files |
| `verqestra readiness-audit [--json]` | Product readiness audit (folders, configs, commands, tests, docs) |
| `verqestra audit-director` | Quality checks in a loop with a repairing agent (up to 3 iterations) |
| `verqestra final-audit [--json]` | Final release verdict from every gate and evidence artefact |
| `verqestra preflight <task-file> [--json]` | Gates before dispatch: size, spec sources, budget, agents |
| `verqestra policy [list\|propose ...]` | Policy review and the proposal journal |
| `verqestra agent [list\|add\|remove ...]` | Agent persona registry |
| `verqestra project-status` | Project status document from spec, queue and release evidence |
| `verqestra report [--json] [--recent <n>]` | Local telemetry report (tasks, tokens, compression, adapters) |
| `verqestra build-gate` | Whether the generated dist matches src (hooks and the loop execute dist) |
| `verqestra milestone-check` | Milestone gates: quality, spec alignment, security policy |
| `verqestra release-check` | Release gates: build, tests, milestone, docs, package shape |

### Project and execution

| Command | What it does |
|---|---|
| `verqestra project-mode [--json]` | Detects the project mode (new, continued, interrupted) |
| `verqestra ui` | Starts the dashboard on 127.0.0.1 (port from vq/state/ui-server.json) |
| `verqestra bootstrap-project [--json]` | Prepares the architecture graph and the first queue tasks from the README |
| `verqestra compound-init <description> [--force]` | Prepares the workspace and project profile |
| `verqestra install [--dry-run]` | Installs templates into the project (never overwrites existing files) |
| `verqestra smoke` | Environment and queue smoke check (changes nothing) |
| `verqestra restore-stable [--execute]` | Restores the tree from stable-ref (without --execute only shows the plan) |
| `verqestra rollback-stable [--task-scope] [--ref <sha>]` | Rolls the tree back to stable-ref with an untracked snapshot |
| `verqestra claude-dispatch <task-file> [--task-id <id>]` | Runs the executor model with routing, budget and stop-bridge evidence |
| `verqestra claude-preflight <task-file>` | LLM preflight: reformulation, spec context, agents, budget |
| `verqestra claude-diagnose <task-file>` | Diagnoses a failed attempt and writes the repair decision |
| `verqestra loop` | Queue execution cycle: waves, slots and integration until the queue is empty (0 = work done or operator stop, 1 = stopped with work left: exhausted wave, dirty tree, undispatched slot). Also starts the dashboard — disable with `AG_UI_AUTOSTART=0` |
| `verqestra loop-guard` | Pre-loop checks without starting the loop (0 = safe, 1 = blocked) |
| `verqestra dispatch <task-file> [--adapter <kind>]` | Runs the execution adapter AFTER preflight, budget and context-pack gates |
| `verqestra codex-dispatch <task-id> [--adapter codex]` | Codex adapter path (without --adapter codex it is a dry run) |
| `verqestra retry-guard [--task-id <id>]` | Retry counters and the limit before descending to human-review |
| `verqestra on-stop-bridge <status> [reason]` | Records Stop-bridge evidence (attempt + global mirror) |

### Code intelligence and architecture

| Command | What it does |
|---|---|
| `verqestra code-index [build\|check\|architecture-check]` | Code index (scan, symbols, freshness) |
| `verqestra code-graph query <file-or-symbol> [--json] [--fuzzy]` | Code graph queries (dependencies, symbols) |
| `verqestra context-pack <task-file> [--with-code-graph]` | Assembles the context pack for a task (retrieval, budget, cache) |
| `verqestra architecture [init\|check\|import-mmd\|next-node\|synthesize-node\|verify-node\|run-tree\|code-map]` | Architecture graph, wave, verification and code map |

### Benchmark and integrations

| Command | What it does |
|---|---|
| `verqestra benchmark [--mode <mode>] [--json]` | Runs the @verqestra/benchmark package |
| `verqestra benchmark-drive --workdir <d> --model <m> --step-limit <n> --timeout-ms <n> [--prompt-file <f>]` | One bounded headless agent run for a benchmark scenario |
| `verqestra benchmark-loop-cell --workdir <d> --model <m> --step-limit <n> --timeout-ms <n> --allowed-path <p> [--check <cmd>]` | One ag-loop benchmark cell: a full queue cycle in a scenario copy |
| `verqestra optimization-benchmark [--capture\|--compare] [--json]` | Optimisation measurement against the baseline |
| `verqestra github-issue-import --issue <number>` | Imports a GitHub issue as a task draft |
| `verqestra github-pr [--create]` | Builds the PR text from gate status (without --create only a draft) |

### Claude Code lifecycle hooks

They are not called by hand but through `.claude/settings.json`
(see [`templates/.claude/settings.json`](templates/.claude/settings.json)).

| Command | What it does |
|---|---|
| `verqestra hook-pre-bash` | PreToolUse: bash command policy, git mutation ownership (BLOCKS) |
| `verqestra hook-pre-write` | PreToolUse: write policy, README guard, runtime ownership (BLOCKS) |
| `verqestra hook-post-bash` | PostToolUse: Bash journal and digest shadow telemetry |
| `verqestra hook-post-bash-sync` | PostToolUse: synchronous Bash output digest path |
| `verqestra hook-post-read` | PostToolUse: README read evidence |
| `verqestra hook-post-write` | PostToolUse: session write ledger, KPI events and guard fan-out |
| `verqestra hook-secret-scan` | Guard: credential scan of changed files (a finding → exit 1) |
| `verqestra hook-package-guard` | Guard: justification for package.json and lockfile changes |
| `verqestra hook-migration-guard` | Guard: DB migration changes and destructive SQL |
| `verqestra hook-backend-guard` | Guard: Express backend security rules |
| `verqestra hook-frontend-guard [post\|stop]` | Guard: frontend component rules (lint in stop mode) |
| `verqestra hook-mobile-guard [post\|stop]` | Guard: mobile app rules (typecheck in stop mode) |
| `verqestra hook-session-start` | SessionStart: evidence reset with three brakes and the git baseline |
| `verqestra hook-session-end` | SessionEnd: session scope and runtime record release |
| `verqestra hook-session-summary` | Session summary: checks, changed files, guard status |
| `verqestra hook-user-prompt` | UserPromptSubmit: one-time orchestrator context block |
| `verqestra hook-on-stop` | Stop: gates, commit and push workflow at the end of a session |

## Migration coverage

`migration-coverage.json` tracks every live AG_loop module as
`pending | migrated | wont-migrate(reason)`. The cutover requirement of 0 `pending` is met:
48 modules migrated, 11 deliberately not migrated with a recorded reason, 0 pending. Every
deviation from the etalon is written down three times — in the commit report, in the
etalon's `tasks.md` annotation and in this file — and always in the stricter direction.
