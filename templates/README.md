# VERQESTRA project templates

These files are copied by `pnpm verqestra install <target-project-dir>`.

After installation, `.claude/agents/*.md` and `vq/config/agents.json` are owned by
the target project. Use `verqestra agent list|add|enable|disable|remove` to manage them.

The installer copies only this template tree, creates directories represented by
the tree, and preserves every file that already exists in the target project.
Use `--dry-run` to print the planned writes without changing the target.

For local builds and future package releases, the package layout is stable:

- dist/cli.js is the compiled CLI entry used by the verqestra binary and package scripts.
- dist/** contains TypeScript build output only.
- templates/** is shipped beside dist so verqestra install can copy this tree at runtime.
- README.md documents the packaged template contract.

The target project remains authoritative for architecture, permissions, quality
commands, and agent policy. Review every template before enabling lifecycle hooks.
