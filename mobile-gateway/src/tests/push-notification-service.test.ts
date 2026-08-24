import assert from "node:assert/strict";
import test from "node:test";
import {
  createPushNotificationPayload,
  PushNotificationPayloadError,
  type PushNotificationPayload,
  type PushNotificationPort,
} from "../application/ports/push-notification-port.js";
import { PushNotificationService } from "../application/push-notification-service.js";
import type { AgLoopTaskBucket } from "../application/ports/ag-loop-ui-read-port.js";
import type { TerminalSession } from "../domain/terminal-session.js";

const timestamp = "2026-08-11T12:00:00.000Z";

function fakePort(): { port: PushNotificationPort; sent: PushNotificationPayload[] } {
  const sent: PushNotificationPayload[] = [];
  return {
    port: {
      async send(payload) {
        sent.push(payload);
      },
    },
    sent,
  };
}

function bucket(name: string, tasks: readonly string[]): AgLoopTaskBucket {
  return Object.freeze({ bucket: name, tasks, totalCount: tasks.length });
}

function session(overrides: Partial<TerminalSession> = {}): TerminalSession {
  return Object.freeze({
    sessionId: "123e4567-e89b-42d3-a456-426614174000",
    projectId: "123e4567-e89b-42d3-a456-426614174001",
    provider: "codex",
    workspaceMode: "isolated-worktree",
    branch: "mobile/session",
    baseCommit: "abc123",
    state: "live",
    revision: 1,
    ...overrides,
  });
}

// --- AG Loop task bucket -> notification ------------------------------------

test("task bucket: a task newly present in done becomes a completed event", async () => {
  const { port, sent } = fakePort();
  const service = new PushNotificationService(port, () => new Date(timestamp));
  await service.observeAgLoopTaskBucket(bucket("done", []), bucket("done", ["1150-task"]));
  assert.deepEqual(sent, [
    { type: "completed", source: "ag-loop-read", subjectId: "1150-task", occurredAt: timestamp },
  ]);
});

test("task bucket: a task newly present in failed becomes a failed event", async () => {
  const { port, sent } = fakePort();
  const service = new PushNotificationService(port, () => new Date(timestamp));
  await service.observeAgLoopTaskBucket(bucket("failed", []), bucket("failed", ["1151-task"]));
  assert.deepEqual(sent, [
    { type: "failed", source: "ag-loop-read", subjectId: "1151-task", occurredAt: timestamp },
  ]);
});

test("task bucket: a task already present in the previous snapshot does not re-fire", async () => {
  const { port, sent } = fakePort();
  const service = new PushNotificationService(port, () => new Date(timestamp));
  await service.observeAgLoopTaskBucket(
    bucket("done", ["1150-task"]),
    bucket("done", ["1150-task"]),
  );
  assert.deepEqual(sent, []);
});

test("task bucket: a bucket with no prior snapshot emits nothing", async () => {
  const { port, sent } = fakePort();
  const service = new PushNotificationService(port, () => new Date(timestamp));
  await service.observeAgLoopTaskBucket(null, bucket("done", ["1150-task"]));
  assert.deepEqual(sent, []);
});

test("task bucket: a non-terminal bucket never emits, even with new tasks", async () => {
  const { port, sent } = fakePort();
  const service = new PushNotificationService(port, () => new Date(timestamp));
  await service.observeAgLoopTaskBucket(bucket("queue", []), bucket("queue", ["1150-task"]));
  assert.deepEqual(sent, []);
});

test("task bucket: an id that is not an opaque identifier fails closed instead of leaking", async () => {
  const { port, sent } = fakePort();
  const service = new PushNotificationService(port, () => new Date(timestamp));
  await assert.rejects(
    service.observeAgLoopTaskBucket(bucket("done", []), bucket("done", ["/home/op/secret"])),
    PushNotificationPayloadError,
  );
  assert.deepEqual(sent, []);
});

// --- Terminal lifecycle -> notification --------------------------------------

test("terminal lifecycle: ended becomes a completed event", async () => {
  const { port, sent } = fakePort();
  const service = new PushNotificationService(port, () => new Date(timestamp));
  await service.observeTerminalLifecycle(session({ state: "ended" }));
  assert.deepEqual(sent, [
    {
      type: "completed",
      source: "mobile-terminal",
      subjectId: "123e4567-e89b-42d3-a456-426614174000",
      occurredAt: timestamp,
    },
  ]);
});

test("terminal lifecycle: failed becomes a failed event", async () => {
  const { port, sent } = fakePort();
  const service = new PushNotificationService(port, () => new Date(timestamp));
  await service.observeTerminalLifecycle(session({ state: "failed" }));
  assert.deepEqual(sent, [
    {
      type: "failed",
      source: "mobile-terminal",
      subjectId: "123e4567-e89b-42d3-a456-426614174000",
      occurredAt: timestamp,
    },
  ]);
});

for (const state of ["creating", "starting", "live", "interrupting", "closing", "orphaned"] as const) {
  test(`terminal lifecycle: ${state} is not a terminal outcome and emits nothing`, async () => {
    const { port, sent } = fakePort();
    const service = new PushNotificationService(port, () => new Date(timestamp));
    await service.observeTerminalLifecycle(session({ state }));
    assert.deepEqual(sent, []);
  });
}

