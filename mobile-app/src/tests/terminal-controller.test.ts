import assert from "node:assert/strict";
import test from "node:test";
import { presentTerminal } from "../controller/presentation/terminal-presenter.js";
import {
  terminalInputCharacterLimit,
  TerminalApplicationError,
} from "../controller/terminal-controller.js";
import type { TerminalSession } from "../model/ports.js";
import { reduceAppState } from "../model/reducer.js";
import {
  fixture,
  geometry,
  leaseId,
  projectId,
  session,
  sessionId,
  streamUrl,
  terminalStates,
} from "./terminal-controller-doubles.js";

/**
 * SKAIDYMAS (VERQESTRA ≤500 eil. vartas; žr. `terminal-controller-doubles.ts`). Čia —
 * SESIJOS GYVENIMO CIKLAS: kas pasiekia host'ą, ką kontroleris apie tai praneša ekranui ir
 * kas lieka uždaroma po nesėkmės. Patvirtinimo vartas — `terminal-write-gate.test.ts`.
 */

test("controller starts isolated terminal, streams it and submits only through lease snapshot", async () => {
  const value = fixture();
  await value.controller.start({
    projectId,
    provider: "codex",
    cols: 100,
    rows: 30,
  });
  assert.deepEqual(value.streamStarts, [{
    url: streamUrl,
    accessToken: "access.token.signature-value",
    projectId,
    sessionId,
    lastAckSequence: 0,
  }]);
  await value.controller.submitKeyboard("run tests");
  await value.controller.submitConfirmedVoice("fix the failure");

  const inputCalls = value.gatewayCalls.filter((call) => call.name === "input");
  assert.equal(inputCalls.length, 2);
  assert.equal((inputCalls[0]?.input as { lease: { leaseId: string } }).lease.leaseId, leaseId);
  assert.equal((inputCalls[0]?.input as { source: string }).source, "keyboard");
  assert.equal((inputCalls[1]?.input as { source: string }).source, "voice");
  assert.equal(value.state.terminalState, "live");
});

test("controller rejects a second start and explicit detach never closes the terminal", async () => {
  const value = fixture();
  await value.controller.start({
    projectId,
    provider: "codex",
    cols: 100,
    rows: 30,
  });
  await assert.rejects(
    value.controller.start({
      projectId,
      provider: "claude-code",
      cols: 80,
      rows: 24,
    }),
    (error: unknown) => error instanceof TerminalApplicationError &&
      error.code === "session_already_active",
  );
  value.controller.detachStream();
  assert.equal(value.streamStops, 1);
  assert.equal(value.gatewayCalls.filter((call) => call.name === "close").length, 0);
  assert.equal(value.controller.session?.sessionId, sessionId);
});

test("a start that never reached the host leaves the terminal startable again", async () => {
  let attempts = 0;
  const value = fixture({
    gateway: {
      async createTerminalSession(input) {
        attempts += 1;
        if (attempts === 1) throw new Error("gateway unreachable");
        return { ...session(), projectId: input.projectId };
      },
    },
  });

  await assert.rejects(value.controller.start({ projectId, provider: "codex", cols: 100, rows: 30 }));
  // No session exists, so reporting `failed` would strand the screen with a
  // start button it must keep disabled and a close button with nothing to close.
  assert.equal(value.state.terminalState, "none");
  assert.equal(value.controller.session, undefined);
  assert.equal(value.state.error, "Terminal session could not be started.");

  await value.controller.start({ projectId, provider: "codex", cols: 100, rows: 30 });
  assert.equal(value.state.terminalState, "live");
});

test("a start that created a session but failed afterwards keeps it closable", async () => {
  const value = fixture({ credential: null });

  await assert.rejects(
    value.controller.start({ projectId, provider: "codex", cols: 100, rows: 30 }),
    (error: unknown) => error instanceof TerminalApplicationError && error.code === "not_paired",
  );
  assert.equal(value.state.terminalState, "failed");
  assert.equal(value.state.error, "Device pairing is required.");
  assert.equal(value.controller.session?.sessionId, sessionId);
});

test("a rejected interrupt is reported instead of failing silently", async () => {
  const failing = fixture({
    gateway: {
      async signalTerminal() {
        throw new Error("signal rejected");
      },
    },
  });
  await failing.controller.start({ projectId, provider: "codex", cols: 100, rows: 30 });
  await assert.rejects(failing.controller.interrupt());
  assert.equal(failing.state.error, "Interrupt was not delivered.");
  assert.equal(failing.state.terminalState, "live");
});

test("a rejected close restores the session state instead of hanging on closing", async () => {
  const value = fixture({
    gateway: {
      async closeTerminal() {
        throw new Error("close rejected");
      },
    },
  });
  await value.controller.start({ projectId, provider: "codex", cols: 100, rows: 30 });

  await assert.rejects(value.controller.close());
  assert.equal(value.state.terminalState, "live");
  assert.equal(value.state.error, "Terminal session could not be closed.");
  // The host session survived, so the stream must not have been torn down.
  assert.equal(value.streamStops, 0);
  assert.equal(value.controller.session?.sessionId, sessionId);
});

