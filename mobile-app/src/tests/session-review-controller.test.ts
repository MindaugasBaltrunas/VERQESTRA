import assert from "node:assert/strict";
import test from "node:test";

import { SessionReviewController } from "../controller/session-review-controller.js";
import { reduceAppState, type AppEvent } from "../model/reducer.js";
import {
  SessionReviewReadError,
  type SessionReviewFailureCode,
  type SessionReviewReadPort,
  type SessionReviewSnapshot,
} from "../model/session-review-read.js";
import { initialAppState, type AppState } from "../model/state.js";

const projectId = "8f1c2b6a-0f2e-4c53-9d64-1f4a7f0c8d21";
const sessionId = "0f0a9b2c-1d3e-4f50-8a61-72b3c4d5e6f7";
const otherSessionId = "9e8d7c6b-5a49-4382-91b0-0c1d2e3f4a5b";
const sourceCommit = "1f2e3d4c5b6a79880011223344556677889900aa";

function snapshot(id: string = sessionId): SessionReviewSnapshot {
  return Object.freeze({
    sessionId: id,
    sessionEnded: true,
    git: Object.freeze({
      sourceBranch: "ag/session-0f0a9b2c",
      sourceCommit,
      targetBranch: "master",
      targetHead: "aabbccddeeff00112233445566778899aabbccdd",
      targetClean: true,
    }),
    changedFiles: Object.freeze({ paths: Object.freeze(["src/model/state.ts"]), totalCount: 1 }),
    diff: Object.freeze({
      files: Object.freeze([]),
      totalFileCount: 1,
      addedLineCount: 1,
      removedLineCount: 0,
      truncated: false,
      truncationReason: null,
      digest: "sha256:8a1c0d5e7f6b4a39281706f5e4d3c2b1a09f8e7d6c5b4a3928170615243342ab",
    }),
    gates: null,
    audit: null,
    observedAt: "2026-08-10T10:00:00.000Z",
  });
}

class FakeReviewPort implements SessionReviewReadPort {
  readonly calls: Readonly<{ projectId: string; sessionId: string }>[] = [];

  constructor(private readonly result: () => Promise<SessionReviewSnapshot>) {}

  async readSessionReview(input: Readonly<{
    projectId: string;
    sessionId: string;
  }>): Promise<SessionReviewSnapshot> {
    this.calls.push(input);
    return this.result();
  }
}

function recorder(): Readonly<{
  dispatch: (event: AppEvent) => void;
  events: readonly AppEvent[];
  state: () => AppState;
}> {
  const events: AppEvent[] = [];
  return {
    dispatch: (event) => void events.push(event),
    events,
    state: () => events.reduce(reduceAppState, initialAppState),
  };
}

function failingPort(error: unknown): FakeReviewPort {
  return new FakeReviewPort(async () => {
    throw error;
  });
}

async function readFailure(error: unknown): Promise<SessionReviewFailureCode | null> {
  const sink = recorder();
  await new SessionReviewController(failingPort(error), sink.dispatch)
    .open({ projectId, sessionId });
  return sink.state().sessionReviewError;
}

test("open selects the session, reads it and settles, in that order", async () => {
  const port = new FakeReviewPort(async () => snapshot());
  const sink = recorder();

  await new SessionReviewController(port, sink.dispatch).open({ projectId, sessionId });

  assert.deepEqual(sink.events.map((event) => event.type), [
    "session-review.selected",
    "session-review.read-started",
    "session-review.snapshot",
    "session-review.read-settled",
  ]);
  assert.deepEqual(port.calls, [{ projectId, sessionId }]);
  const state = sink.state();
  assert.equal(state.sessionReviewLink, "connected");
  assert.equal(state.sessionReviewReadsInFlight, 0);
  assert.equal(state.sessionReview?.sessionId, sessionId);
  assert.equal(state.sessionReviewError, null);
});