// --- Payload-leakage: structural + runtime rejection -------------------------

test("payload: rejects a Windows absolute path as subjectId", () => {
  assert.throws(
    () =>
      createPushNotificationPayload({
        type: "completed",
        source: "ag-loop-read",
        subjectId: "C:\\Users\\op\\.env",
        occurredAt: timestamp,
      }),
    PushNotificationPayloadError,
  );
});

test("payload: rejects a POSIX absolute path as subjectId", () => {
  assert.throws(
    () =>
      createPushNotificationPayload({
        type: "completed",
        source: "ag-loop-read",
        subjectId: "/home/operator/keys/id_rsa",
        occurredAt: timestamp,
      }),
    PushNotificationPayloadError,
  );
});

test("payload: rejects a UNC path as subjectId", () => {
  assert.throws(
    () =>
      createPushNotificationPayload({
        type: "completed",
        source: "ag-loop-read",
        subjectId: "\\\\fileserver\\share\\secret",
        occurredAt: timestamp,
      }),
    PushNotificationPayloadError,
  );
});

test("payload: rejects a home-relative path as subjectId", () => {
  assert.throws(
    () =>
      createPushNotificationPayload({
        type: "completed",
        source: "ag-loop-read",
        subjectId: "~/secrets/id_rsa",
        occurredAt: timestamp,
      }),
    PushNotificationPayloadError,
  );
});

test("payload: rejects path traversal even inside an otherwise-whitelisted string", () => {
  assert.throws(
    () =>
      createPushNotificationPayload({
        type: "completed",
        source: "ag-loop-read",
        subjectId: "task-..-escape",
        occurredAt: timestamp,
      }),
    PushNotificationPayloadError,
  );
});

test("payload: rejects a bearer token as subjectId", () => {
  assert.throws(
    () =>
      createPushNotificationPayload({
        type: "completed",
        source: "ag-loop-read",
        subjectId: "Bearer abc.def.ghi",
        occurredAt: timestamp,
      }),
    PushNotificationPayloadError,
  );
});

test("payload: rejects a compact JWT-shaped access token as subjectId", () => {
  assert.throws(
    () =>
      createPushNotificationPayload({
        type: "completed",
        source: "ag-loop-read",
        subjectId: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dQw4w9WgXcQ",
        occurredAt: timestamp,
      }),
    PushNotificationPayloadError,
  );
});

test("payload: rejects a GitHub-shaped access token as subjectId", () => {
  assert.throws(
    () =>
      createPushNotificationPayload({
        type: "completed",
        source: "ag-loop-read",
        subjectId: "ghp_" + "1234567890abcdefghijklmnopqrstuv",
        occurredAt: timestamp,
      }),
    PushNotificationPayloadError,
  );
});

test("payload: rejects an AWS-shaped access key id as subjectId", () => {
  assert.throws(
    () =>
      createPushNotificationPayload({
        type: "completed",
        source: "ag-loop-read",
        subjectId: "AKIA" + "ABCDEFGHIJKLMNOP",
        occurredAt: timestamp,
      }),
    PushNotificationPayloadError,
  );
});

test("payload: rejects multi-line terminal output text as subjectId", () => {
  assert.throws(
    () =>
      createPushNotificationPayload({
        type: "completed",
        source: "ag-loop-read",
        subjectId: "Build failed\n$ npm test\nExit code 1",
        occurredAt: timestamp,
      }),
    PushNotificationPayloadError,
  );
});

test("payload: rejects an oversized subjectId", () => {
  assert.throws(
    () =>
      createPushNotificationPayload({
        type: "completed",
        source: "ag-loop-read",
        subjectId: "a".repeat(129),
        occurredAt: timestamp,
      }),
    PushNotificationPayloadError,
  );
});

test("payload: rejects an unknown event type", () => {
  assert.throws(
    () =>
      createPushNotificationPayload({
        // @ts-expect-error deliberately outside the closed union
        type: "started",
        source: "ag-loop-read",
        subjectId: "1150-task",
        occurredAt: timestamp,
      }),
    PushNotificationPayloadError,
  );
});

test("payload: rejects an unknown source", () => {
  assert.throws(
    () =>
      createPushNotificationPayload({
        type: "completed",
        // @ts-expect-error deliberately outside the closed union
        source: "orchestrator",
        subjectId: "1150-task",
        occurredAt: timestamp,
      }),
    PushNotificationPayloadError,
  );
});

test("payload: rejects a non-timestamp occurredAt", () => {
  assert.throws(
    () =>
      createPushNotificationPayload({
        type: "completed",
        source: "ag-loop-read",
        subjectId: "1150-task",
        occurredAt: "not-a-timestamp",
      }),
    PushNotificationPayloadError,
  );
});

test("payload: accepts a well-formed opaque task id", () => {
  const payload = createPushNotificationPayload({
    type: "completed",
    source: "ag-loop-read",
    subjectId: "1150-fix-something",
    occurredAt: timestamp,
  });
  assert.equal(payload.subjectId, "1150-fix-something");
  assert.ok(Object.isFrozen(payload));
});
