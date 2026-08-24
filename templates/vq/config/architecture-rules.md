# Architecture Rules For VERQESTRA Supervisor

The supervisor validates and normalizes tasks. It does not implement product code.

## Project Authority

Before delegating work, the supervisor and Claude must follow these sources in order:

1. User task
2. `AGENTS.md` if present
3. `CLAUDE.md` if present
4. `.claude/rules/*` if present
5. `AG/openspec/project.md` and referenced OpenSpec changes/specs
6. Existing codebase patterns

## Boundaries

- The supervisor may read repository files, `.claude/`, `AG/`, docs, configs and logs.
- The supervisor may run non-destructive diagnostics, tests, builds and linters.
- The supervisor must not edit product code.
- Claude is the executor that edits delegated files.
- Claude must not overwrite unrelated user changes.
- Claude must keep changes scoped to the task and the target project boundaries.
- Claude Stop hook reports machine-readable status to `vq/state/claude-stop-status.json`.

## OpenSpec

OpenSpec is optional but recommended for product intent.

- Source-code tasks may reference `AG/openspec/changes/<change-id>/`.
- If a task references an OpenSpec change, VERQESTRA loads bounded context from that change and touched specs.
- If `AG/openspec/` is absent, create it from the installed template or proceed with project docs as authority.

## Agent Routing

Available Claude agents are `.claude/agents/*.md`. Agent names are file names without `.md`.
Only roles registered and enabled in `vq/config/agents.json` participate in AG routing.

Common generic chains:

- feature: `readme-guard -> architect -> coder -> reviewer -> tester -> documenter`
- bug: `readme-guard -> debugger -> coder -> reviewer -> tester`
- refactor: `readme-guard -> architect -> coder -> reviewer -> tester`
- data/schema: `readme-guard -> architect -> data-model -> migrator -> reviewer -> tester`
- security/auth: `readme-guard -> architect -> security -> coder -> reviewer -> tester`
- docs: `readme-guard -> documenter -> reviewer`

## Model Routing

Use the stronger model for unclear, risky or cross-cutting work:

- architecture, security, data model, public API, migrations
- behavior changes or large refactors
- tasks touching multiple modules/apps/packages

Use the faster model for clear local work:

- obvious bug fix
- small docs update
- local lint/type issue
- mechanical cleanup

When uncertain, prefer the stronger model.

