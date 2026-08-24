# Verification Matrix

## How this matrix is verified

Every ID row below is bound to the tests that discharge it by two executable
conformance suites, so a row cannot keep claiming coverage after the test behind
it was renamed, moved or deleted:

- `mobile-gateway/src/tests/verification-matrix-conformance.test.ts` — owns
  every ID except the four it delegates, and fails if an ID appears here with no
  evidence, if evidence names a test that no longer exists, or if evidence
  survives an ID that was removed.
- `mobile-app/src/tests/verification-matrix-mvc.test.ts` — owns `ARCH-02`,
  `ARCH-03`, `ARCH-04` and `AUTH-03` plus the React Native / MVC bullet list, in
  which every bullet must be either evidenced or declared open with a reason.
  **Not migrated yet** (see "Known verification gaps"); the gateway suite fails
  the moment `mobile-app/src/tests` exists without it, so the delegation cannot
  quietly stay a promise.

Status vocabulary, used in every table and list below:

| Status | Meaning |
|---|---|
| `automated` | Discharged by tests that run in CI on every push. |
| `HUMAN-REQUIRED` | Cannot be executed in process; needs the physical-device E2E and a human sign-off. |
| `OPEN` | Not verified yet, with the reason recorded next to it. |

`mobile-gateway/src/tests/fake-provider-contract.test.ts` additionally holds the
CI mandate itself: the fake-provider contract suites must stay unconditional
(no skip, no `process.env` gate) and CI may not run the gateway suite with
`continue-on-error`.

### Deviations from the AG Loop reference

Recorded here rather than left to be discovered by comparison; the direction is
always tightening.

1. **Location.** The reference kept this file in
   `AG/openspec/changes/ag-mobile-voice-terminal/`. In VERQESTRA
   `AG/openspec/changes/` holds VERQESTRA's own changes, so importing the
   reference's change folder there would lie about whose record it is. The
   matrix describes this package's verification, so it lives in the package —
   the same rule the OpenAPI and AsyncAPI contracts follow.
2. **Paths.** `AG/mobile-gateway/**` → `mobile-gateway/**` and
   `AG/mobile-app/**` → `mobile-app/**`: these are workspace packages here, not
   folders under `AG/`.
3. **Split evidence files.** VERQESTRA caps every source file at 500 lines, so
   several reference suites were split. Where a title moved, the row below names
   the file that holds it *today*, and the conformance suite is what proves the
   name is still true.
4. **MVA → MVC.** `mobile-app` is being rebuilt as Model–View–Controller; the
   gateway keeps `domain/application/infrastructure/interfaces`.
5. **The delegation is checked.** The reference listed the four delegated IDs as
   strings nothing verified. Here the conformance suite asserts the mirror file
   exists as soon as `mobile-app` has sources.

## Architecture gates

| ID | Gate | Required evidence | Status | Evidence file |
|---|---|---|---|---|
| ARCH-01 | `mobile-gateway/**` never imports orchestrator internals | static import-boundary test | `automated` | `mobile-gateway/src/tests/architecture-boundaries.test.ts` |
| ARCH-02 | Mobile Model imports no React, React Native, HTTP, WebSocket or native module | dependency test | `OPEN` | `mobile-app/src/tests/mvc-boundaries.test.ts` — not migrated |
| ARCH-03 | View imports only view types and presentation adapter surface | dependency test | `OPEN` | `mobile-app/src/tests/mvc-boundaries.test.ts` — not migrated |
| ARCH-04 | Native/network adapters implement Model ports; Model never imports adapters | dependency test | `OPEN` | `mobile-app/src/tests/mvc-boundaries.test.ts` — not migrated |
| ARCH-05 | AG UI adapter exposes read methods only | TypeScript contract and AST test | `automated` | `mobile-gateway/src/tests/architecture-boundaries.test.ts`, `ag-loop-read-routes.test.ts` |
| ARCH-06 | Remote router has no AG Loop mutation or branch-integration route | OpenAPI/router snapshot test | `automated` | `mobile-gateway/src/tests/api-contract-conformance.test.ts`, `remote-integration-surface.test.ts` |
| ARCH-07 | Every writing terminal uses a gateway session worktree as cwd | process adapter contract test | `automated` | `mobile-gateway/src/tests/architecture-boundaries.test.ts`, `terminal-supervisor.test.ts` |

Suggested MVC import rules:

```text
model/**       -> model/**
view/**        -> view/**, controllers/presentation surface
adapters/**    -> model/public, adapter-local dependencies
composition/** -> model/public, view/public, adapters/public
```

