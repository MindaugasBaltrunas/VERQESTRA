# CLAUDE.md

This project uses VERQESTRA for queued AI-assisted development.

The target project's own instructions, architecture, and maintainers remain the
authority. VERQESTRA supplies workflow helpers; it does not replace project rules.

Before changing files:

1. Read `AGENTS.md` if present.
2. Read `CLAUDE.md` and `.claude/rules/*`.
3. Read the task file under `AG/tasks/*`.
4. If the task references `AG/openspec/changes/<change-id>/`, read that change.
5. Keep changes scoped and preserve unrelated user work.

In agent chains, `readme-guard` reads the project README (and architecture doc)
once per session and returns a boundary summary; later agents rely on that
summary instead of re-reading the full README.

Use project-specific checks from `vq/config/quality-policy.json` for verification.

## Writing a task's `## Failai` section

`## Failai` → `Leidžiama:` is not only the write boundary. It is the only input the
scheduler uses to decide whether two queued tasks may run in parallel.

**Declare concrete paths, including test files.** Write
`src/tests/user-service.test.ts`, not `src/tests/**`. If the exact filename is not yet
known, write the expected one: a wrong concrete path is visible and gets corrected, a
wildcard removes parallelism silently.

Use `**` only when the scope is genuinely unbounded (a whole-package migration, for
example). Such a task deliberately gives up parallelism — that is a decision, not a
default.

### The cost

A wildcard costs twice over. Two tasks whose scopes both read `src/tests/**` are
reported as an overlapping glob/glob scope *and* each contributes a `wildcard-scope`
evidence gap — and one gap on either side alone is enough to serialize the pair, even
when the two tasks touch entirely different modules and different test files.

So `src/tests/**` is shorter for one author and paid for by the whole queue: every such
pair loses a slot and runs sequentially. Two extra lines naming the real files pay for
themselves in the first wave.

