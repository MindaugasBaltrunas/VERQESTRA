import assert from "node:assert/strict";
import test from "node:test";
import {
  TerminalStreamClient,
  type MobileWebSocketFactory,
  type MobileWebSocketPort,
  type ReconnectSchedulerPort,
  type TerminalStreamClientObserver,
  type TerminalStreamSnapshot,
} from "../adapters/network/terminal-stream-client.js";
import type { ConnectionState } from "../model/state.js";

const url = "wss://pc.private.test/v1/terminal-stream";
const accessToken = "header.payload.signature-value";
const projectId = "123e4567-e89b-42d3-a456-426614174030";
const sessionId = "123e4567-e89b-42d3-a456-426614174031";
const ownerDeviceId = "123e4567-e89b-42d3-a456-426614174032";
const timestamp = "2026-07-26T12:00:00.000Z";

class FakeSocket implements MobileWebSocketPort {
  readonly sent: string[] = [];
  readonly closes: Array<[number, string]> = [];
  private openListener: (() => void) | undefined;
  private messageListener: ((text: string) => void) | undefined;
  private closeListener: (() => void) | undefined;
  private errorListener: (() => void) | undefined;

  send(text: string): void {
    this.sent.push(text);
  }

  close(code: number, reason: string): void {
    this.closes.push([code, reason]);
  }

  onOpen(listener: () => void): void {
    this.openListener = listener;
  }

  onMessage(listener: (text: string) => void): void {
    this.messageListener = listener;
  }

  onClose(listener: () => void): void {
    this.closeListener = listener;
  }

  onError(listener: () => void): void {
    this.errorListener = listener;
  }

  open(): void {
    this.openListener?.();
  }

  message(value: unknown): void {
    this.messageListener?.(JSON.stringify(value));
  }

  disconnect(): void {
    this.closeListener?.();
  }

  fail(): void {
    this.errorListener?.();
  }
}

/**
 * NUKRYPIMAS (forma, ne elgesys): etalonas rašė `transport.sockets[0]!` ir skaitė
 * `JSON.parse(...).lastAckSequence` per `any`. Su `noUncheckedIndexedAccess` `!` čia yra
 * tylus tvirtinimas — o kai klientas neatidarys lizdo, kurio testas laukia, pranešimas turi
 * pasakyti BŪTENT tai, o ne „cannot read property of undefined". Dvi pagalbinės funkcijos
 * paverčia indeksą ir JSON parse'ą įvardytais teiginiais; tikrinamų faktų aibė nepakito.
 */
function socketAt(sockets: readonly FakeSocket[], index: number): FakeSocket {
  const socket = sockets[index];
  assert.ok(socket, `no socket was opened at index ${index}`);
  return socket;
}

function sentFrame(socket: FakeSocket, index: number): Record<string, unknown> {
  const raw = index < 0 ? socket.sent.at(index) : socket.sent[index];
  assert.ok(raw !== undefined, `the socket sent no frame at index ${index}`);
  const parsed: unknown = JSON.parse(raw);
  assert.ok(typeof parsed === "object" && parsed !== null, "a sent frame must be a JSON object");
  return parsed as Record<string, unknown>;
}

