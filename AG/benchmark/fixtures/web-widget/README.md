# web-widget (benchmark fixture)

A dependency-free HTML-string widget used by the benchmark's UI scenarios.
Rendering returns a string rather than touching a DOM, so the fixture needs no
browser, no bundler and no install — `node --test` runs it as it stands.

## Boundaries

| Directory | Responsibility |
|---|---|
| `src` | Rendering and message lookup. Pure functions returning strings. |
| `src/messages` | Locale catalogues, one JSON file per locale. |
| `test` | `node --test` suites. |

Every user-visible string comes from a catalogue via `translate()`. A literal
sentence inlined into `render-status-badge.mjs` is a boundary violation, not a
shortcut: it is invisible to the locale files and cannot be translated.

## Deliberately failing tests

`test/i18n-missing-key.test.mjs` fails on a clean checkout. It is the bug report
for `translate()` returning `undefined` on an unknown key instead of falling
back, and a bugfix scenario forbids editing `test/` so the fix has to land in
`src`.

## Commands

```bash
node --test test/render-status-badge.test.mjs
node --test test/i18n.test.mjs
node --test test/i18n-missing-key.test.mjs   # red until the bug is fixed
```