Forbidden:

```text
model/** -> view/** | adapters/** | composition/** | react-native
view/**  -> model/use-cases/** | adapters/api/** | adapters/native/**
```

## `DirectAgentTerminalPort` contract suite

The same suite runs against Claude Code and Codex fake and real-smoke adapters.

| ID | Scenario | Expected invariant | Status | Evidence file |
|---|---|---|---|---|
| PTY-01 | Probe installed provider | normalized `ready` status and version | `automated` | `agent-provider-connection.test.ts` |
| PTY-02 | Probe missing provider | `unavailable`; other adapter unaffected | `automated` | `agent-provider-connection.test.ts` |
| PTY-03 | Start session | fixed executable, recorded worktree cwd, no arbitrary args | `automated` | `node-pty-direct-agent-terminal-adapter.test.ts` |
| PTY-04 | Write UTF-8 input | exactly one PTY write for one `inputId` | `automated` | `terminal-supervisor.test.ts` |
| PTY-05 | Repeat input | original result returned, no second write | `automated` | `terminal-supervisor.test.ts` |
| PTY-06 | Resize bounds | valid size applied; out-of-range rejected before adapter | `automated` | `node-pty-direct-agent-terminal-adapter.test.ts` |
| PTY-07 | Interrupt | signal reaches only the recorded mobile process tree | `automated` | `node-pty-direct-agent-terminal-adapter.test.ts`, `terminal-supervisor-noninterference.test.ts` |
| PTY-08 | Terminate | transitions through `closing`; AG Loop PID unchanged | `automated` | `terminal-supervisor-noninterference.test.ts` |
| PTY-09 | Client disconnect | PTY remains live and replay continues | `automated` | `fake-provider-contract.test.ts` |
| PTY-10 | Output flood | bounded frames, backpressure, no unbounded memory growth | `automated` | `terminal-output.test.ts`, `terminal-stream-service.test.ts` |
| PTY-11 | ANSI/OSC corpus | clipboard, title injection and unsafe hyperlinks removed | `automated` | `terminal-output.test.ts` |
| PTY-12 | Provider exits | normalized exit status and immutable audit record | `automated` | `fake-provider-contract.test.ts`, `audit-chain.test.ts` |
| PTY-13 | Gateway restart | stale lease revoked; ambiguous process becomes `orphaned` | `automated` | `session-reconciliation.test.ts` |
| PTY-14 | Host busy | second writing session rejected atomically | `automated` | `terminal-supervisor.test.ts` |

All paths are relative to `mobile-gateway/src/tests/`.

Real-smoke tests may be skipped when a provider is unavailable, but fake adapter
contract tests are mandatory in CI. That mandate is itself a test:
`fake-provider-contract.test.ts` fails if any fake-provider contract suite grows
a skip, a `todo` or a `process.env` gate, and if `.github/workflows/ci.yml` stops
running the gateway suite or lets it fail with `continue-on-error`.

Real-smoke status: not re-run in VERQESTRA. The reference recorded no-input
start/close smoke checks on the Windows development host for `claude.exe` and
`codex.cmd`; that evidence belongs to the reference's host and is not claimed
here. CI installs no agent provider, which is exactly the skip the matrix
permits.

## AG Loop read adapter tests

| ID | Scenario | Expected result | Status | Evidence file |
|---|---|---|---|---|
| AGREAD-01 | UI offline | `ag_loop_ui_offline`; no start attempt | `automated` | `ag-loop-read-routes.test.ts` |
| AGREAD-02 | Initial bootstrap | token parsed from loopback HTML, never persisted | `automated` | `ag-loop-ui-http-adapter.test.ts` |
| AGREAD-03 | UI restart/token rotation | one re-bootstrap and one retry | `automated` | `ag-loop-ui-http-adapter.test.ts` |
| AGREAD-04 | Redirect response | rejected; gateway does not follow origin | `automated` | `ag-loop-ui-http-adapter.test.ts` |
| AGREAD-05 | Dashboard contains mutation fields | fields absent from mobile DTO | `automated` | `ag-loop-ui-http-adapter.test.ts`, `ag-loop-read-models.test.ts` |
| AGREAD-06 | Dashboard contains absolute paths | paths removed or repository-relative | `automated` | `ag-loop-read-models.test.ts`, `ag-loop-ui-adapter-reads.test.ts` |
| AGREAD-07 | Logs contain secret canary | canary absent from response, audit and error | `automated` | `ag-loop-read-models.test.ts` |
| AGREAD-08 | SSE activity contains Bash secret | redacted before sequence/replay | `automated` | `ag-loop-read-models.test.ts`, `ag-loop-stream-transport.test.ts` |
| AGREAD-09 | Caller requests POST upstream | adapter rejects before network call | `automated` | `ag-loop-stream-transport.test.ts`, `ag-loop-ui-adapter-reads.test.ts` |
| AGREAD-10 | Invalid task bucket | request rejected without upstream call | `automated` | `ag-loop-ui-http-adapter.test.ts`, `ag-loop-ui-adapter-reads.test.ts` |

