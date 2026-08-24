import assert from "node:assert/strict";
import test from "node:test";
import type { ProjectMembershipPort } from "../application/ports/project-membership-port.js";
import {
  TerminalStreamService,
  type TerminalOutputStreamPort,
} from "../application/terminal-stream-service.js";
import {
  TerminalWebSocketProtocol,
  type TerminalWebSocketPeer,
} from "../interfaces/websocket/terminal-websocket-gateway.js";

const principalId = "123e4567-e89b-42d3-a456-426614174029";
const projectId = "123e4567-e89b-42d3-a456-426614174030";
const sessionId = "123e4567-e89b-42d3-a456-426614174031";
const ownerDeviceId = "123e4567-e89b-42d3-a456-426614174032";
const leaseId = "123e4567-e89b-42d3-a456-426614174033";
const timestamp = "2026-07-26T12:00:00.000Z";

function fakeTerminal(): {
  port: TerminalOutputStreamPort;
  get opens(): number;
  get closes(): number;
} {
  let opens = 0;
  let closes = 0;
  return {
    port: {
      async openOutputStream() {
        opens += 1;
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
            nextSequence: 1,
          },
          replay: {
            events: [],
            nextSequence: 1,
            historyTruncated: false,
          },
          async close() {
            closes += 1;
          },
        };
      },
    },
    get opens() {
      return opens;
    },
    get closes() {
      return closes;
    },
  };
}

function fakePeer(): {
  peer: TerminalWebSocketPeer;
  sent: string[];
  closeFrames: Array<[number, string]>;
  message(value: unknown, isBinary?: boolean): void;
  disconnect(): void;
} {
  const sent: string[] = [];
  const closeFrames: Array<[number, string]> = [];
  let messageListener: ((data: Buffer, isBinary: boolean) => void) | undefined;
  let closeListener: (() => void) | undefined;
  return {
    peer: {
      bufferedAmount: 0,
      send(text, callback) {
        sent.push(text);
        callback();
      },
      close(code, reason) {
        closeFrames.push([code, reason]);
      },
      onMessage(listener) {
        messageListener = listener;
      },
      onClose(listener) {
        closeListener = listener;
      },
    },
    sent,
    closeFrames,
    message(value, isBinary = false) {
      messageListener?.(Buffer.from(JSON.stringify(value)), isBinary);
    },
    disconnect() {
      closeListener?.();
    },
  };
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

/**
 * NUKRYPIMAS (formos, ne elgesio): kadro laukai skaitomi per bracket —
 * `noPropertyAccessFromIndexSignature`. `JSON.parse` grąžina neįrodytą formą, tad nė vienas
 * laukas dar nėra įrodytas egzistuojančiu.
 */
function frameOf(payload: string | undefined): Record<string, unknown> {
  return JSON.parse(payload ?? "{}") as Record<string, unknown>;
}

test("websocket protocol requires authorized hello before snapshot, ack and heartbeat", async () => {
  const terminal = fakeTerminal();
  const membership: ProjectMembershipPort = {
    async canReadProject() {
      return true;
    },
    async canControlTerminal(candidatePrincipalId, candidateProjectId) {
      return candidatePrincipalId === principalId && candidateProjectId === projectId;
    },
  };
  const stream = new TerminalStreamService(terminal.port, () => new Date(timestamp));
  const socket = fakePeer();
  new TerminalWebSocketProtocol(stream, membership).accept(principalId, socket.peer);

  socket.message({
    type: "client.hello",
    projectId,
    sessionId,
    lastAckSequence: 0,
  });
  await settle();
  assert.equal(terminal.opens, 1);
  assert.equal(frameOf(socket.sent[0])["type"], "server.snapshot");

  socket.message({ type: "client.heartbeat", timestamp });
  await settle();
  assert.deepEqual(socket.closeFrames, []);

  socket.message({ type: "client.ack", sessionId, sequence: 1 });
  await settle();
  assert.equal(socket.closeFrames[0]?.[0], 1008);
  socket.disconnect();
  await settle();
  assert.equal(terminal.closes, 1);
});

test("an integration intent is refused before and after hello", async () => {
  // Branch integration is local-only, so the phone-facing transport must have no
  // frame that asks for one — before the connection exists and after it does.
  const terminal = fakeTerminal();
  const membership: ProjectMembershipPort = {
    async canReadProject() {
      return true;
    },
    async canControlTerminal() {
      return true;
    },
  };
  const stream = new TerminalStreamService(terminal.port, () => new Date(timestamp));
  const lastFrame = (socket: ReturnType<typeof fakePeer>): Record<string, unknown> =>
    frameOf(socket.sent[socket.sent.length - 1]);

  const unopened = fakePeer();
  new TerminalWebSocketProtocol(stream, membership).accept(principalId, unopened.peer);
  unopened.message({ type: "client.integrate", sessionId });
  await settle();
  assert.equal(lastFrame(unopened)["type"], "server.error");
  assert.equal(lastFrame(unopened)["code"], "hello_required");
  assert.equal(unopened.closeFrames[0]?.[0], 1008);
  assert.equal(terminal.opens, 0, "an unauthenticated intent never opens a stream");

  // Each verb gets its own connection: the first refusal closes the socket, so
  // reusing one would prove only that a closed transport stays closed.
  for (const type of [
    "client.integrate",
    "client.merge",
    "client.rebase",
    "client.cherry-pick",
    "client.command",
  ]) {
    const socket = fakePeer();
    new TerminalWebSocketProtocol(stream, membership).accept(principalId, socket.peer);
    socket.message({ type: "client.hello", projectId, sessionId, lastAckSequence: 0 });
    await settle();
    assert.equal(frameOf(socket.sent[0])["type"], "server.snapshot", type);

    socket.message({ type, sessionId });
    await settle();
    const frame = lastFrame(socket);
    assert.equal(frame["type"], "server.error", type);
    assert.equal(frame["code"], "invalid_control_message", type);
    assert.equal(frame["recoverable"], false, type);
    assert.equal(socket.closeFrames[0]?.[0], 1008, type);
  }
});

test("websocket protocol rejects non-hello, extra fields and denied projects", async () => {
  const terminal = fakeTerminal();
  const membership: ProjectMembershipPort = {
    async canReadProject() {
      return false;
    },
    async canControlTerminal() {
      return false;
    },
  };
  const stream = new TerminalStreamService(terminal.port, () => new Date(timestamp));

  const malformed = fakePeer();
  new TerminalWebSocketProtocol(stream, membership).accept(principalId, malformed.peer);
  malformed.message({ type: "client.heartbeat", timestamp });
  await settle();
  assert.equal(malformed.closeFrames[0]?.[0], 1008);

  const denied = fakePeer();
  new TerminalWebSocketProtocol(stream, membership).accept(principalId, denied.peer);
  denied.message({
    type: "client.hello",
    projectId,
    sessionId,
    lastAckSequence: 0,
    unexpected: true,
  });
  await settle();
  assert.equal(denied.closeFrames[0]?.[0], 1008);

  const forbidden = fakePeer();
  new TerminalWebSocketProtocol(stream, membership).accept(principalId, forbidden.peer);
  forbidden.message({
    type: "client.hello",
    projectId,
    sessionId,
    lastAckSequence: 0,
  });
  await settle();
  assert.equal(forbidden.closeFrames[0]?.[0], 1008);
  assert.equal(terminal.opens, 0);
});