test("a whole start → input → interrupt → close → restart cycle reaches every state in order", async () => {
  const value = fixture();

  await value.controller.start({ projectId, provider: "codex", ...geometry });
  await value.controller.submitKeyboard("pnpm test");
  await value.controller.interrupt();
  // An interrupt signals the agent; it never ends the session.
  assert.equal(value.state.terminalState, "live");
  assert.equal(value.controller.session?.sessionId, sessionId);
  assert.equal(value.streamStops, 0);

  await value.controller.close();
  assert.equal(value.state.terminalState, "ended");
  assert.equal(value.controller.session, undefined);
  assert.equal(value.streamStops, 1);

  // Only a closed session frees the slot, and the restart is a fresh session:
  // the stream replays from the beginning rather than from the old ack point.
  await value.controller.start({ projectId, provider: "claude-code", cols: 80, rows: 24 });
  assert.equal(value.streamStarts.length, 2);
  assert.equal((value.streamStarts[1] as { lastAckSequence: number }).lastAckSequence, 0);
  assert.equal(value.state.terminalState, "live");

  assert.deepEqual(
    terminalStates(value.events),
    ["creating", "live", "closing", "ended", "creating", "live"],
  );
  assert.deepEqual(
    value.gatewayCalls.map((call) => call.name),
    ["create", "input", "signal", "close", "create"],
  );
  assert.equal(
    (value.gatewayCalls.at(-1)?.input as { provider: string }).provider,
    "claude-code",
    "the restart uses the newly chosen provider",
  );
  assert.equal(
    (value.gatewayCalls.at(-1)?.input as { workspaceMode: string }).workspaceMode,
    "isolated-worktree",
    "every session, restart included, stays in an isolated worktree",
  );
  // A restart clears the banner of the session that ended.
  assert.equal(value.state.error, null);
});

test("detaching the stream leaves the host session running and still closable", async () => {
  const value = fixture();
  await value.controller.start({ projectId, provider: "codex", ...geometry });

  value.controller.detachStream();
  value.controller.detachStream();
  assert.equal(value.streamStops, 2);
  // A detach is a client-side act only: nothing is signalled, nothing is closed,
  // and the model state of the session is untouched.
  assert.deepEqual(value.gatewayCalls.map((call) => call.name), ["create"]);
  assert.deepEqual(terminalStates(value.events), ["creating", "live"]);
  assert.equal(value.controller.session?.sessionId, sessionId);

  // The session still occupies the slot, so a start is still refused …
  await assert.rejects(
    value.controller.start({ projectId, provider: "codex", ...geometry }),
    (error: unknown) => error instanceof TerminalApplicationError &&
      error.code === "session_already_active",
  );
  // … and the lifecycle actions still address the same lease.
  await value.controller.interrupt();
  await value.controller.close();
  assert.equal(
    (value.gatewayCalls.at(-1)?.input as { lease: { leaseId: string } }).lease.leaseId,
    leaseId,
  );
  assert.equal(value.state.terminalState, "ended");
  assert.equal(value.controller.session, undefined);
});

test("every host session state maps to exactly one screen state", async () => {
  const expected: ReadonlyArray<readonly [TerminalSession["state"], string]> = [
    ["creating", "creating"],
    ["starting", "creating"],
    ["live", "live"],
    ["interrupting", "live"],
    ["closing", "closing"],
    ["ended", "ended"],
    ["failed", "failed"],
    // A host session whose writer lease was taken over is observable, not lost.
    ["orphaned", "read-only"],
  ];

  for (const [hostState, screenState] of expected) {
    const value = fixture({
      gateway: {
        async getTerminalSession() {
          return session(hostState);
        },
      },
    });
    await value.controller.start({ projectId, provider: "codex", ...geometry });

    const snapshot = await value.controller.refreshSnapshot();
    assert.equal(snapshot.state, hostState);
    assert.equal(value.state.terminalState, screenState, `host ${hostState}`);
    assert.equal(value.controller.session?.state, hostState, "the snapshot replaces the cached session");
  }
});

test("an orphaned lease leaves an observable session that offers no way to write", async () => {
  const value = fixture({
    gateway: {
      async getTerminalSession() {
        return session("orphaned");
      },
      async writeTerminalInput() {
        // The host fences writes on the lease generation the mobile client lost.
        throw new Error("lease_revoked");
      },
    },
  });
  await value.controller.start({ projectId, provider: "codex", ...geometry });
  await value.controller.refreshSnapshot();

  const view = presentTerminal(
    reduceAppState(value.state, { type: "connection.changed", state: "live" }),
    { composerDraft: "deploy" },
  );
  assert.equal(view.readOnly, true);
  assert.equal(view.composer.canSend, false);
  assert.equal(view.actions.find((entry) => entry.id === "close")?.enabled, true);

  // Anything that bypasses the screen still fails loudly instead of silently:
  // the operator is told, and the session is neither closed nor forgotten.
  await assert.rejects(value.controller.submitKeyboard("deploy"));
  assert.equal(value.state.error, "Terminal command was not delivered.");
  assert.equal(value.state.terminalState, "read-only");
  assert.equal(value.controller.session?.sessionId, sessionId);
  assert.equal(value.streamStops, 0);
});