## Auth and authorization tests

| ID | Scenario | Expected result | Status | Evidence file |
|---|---|---|---|---|
| AUTH-01 | Redeem valid QR once | device tokens issued | `automated` | `device-auth.test.ts`, `remote-gateway-router.test.ts` |
| AUTH-02 | Replay QR | rejected atomically | `automated` | `device-auth.test.ts` |
| AUTH-03 | Wrong host fingerprint | mobile refuses pairing | `OPEN` | `mobile-app/src/tests/pairing-controller.test.ts` — not migrated |
| AUTH-04 | Wrong device-key proof | gateway rejects | `automated` | `device-auth.test.ts` |
| AUTH-05 | Rotate refresh token | old token invalidated | `automated` | `device-auth.test.ts` |
| AUTH-06 | Reuse rotated refresh token | entire device token family revoked | `automated` | `device-auth.test.ts` |
| AUTH-07 | Revoke device | access, refresh and lease invalid | `automated` | `device-auth.test.ts`, `local-force-close-and-revoke.test.ts` |
| AUTH-08 | Read-only device writes PTY | forbidden | `automated` | `remote-gateway-terminal-routes.test.ts` |
| AUTH-09 | Expired access token | unauthenticated | `automated` | `device-auth.test.ts` |
| AUTH-10 | Cross-project session ID | not found/forbidden without metadata leak | `automated` | `remote-gateway-router.test.ts`, `ag-loop-read-routes.test.ts` |

## Worktree and integration tests

| ID | Scenario | Expected result | Status | Evidence file |
|---|---|---|---|---|
| GIT-01 | Start remote session | new dedicated worktree and branch | `automated` | `terminal-supervisor.test.ts`, `project-and-worktree.test.ts` |
| GIT-02 | Agent changes files | primary working tree fingerprint unchanged | `automated` (structural) + `HUMAN-REQUIRED` | `terminal-supervisor.test.ts`, `local-control-isolation.test.ts`, `session-gates.test.ts` |
| GIT-03 | Primary tree dirty | remote session still isolated; local integrate blocked | `automated` | `local-integration-flow.test.ts`, `session-gates.test.ts` |
| GIT-04 | Base branch advances | local integrate requires refreshed review | `automated` | `local-integration-flow.test.ts` |
| GIT-05 | Quality gate fails | integration blocked | `automated` | `local-integration-flow.test.ts`, `worktree-lifecycle.test.ts` |
| GIT-06 | Merge conflict | no auto-resolution; returns to `review_ready` | `automated` | `local-integration-merge.test.ts` |
| GIT-07 | Remote caller attempts integration | route absent/forbidden | `automated` | `remote-integration-surface.test.ts`, `terminal-websocket-gateway.test.ts`, `local-control-isolation.test.ts` |
| GIT-08 | Crash during allocation | partial worktree quarantined | `automated` | `worktree-lifecycle.test.ts` |
| GIT-09 | Cleanup dirty worktree | refused without local export/confirmation | `automated` | `worktree-lifecycle.test.ts` |
| GIT-10 | Mobile force-close | worktree retained; AG Loop process unchanged | `automated` | `local-force-close-and-revoke.test.ts`, `terminal-supervisor-noninterference.test.ts` |

GIT-02 is the one row an in-process test cannot fully close. What is proven
automatically: the PTY's cwd is always the allocated worktree and never the
registered repository root, no gate or integration path may run a Git verb that
writes to the primary tree, and a recorded worktree outside the session root is
refused as a working directory. What no in-process test can prove is that the
agent itself never reaches the primary tree through an absolute path — that is
step 11 of the Android E2E, and it stays `HUMAN-REQUIRED`.

## React Native component and MVC tests

Bound bullet by bullet in `mobile-app/src/tests/verification-matrix-mvc.test.ts`:
each bullet below must be either evidenced or listed as open with a reason, and
the binding fails if a bullet is reworded without revisiting its evidence.

**Every bullet is `OPEN` in VERQESTRA today**, for one reason: `mobile-app` has
no sources yet. The list is kept verbatim so the migration has a target to
discharge rather than a blank page to improvise against; the reference's own
verdict is recorded next to each bullet as the state to reach.