function fakeSockets(): {
  factory: MobileWebSocketFactory;
  sockets: FakeSocket[];
  opens: Array<{ url: string; authorization: string }>;
} {
  const sockets: FakeSocket[] = [];
  const opens: Array<{ url: string; authorization: string }> = [];
  return {
    factory: {
      create(input) {
        opens.push({ url: input.url, authorization: input.headers.Authorization });
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    },
    sockets,
    opens,
  };
}

function fakeScheduler(): {
  scheduler: ReconnectSchedulerPort;
  delays: number[];
  fire(): void;
} {
  const tasks: Array<{ callback: () => void; cancelled: boolean }> = [];
  const delays: number[] = [];
  return {
    scheduler: {
      schedule(delayMs, callback) {
        delays.push(delayMs);
        const task = { callback, cancelled: false };
        tasks.push(task);
        return {
          cancel() {
            task.cancelled = true;
          },
        };
      },
    },
    delays,
    fire() {
      const task = tasks.shift();
      if (task && !task.cancelled) task.callback();
    },
  };
}

function observerEvents(): {
  observer: TerminalStreamClientObserver;
  connections: ConnectionState[];
  snapshots: TerminalStreamSnapshot[];
  outputs: Array<[string, number]>;
  truncatedAt: number[];
  errors: string[];
} {
  const connections: ConnectionState[] = [];
  const snapshots: TerminalStreamSnapshot[] = [];
  const outputs: Array<[string, number]> = [];
  const truncatedAt: number[] = [];
  const errors: string[] = [];
  return {
    observer: {
      onConnectionChanged(state) {
        connections.push(state);
      },
      onSnapshot(snapshot) {
        snapshots.push(snapshot);
      },
      onOutput(data, sequence) {
        outputs.push([data, sequence]);
      },
      onHistoryTruncated(sequence) {
        truncatedAt.push(sequence);
      },
      onError(code) {
        errors.push(code);
      },
    },
    connections,
    snapshots,
    outputs,
    truncatedAt,
    errors,
  };
}

function snapshot(input: { nextSequence: number; historyTruncated?: boolean }): unknown {
  return {
    type: "server.snapshot",
    sessionId,
    timestamp,
    state: "live",
    lease: {
      ownerDeviceId,
      generation: 1,
      expiresAt: "2026-07-26T12:05:00.000Z",
    },
    nextSequence: input.nextSequence,
    historyTruncated: input.historyTruncated ?? false,
  };
}

function output(sequence: number, data = `output-${sequence}`): unknown {
  return {
    type: "server.output",
    sessionId,
    sequence,
    timestamp,
    data,
  };
}

test("client sends token in header, hello after open and acknowledges ordered output", () => {
  const transport = fakeSockets();
  const scheduler = fakeScheduler();
  const events = observerEvents();
  const client = new TerminalStreamClient(transport.factory, scheduler.scheduler, events.observer);
  client.start({ url, accessToken, projectId, sessionId, lastAckSequence: 0 });

  assert.deepEqual(transport.opens, [{
    url,
    authorization: `Bearer ${accessToken}`,
  }]);
  assert.equal(url.includes(accessToken), false);
  const socket = socketAt(transport.sockets, 0);
  assert.deepEqual(socket.sent, []);
  socket.open();
  assert.deepEqual(sentFrame(socket, 0), {
    type: "client.hello",
    projectId,
    sessionId,
    lastAckSequence: 0,
  });

  socket.message(snapshot({ nextSequence: 2 }));
  socket.message(output(1));
  assert.deepEqual(events.connections, ["connecting", "live"]);
  assert.deepEqual(events.outputs, [["output-1", 1]]);
  assert.deepEqual(sentFrame(socket, 1), {
    type: "client.ack",
    sessionId,
    sequence: 1,
  });
  assert.deepEqual(events.errors, []);
});

test("client rejects an unmarked sequence gap and reconnects with the last ack", () => {
  const transport = fakeSockets();
  const scheduler = fakeScheduler();
  const events = observerEvents();
  const client = new TerminalStreamClient(transport.factory, scheduler.scheduler, events.observer);
  client.start({ url, accessToken, projectId, sessionId, lastAckSequence: 3 });
  const first = socketAt(transport.sockets, 0);
  first.open();
  first.message(snapshot({ nextSequence: 6 }));
  first.message(output(5));

  assert.deepEqual(events.errors, ["protocol_error"]);
  assert.equal(first.closes[0]?.[0], 1008);
  assert.deepEqual(scheduler.delays, [500]);
  scheduler.fire();
  const second = socketAt(transport.sockets, 1);
  second.open();
  assert.equal(sentFrame(second, 0)["lastAckSequence"], 3);
});

test("client accepts one retained-history gap only when snapshot marks truncation", () => {
  const transport = fakeSockets();
  const scheduler = fakeScheduler();
  const events = observerEvents();
  const client = new TerminalStreamClient(transport.factory, scheduler.scheduler, events.observer);
  client.start({ url, accessToken, projectId, sessionId, lastAckSequence: 2 });
  const socket = socketAt(transport.sockets, 0);
  socket.open();
  socket.message(snapshot({ nextSequence: 8, historyTruncated: true }));
  socket.message(output(6));
  socket.message(output(7));

  assert.deepEqual(events.truncatedAt, [6]);
  assert.deepEqual(events.outputs, [["output-6", 6], ["output-7", 7]]);
  assert.equal(sentFrame(socket, -1)["sequence"], 7);
  assert.deepEqual(events.errors, []);
});

test("client disconnect schedules bounded reconnect while explicit stop only detaches", () => {
  const transport = fakeSockets();
  const scheduler = fakeScheduler();
  const events = observerEvents();
  const client = new TerminalStreamClient(transport.factory, scheduler.scheduler, events.observer);
  client.start({ url, accessToken, projectId, sessionId, lastAckSequence: 0 });
  const first = socketAt(transport.sockets, 0);
  first.disconnect();
  assert.deepEqual(scheduler.delays, [500]);
  scheduler.fire();
  const second = socketAt(transport.sockets, 1);
  client.stop();
  second.disconnect();
  assert.equal(second.closes[0]?.[0], 1000);
  assert.deepEqual(scheduler.delays, [500]);
  assert.equal(events.connections.at(-1), "disconnected");
});

test("client refuses insecure or token-in-query configuration before opening a socket", () => {
  const transport = fakeSockets();
  const scheduler = fakeScheduler();
  const events = observerEvents();
  const client = new TerminalStreamClient(transport.factory, scheduler.scheduler, events.observer);
  client.start({
    url: `ws://pc.private.test/v1/terminal-stream?token=${accessToken}`,
    accessToken,
    projectId,
    sessionId,
    lastAckSequence: 0,
  });
  assert.equal(transport.sockets.length, 0);
  assert.deepEqual(events.errors, ["invalid_configuration"]);
});