test("input is bounded at exactly the limit the composer offers", async () => {
  const value = fixture();
  await value.controller.start({ projectId, provider: "codex", ...geometry });

  await value.controller.submitKeyboard("x".repeat(terminalInputCharacterLimit));
  assert.equal(value.gatewayCalls.filter((call) => call.name === "input").length, 1);
  assert.equal(value.state.error, null);

  for (const rejected of ["", "x".repeat(terminalInputCharacterLimit + 1)]) {
    await assert.rejects(
      value.controller.submitKeyboard(rejected),
      (error: unknown) => error instanceof TerminalApplicationError &&
        error.code === "invalid_input",
    );
    await assert.rejects(
      value.controller.submitConfirmedVoice(rejected),
      (error: unknown) => error instanceof TerminalApplicationError &&
        error.code === "invalid_input",
    );
    assert.equal(value.state.error, "Terminal command was rejected as invalid.");
  }
  // Nothing invalid reached the gateway, and the session survived the rejection.
  assert.equal(value.gatewayCalls.filter((call) => call.name === "input").length, 1);
  assert.equal(value.state.terminalState, "live");
  assert.equal(value.controller.session?.sessionId, sessionId);
});

test("a rejected write is reported without losing the session", async () => {
  const value = fixture({
    gateway: {
      async writeTerminalInput() {
        throw new Error("gateway unreachable");
      },
    },
  });
  await value.controller.start({ projectId, provider: "codex", ...geometry });

  await assert.rejects(value.controller.submitKeyboard("pnpm test"));
  assert.equal(value.state.error, "Terminal command was not delivered.");
  // A transport failure is not a command failure: the session state is not
  // guessed at, the stream stays attached and the session stays addressable.
  assert.equal(value.state.terminalState, "live");
  assert.equal(value.streamStops, 0);
  assert.equal(value.controller.session?.sessionId, sessionId);
});

test("no lifecycle action reaches the gateway without a session", async () => {
  const value = fixture();
  const noSession = (error: unknown): boolean =>
    error instanceof TerminalApplicationError && error.code === "session_not_active";

  for (const attempt of [
    () => value.controller.submitKeyboard("ls"),
    () => value.controller.submitConfirmedVoice("ls"),
    () => value.controller.interrupt(),
    () => value.controller.terminate(),
    () => value.controller.close(),
    () => value.controller.resize(120, 40),
    () => value.controller.refreshSnapshot(),
  ]) {
    await assert.rejects(attempt(), noSession);
  }
  assert.deepEqual(value.gatewayCalls, []);
  assert.deepEqual(value.events, []);

  // Detaching a stream that was never attached is harmless, not an error.
  value.controller.detachStream();
  assert.equal(value.streamStops, 1);

  // The same holds once a session has been closed.
  await value.controller.start({ projectId, provider: "codex", ...geometry });
  await value.controller.close();
  for (const attempt of [
    () => value.controller.submitKeyboard("ls"),
    () => value.controller.interrupt(),
    () => value.controller.close(),
  ]) {
    await assert.rejects(attempt(), noSession);
  }
});

test("terminate reports the ended session and keeps it addressable for cleanup", async () => {
  const value = fixture();
  await value.controller.start({ projectId, provider: "codex", ...geometry });

  await value.controller.terminate();
  const signalled = value.gatewayCalls.find((call) => call.name === "signal");
  assert.equal((signalled?.input as { signal: string }).signal, "terminate");
  assert.equal(value.state.terminalState, "ended");
  // Terminate signals the process; the lease is released by the close that
  // follows, so the session must still be there to close.
  assert.equal(value.controller.session?.sessionId, sessionId);
  assert.equal(value.streamStops, 0);

  await value.controller.close();
  assert.equal(value.controller.session, undefined);
  assert.equal(value.streamStops, 1);
  assert.equal(value.state.terminalState, "ended");
});

test("controller close uses the current lease, detaches stream and clears active session", async () => {
  const value = fixture();
  await value.controller.start({
    projectId,
    provider: "codex",
    cols: 100,
    rows: 30,
  });
  await value.controller.close();
  assert.equal(value.gatewayCalls.filter((call) => call.name === "close").length, 1);
  assert.equal(value.streamStops, 1);
  assert.equal(value.controller.session, undefined);
  assert.equal(value.state.terminalState, "ended");
});