- Dashboard renders `online`, `offline`, loading, empty and redacted error states.
  — reference: `ag-loop-presentation.test.ts`, `screen-degraded-states.test.ts`.
- Tasks are visibly read-only and expose no swipe/action mutation affordances.
  — reference: `ag-loop-presentation.test.ts`, `screen-degraded-states.test.ts`,
  `native/src/tests/read-only-screens.test.ts` (shell suite).
- Terminal requires a provider selection before session creation.
  — reference: `model-and-presentation.test.ts`, `terminal-presentation.test.ts`.
- Voice transcript is editable and requires explicit confirmation.
  — reference: `model-and-presentation.test.ts`, `voice-presentation.test.ts`.
- App backgrounding disconnects transport but does not send terminal close.
  — `OPEN` in the reference too: the detach semantics are proven
  (`terminal-controller.test.ts`, `terminal-stream-client.test.ts`), but no OS
  lifecycle event is bound to them yet, because the React Native lifecycle
  adapter is not implemented. Covered meanwhile by E2E step 8.
- Reconnect applies snapshot/replay once and never duplicates terminal input.
  — reference: `terminal-stream-client.test.ts`, `voice-capture-controller.test.ts`.
- Stale lease changes composer to read-only before accepting more input.
  — reference: `terminal-controller.test.ts`, `terminal-presentation.test.ts`.
- Secure storage adapter never falls back to AsyncStorage for refresh secrets.
  — reference: `verification-matrix-mvc.test.ts` scans every MVC core and native
  shell production source for `AsyncStorage`, `localStorage` and
  `sessionStorage`; `secure-credential-store.test.ts`.
- External links require an explicit OS confirmation dialog.
  — `OPEN` in the reference too (vacuous there): there is no external-link
  surface to confirm — `native/src/tests/read-only-screens.test.ts` forbids
  `Linking` and `openURL` outright. Becomes live the first time a screen needs
  to leave the app.
- Accessibility labels exist for connect, microphone, confirm, interrupt and
  close actions.
  — reference: action labels in `terminal-presentation.test.ts` and
  `voice-presentation.test.ts`; shell annotations in
  `verification-matrix-mvc.test.ts`, which requires one `accessibilityRole` per
  `<Pressable` and an `accessibilityLabel` on every `<TextInput`.

All mobile-app paths are relative to `mobile-app/src/tests/`.

## Android physical-device E2E

**Status: `HUMAN-REQUIRED` — not executed. This section cannot be discharged by
any agent or CI job.** It needs a physical Android handset, a Windows personal
PC, a private VPN and an operator who can watch a screen; every step below is a
human observation, and no automated suite may report it as passed. The two
conformance suites enforce that: `verification-matrix-conformance.test.ts` fails
if an automated ID row ever appears inside this section.

Blocked on, in addition to the hardware: `mobile-app` is not migrated, the
native React Native/Android shell does not exist here yet, and the gateway has
no remote listener until certificate binding and private-network policy land.
Steps 1–3 are not runnable until then; the runbook is recorded now so the
evidence format is fixed before the first run rather than improvised during it.

Required MVP evidence on at least one supported Android API level. Record
`pass` / `fail` / `blocked` and a note for every step — a step with no verdict
counts as `fail`:

1. Pair with a Windows personal PC over the chosen private VPN.
2. Verify displayed host fingerprint before redemption.
3. Register an existing test repository without sending an absolute path.
4. Observe an already running AG Loop dashboard and task buckets read-only.
5. Restart AG UI and verify transparent token re-bootstrap.
6. Start Claude Code test session in an isolated worktree.
7. Send typed and voice-confirmed input.
8. Lock the phone, restore the app and replay terminal output without duplicate
   input.
9. Interrupt and close the mobile session; verify AG Loop PID/state unchanged.
10. Repeat provider lifecycle with Codex.
11. Verify the primary working tree fingerprint is unchanged.
12. Perform local-only integration review on the PC.
13. Revoke the phone and verify all subsequent refresh and write calls fail.

Steps that are the *only* evidence for something no test can reach, and must
therefore never be skipped for time: step 8 (the app-backgrounding requirement
left open in the React Native list), step 11 (the human half of GIT-02) and the
three latency budgets below.

How to record a run, before the run rather than after it:

- take `git rev-parse HEAD` on the PC and the app build id **before** step 1;
- take `git rev-parse HEAD` and `git status --porcelain` of the test repository
  before step 6 and after step 11, and compare them literally — that pair is the
  primary-working-tree fingerprint of step 11;
