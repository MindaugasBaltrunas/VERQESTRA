# auth-gateway (benchmark fixture)

A dependency-free permission and session-token module used by the benchmark's
security scenarios. Signing keys are always passed in as arguments; the fixture
contains no key material, no environment file and no credential of any kind.

## Boundaries

| Directory | Responsibility |
|---|---|
| `src` | Role/permission resolution and session-token issue/verify. Pure functions plus `node:crypto`. |
| `test` | `node --test` suites. |

Rules the fixture is expected to keep:

- Permission checks deny by default. An unknown role resolves to no permissions,
  never to every permission.
- Token comparison is constant-time (`timingSafeEqual`). A `===` on a signature
  leaks its prefix through timing.
- Nothing logs a token, a signature or a signing key.

## Deliberately failing tests

`test/session-token-expiry.test.mjs` fails on a clean checkout. It is the bug
report for the boundary comparison in `verifySessionToken`, which accepts a
token in the same second it expires. A bugfix scenario forbids editing `test/`,
so the fix has to land in `src`.

## Commands

```bash
node --test test/permissions.test.mjs
node --test test/session-token.test.mjs
node --test test/session-token-expiry.test.mjs   # red until the bug is fixed
```
