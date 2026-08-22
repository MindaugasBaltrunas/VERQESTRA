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

