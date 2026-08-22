# task-service (benchmark fixture)

A dependency-free ESM task tracker used by the benchmark suite. Nothing installs
and nothing is compiled: every file is plain `.mjs` runnable by `node --test`.

## Boundaries

| Directory | Responsibility | May import |
|---|---|---|
| `src/domain` | Task rules: storing, ordering, summarising. Pure functions over plain values. | its own siblings only |
| `src/storage` | Persistence adapters. Knows the filesystem, knows nothing about rules. | `src/domain`, `node:fs/promises` |
| `test` | `node --test` suites. | anything under `src` |

`src/domain` **must not** import `src/storage` or any `node:` module. A domain
that can read a file can be told what to conclude by whoever writes that file.

## Deliberately failing tests

`test/priority-unknown-label.test.mjs` fails on a clean checkout. It is the bug
report for the defect in `src/domain/priority.mjs`, not rot: a bugfix scenario
hands the agent this red test and forbids editing `test/`, so the only way to
green is to fix the production code.

## Commands

```bash
node --test test/task-store.test.mjs
node --test test/priority.test.mjs
node --test test/priority-unknown-label.test.mjs   # red until the bug is fixed
```
