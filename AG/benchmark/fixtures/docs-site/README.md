# docs-site (benchmark fixture)

Documentation fixture for the benchmark's docs scenarios. The only production
artefacts are Markdown; the `test/` directory holds a dependency-free
documentation linter so a docs change is machine-checkable rather than judged by
eye.

## Layout

| Path | Contents |
|---|---|
| `docs/getting-started.md` | Install and first run. |
| `docs/configuration.md` | Every setting, its default and its effect. |
| `docs/settings-inventory.json` | Generated from the source: the authority on which settings exist. |
| `docs/releases.json` | Every published version. |
| `CHANGELOG.md` | Keep-a-Changelog style, newest release first. |
| `test/` | `node --test` documentation checks. |

## Conventions

- Every `#` and `##` heading is unique within its file, so anchors stay stable.
- Every relative link resolves.
- Every row of the settings table states a default; "no default" is written out
  rather than left blank.
- The settings table matches `docs/settings-inventory.json` exactly — no missing
  setting and no invented one.
- `CHANGELOG.md` carries an `## [Unreleased]` section at all times and has a
  section for every version in `docs/releases.json`, newest first.

## Deliberately failing tests

Two check files are RED on a clean checkout. They are the gap reports the docs
scenarios ask an agent to close, not rot:

- `test/settings-documented.test.mjs` — `retryBackoffMs` and `logLevel` exist
  but are undocumented.
- `test/changelog-releases.test.mjs` — 0.3.0 shipped without a changelog entry.

`test/docs-conventions.test.mjs` is green and must stay green.

## Commands

```bash
node --test test/docs-conventions.test.mjs
node --test test/settings-documented.test.mjs   # red until the gap is closed
node --test test/changelog-releases.test.mjs    # red until the gap is closed
```