- measure the three latency budgets during steps 7 and 8, on the VPN, and record
  the p95 rather than a single sample;
- write the report to `mobile-gateway/doc/` as `android-e2e-<ISO date>.md`.

Capture:

- app version and commit;
- gateway version and commit;
- Android model/API level;
- PC OS;
- provider versions;
- test repository initial/final commits;
- sanitized test report without tokens or terminal content.

## Performance and reliability budgets

| Metric | MVP budget | Status | Evidence |
|---|---:|---|---|
| Terminal input acknowledgement on private LAN/VPN p95 | ≤ 500 ms excluding provider work | `HUMAN-REQUIRED` | Android E2E step 7 |
| Reconnect to snapshot/replay p95 | ≤ 3 s | `HUMAN-REQUIRED` | Android E2E step 8 |
| AG dashboard projection p95 | ≤ 2 s | `HUMAN-REQUIRED` | Android E2E step 4 |
| Terminal frame maximum | 64 KiB | `automated` | `terminal-output.test.ts` |
| Retained replay per session | ≤ 8 MiB and ≤ 30 min | `automated` | `terminal-output.test.ts` |
| Input text maximum | 16 KiB | `OPEN` | `terminal-presentation.test.ts`, `terminal-controller.test.ts` — mobile-app not migrated |
| Active writing sessions | 1 | `automated` | `terminal-supervisor.test.ts`, `fake-provider-contract.test.ts` |
| Pairing attempts | 5 per 10 min per source | `automated` | `gateway-hardening.test.ts` |
| Refresh attempts | 30 per 10 min per source | `automated` | `gateway-hardening.test.ts` |
| Terminal mutations | 120 per min per device | `automated` | `gateway-hardening.test.ts` |
| Access token lifetime | ≤ 15 min | `automated` | `device-auth.test.ts` |

Load tests must prove bounded memory under output flood and slow mobile
consumers. Failure to meet a budget blocks release or requires an explicit ADR.

Covered today: the output-flood bound (sanitize + replay driven at twice the
retention cap with production frame, byte and event limits) and the slow-consumer
bound (`1013` backpressure closure on transport byte and unacknowledged-event
budgets). The three latency budgets are end-to-end network measurements and stay
open until the physical-device E2E — they are deliberately not simulated
in-process, where a wall-clock assertion would be flaky rather than meaningful.

## Definition of done

The feature is complete only when:

- all architecture, security and fake-provider contract tests pass in CI
  — **met for the gateway**: `pnpm --dir mobile-gateway test` is green and runs
  in `.github/workflows/ci.yml` as `pnpm test:mobile`; **NOT met for the app**,
  which has no suite to run;
- available real-provider smoke tests pass
  — **not re-run here**; CI installs no provider, which is the skip the matrix
  permits;
- Android physical-device E2E evidence is recorded
  — **NOT met**: `HUMAN-REQUIRED`, not executed;
- no P0/P1 threat remains without an accepted ADR
  — tracked in the threat model, outside this matrix;
- OpenAPI validation and implementation conformance pass
  — **met**: `api-contract-conformance.test.ts`, `asyncapi-contract-conformance.test.ts`;
- AG Loop regression suite remains green
  — **met**: the orchestrator suite is unaffected; `ARCH-01` proves the gateway
  cannot reach it;
- the primary working tree and AG Loop process non-interference tests pass
  — **met for the process half** (`terminal-supervisor-noninterference.test.ts`,
  `node-pty-direct-agent-terminal-adapter.test.ts`); the working-tree half is
  structural only, see the GIT-02 note.

### Known verification gaps

1. **`mobile-app` is not migrated.** Four IDs (`ARCH-02`, `ARCH-03`, `ARCH-04`,
   `AUTH-03`), the whole React Native / MVC bullet list and the input-text budget
   have no suite behind them here. `.github/workflows/ci.yml` deliberately runs
   no `mobile-app` step, because there is nothing to run; a gateway test fails
   the moment `mobile-app/src` gains a file and CI still has no step for it, and
   a second one fails if the delegated mirror suite is missing.
2. **Android physical-device E2E has not been run** — the whole section above,
   plus the three latency budgets, step 8 (app backgrounding) and the human half
   of GIT-02.
3. **The native shell suite will run in no gate.** In the reference,
   `mobile-app/native` had 30 passing tests that CI never ran. That gap is
   inherited rather than fixed: when the shell lands here it needs a CI step of
   its own, or rows depending on it are structurally unverified.
