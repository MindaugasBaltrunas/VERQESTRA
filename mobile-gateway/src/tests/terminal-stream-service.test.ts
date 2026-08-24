import assert from "node:assert/strict";
import test from "node:test";
import {
  TerminalStreamError,
  TerminalStreamService,
  type TerminalOutputStreamPort,
  type TerminalStreamServerEvent,
  type TerminalStreamSink,
} from "../application/terminal-stream-service.js";
import type { TerminalOutputEvent } from "../domain/terminal-replay-buffer.js";

const projectId = "123e4567-e89b-42d3-a456-426614174030";
const sessionId = "123e4567-e89b-42d3-a456-426614174031";
const ownerDeviceId = "123e4567-e89b-42d3-a456-426614174032";
const leaseId = "123e4567-e89b-42d3-a456-426614174033";
const timestamp = "2026-07-26T12:00:00.000Z";

function output(sequence: number, data = `output-${sequence}`): TerminalOutputEvent {
  return Object.freeze({
    type: "server.output",
    sessionId,
    sequence,
    timestamp,
    data,
  });
}

function fakePort(input: {
  replay?: readonly TerminalOutputEvent[];
  historyTruncated?: boolean;
  beforeOpen?: TerminalOutputEvent;
}): {
  port: TerminalOutputStreamPort;
  emit(event: TerminalOutputEvent): void;
  get closeCount(): number;
} {
  let listener: ((event: TerminalOutputEvent) => void) | undefined;
  let closeCount = 0;
  return {
    port: {
      async openOutputStream(request) {
        listener = request.onEvent;
        if (input.beforeOpen) listener(input.beforeOpen);
        const replay = input.replay ?? [];
        return {
          snapshot: {
            sessionId,
            projectId,
            provider: "codex",
            workspaceMode: "isolated-worktree",
            branch: "mobile/session",
            state: "live",
            lease: {
              leaseId,
              ownerDeviceId,
              generation: 1,
              expiresAt: "2026-07-26T12:05:00.000Z",
            },
            nextSequence: (replay.at(-1)?.sequence ?? 0) + 1,
          },
          replay: {
            events: replay,
            nextSequence: (replay.at(-1)?.sequence ?? 0) + 1,
            historyTruncated: input.historyTruncated ?? false,
          },
          async close() {
            closeCount += 1;
          },
        };
      },
    },
    emit(event) {
      listener?.(event);
    },
    get closeCount() {
      return closeCount;
    },
  };
}

function fakeSink(): {
  sink: TerminalStreamSink;
  events: TerminalStreamServerEvent[];
  closes: Array<[number, string]>;
  setBufferedBytes(value: number): void;
} {
  const events: TerminalStreamServerEvent[] = [];
  const closes: Array<[number, string]> = [];
  let bufferedBytes = 0;
  return {
    sink: {
      async send(event) {
        events.push(event);
      },
      bufferedBytes() {
        return bufferedBytes;
      },
      close(code, reason) {
        closes.push([code, reason]);
      },
    },
    events,
    closes,
    setBufferedBytes(value) {
      bufferedBytes = value;
    },
  };
}

test("stream sends snapshot, replay and then live output exactly once", async () => {
  const terminal = fakePort({
    replay: [output(1)],
    beforeOpen: output(2),
  });
  const transport = fakeSink();
  const service = new TerminalStreamService(terminal.port, () => new Date(timestamp));
  const connection = await service.connect({
    projectId,
    sessionId,
    lastAckSequence: 0,
  }, transport.sink);
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(
    transport.events.map((event) => event.type),
    ["server.snapshot", "server.output", "server.output"],
  );
  assert.deepEqual(
    transport.events
      .filter((event): event is TerminalOutputEvent => event.type === "server.output")
      .map((event) => event.sequence),
    [1, 2],
  );
  const snapshot = transport.events[0];
  assert.equal(snapshot?.type, "server.snapshot");
  if (snapshot?.type === "server.snapshot") {
    assert.equal(snapshot.nextSequence, 2);
    assert.equal(snapshot.lease.ownerDeviceId, ownerDeviceId);
  }

  terminal.emit(output(2));
  terminal.emit(output(3));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(
    transport.events
      .filter((event): event is TerminalOutputEvent => event.type === "server.output")
      .map((event) => event.sequence),
    [1, 2, 3],
  );
  await connection.acknowledge({ sessionId, sequence: 3 });
  await connection.heartbeat({ timestamp });
  await connection.close();
  assert.equal(terminal.closeCount, 1);
  assert.deepEqual(transport.closes, []);
});

test("stream reports truncated history in snapshot without fabricating output", async () => {
  const terminal = fakePort({ historyTruncated: true });
  const transport = fakeSink();
  const connection = await new TerminalStreamService(
    terminal.port,
    () => new Date(timestamp),
  ).connect({ projectId, sessionId, lastAckSequence: 5 }, transport.sink);
  assert.equal(transport.events.length, 1);
  assert.equal(transport.events[0]?.type, "server.snapshot");
  if (transport.events[0]?.type === "server.snapshot") {
    assert.equal(transport.events[0].historyTruncated, true);
  }
  await connection.close();
});

test("stream closes on excessive unacknowledged replay or invalid ack", async () => {
  const terminal = fakePort({ replay: [output(1), output(2), output(3)] });
  const transport = fakeSink();
  const service = new TerminalStreamService(
    terminal.port,
    () => new Date(timestamp),
    { maxBufferedBytes: 1024, maxUnacknowledgedEvents: 2 },
  );
  const connection = await service.connect({
    projectId,
    sessionId,
    lastAckSequence: 0,
  }, transport.sink);
  assert.deepEqual(
    transport.events
      .filter((event): event is TerminalOutputEvent => event.type === "server.output")
      .map((event) => event.sequence),
    [1, 2],
  );
  assert.equal(transport.closes[0]?.[0], 1013);
  await assert.rejects(
    connection.acknowledge({ sessionId, sequence: 99 }),
    (error: unknown) => error instanceof TerminalStreamError && error.code === "invalid_message",
  );
  await connection.close();
});

test("stream closes when the transport buffer exceeds its byte budget", async () => {
  const terminal = fakePort({});
  const transport = fakeSink();
  const service = new TerminalStreamService(
    terminal.port,
    () => new Date(timestamp),
    { maxBufferedBytes: 10, maxUnacknowledgedEvents: 10 },
  );
  const connection = await service.connect({
    projectId,
    sessionId,
    lastAckSequence: 0,
  }, transport.sink);
  transport.setBufferedBytes(11);
  terminal.emit(output(1));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(transport.closes[0]?.[0], 1013);
  await connection.close();
});