test("a read error becomes screen state with the port's own code, and resolves", async () => {
  const sink = recorder();
  const port = failingPort(new SessionReviewReadError("not_found", "no review record"));

  // The caller must not have to catch anything: a failed background read is a
  // screen state, not a command failure.
  await new SessionReviewController(port, sink.dispatch).open({ projectId, sessionId });

  assert.deepEqual(sink.events.map((event) => event.type), [
    "session-review.selected",
    "session-review.read-started",
    "session-review.read-failed",
    "session-review.read-settled",
  ]);
  const state = sink.state();
  assert.equal(state.sessionReviewError, "not_found");
  assert.equal(state.sessionReviewLink, "offline");
});

test("every declared failure code reaches the Model unchanged", async () => {
  const codes: readonly SessionReviewFailureCode[] = [
    "not_found",
    "unavailable",
    "unauthorized",
    "invalid_response",
    "transport_failed",
  ];

  for (const code of codes) {
    assert.equal(await readFailure(new SessionReviewReadError(code, code)), code);
  }
});

test("an unknown throw is classified as a transport failure", async () => {
  assert.equal(await readFailure(new TypeError("network request failed")), "transport_failed");
  assert.equal(await readFailure("not even an error"), "transport_failed");
});

test("the read settles even when the port throws", async () => {
  const sink = recorder();
  const port = failingPort(new SessionReviewReadError("unauthorized", "not paired"));

  await new SessionReviewController(port, sink.dispatch).refresh({ projectId, sessionId });

  assert.ok(
    sink.events.some((event) => event.type === "session-review.read-settled"),
    "a failed read must still settle, or the screen spins forever",
  );
  assert.equal(sink.state().sessionReviewReadsInFlight, 0);
});

test("refresh does not select, so it cannot clear the pane it refreshes", async () => {
  const port = new FakeReviewPort(async () => snapshot());
  const sink = recorder();
  const controller = new SessionReviewController(port, sink.dispatch);

  await controller.open({ projectId, sessionId });
  await controller.refresh({ projectId, sessionId });

  assert.deepEqual(sink.events.slice(4).map((event) => event.type), [
    "session-review.read-started",
    "session-review.snapshot",
    "session-review.read-settled",
  ]);
  assert.equal(
    sink.events.filter((event) => event.type === "session-review.selected").length,
    1,
    "a refresh must not re-select the session it is refreshing",
  );
  assert.equal(sink.state().sessionReview?.sessionId, sessionId);
});

test("a read that answers after the operator moved on never lands under the new session", async () => {
  // The controller cancels nothing — it cannot — so the guarantee has to hold
  // end to end: the abandoned read still dispatches, and the Model drops it.
  let releaseFirstRead!: (snapshot: SessionReviewSnapshot) => void;
  const firstAnswer = new Promise<SessionReviewSnapshot>((resolve) => {
    releaseFirstRead = resolve;
  });
  const port: SessionReviewReadPort = {
    async readSessionReview(input) {
      return input.sessionId === sessionId ? firstAnswer : snapshot(otherSessionId);
    },
  };
  const sink = recorder();
  const controller = new SessionReviewController(port, sink.dispatch);

  const abandoned = controller.open({ projectId, sessionId });
  await controller.open({ projectId, sessionId: otherSessionId });
  releaseFirstRead(snapshot());
  await abandoned;

  const state = sink.state();
  assert.equal(state.sessionReviewSessionId, otherSessionId);
  assert.equal(
    state.sessionReview?.sessionId,
    otherSessionId,
    "the abandoned session's diff must never render under the selected one",
  );
  assert.equal(state.sessionReviewReadsInFlight, 0, "both reads settled");
  assert.equal(state.sessionReviewLink, "connected");
  assert.equal(state.sessionReviewError, null);
});

test("the read port exposes no mutating method", () => {
  const port: SessionReviewReadPort = new FakeReviewPort(async () => snapshot());
  const surface = Object.getOwnPropertyNames(Object.getPrototypeOf(port) as object)
    .filter((name) => name !== "constructor");

  assert.deepEqual(surface, ["readSessionReview"]);
});
