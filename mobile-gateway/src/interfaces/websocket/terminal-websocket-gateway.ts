import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Server as HttpsServer } from "node:https";
import type { Duplex } from "node:stream";
import {
  WebSocket,
  WebSocketServer,
  type RawData,
} from "ws";
import type { DeviceAuthService } from "../../application/device-auth-service.js";
import type { ProjectMembershipPort } from "../../application/ports/project-membership-port.js";
import type {
  TerminalStreamConnection,
  TerminalStreamError,
  TerminalStreamErrorEvent,
  TerminalStreamServerEvent,
  TerminalStreamService,
  TerminalStreamSink,
} from "../../application/terminal-stream-service.js";

/**
 * NUKRYPIMAS (formos, ne elgesio): prieiga prie neparsinto kadro laukų eina per bracket, o ne
 * per tašką — `noPropertyAccessFromIndexSignature`. Tik patikros funkcijų viduje: kai
 * `isHello`/`isAcknowledgement`/`isHeartbeat` jau susiaurino tipą, laukai yra deklaruoti ir
 * taškas grįžta.
 */

const STREAM_PATH = "/v1/terminal-stream";
const MAX_MESSAGE_BYTES = 32 * 1024;
const HELLO_TIMEOUT_MS = 10_000;

type JsonRecord = Record<string, unknown>;

export interface TerminalWebSocketPeer {
  readonly bufferedAmount: number;
  send(text: string, callback: (error?: Error) => void): void;
  close(code: number, reason: string): void;
  onMessage(listener: (data: Buffer, isBinary: boolean) => void): void;
  onClose(listener: () => void): void;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: JsonRecord, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function parseMessage(data: Buffer, isBinary: boolean): JsonRecord | undefined {
  if (isBinary || data.byteLength === 0 || data.byteLength > MAX_MESSAGE_BYTES) return undefined;
  try {
    const value: unknown = JSON.parse(data.toString("utf8"));
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function isHello(value: JsonRecord): value is JsonRecord & {
  type: "client.hello";
  projectId: string;
  sessionId: string;
  lastAckSequence: number;
} {
  const lastAckSequence = value["lastAckSequence"];
  return (
    hasExactKeys(value, ["type", "projectId", "sessionId", "lastAckSequence"]) &&
    value["type"] === "client.hello" &&
    typeof value["projectId"] === "string" &&
    typeof value["sessionId"] === "string" &&
    Number.isSafeInteger(lastAckSequence) &&
    (lastAckSequence as number) >= 0
  );
}

function isAcknowledgement(value: JsonRecord): value is JsonRecord & {
  type: "client.ack";
  sessionId: string;
  sequence: number;
} {
  const sequence = value["sequence"];
  return (
    hasExactKeys(value, ["type", "sessionId", "sequence"]) &&
    value["type"] === "client.ack" &&
    typeof value["sessionId"] === "string" &&
    Number.isSafeInteger(sequence) &&
    (sequence as number) >= 1
  );
}

function isHeartbeat(value: JsonRecord): value is JsonRecord & {
  type: "client.heartbeat";
  timestamp: string;
} {
  return (
    hasExactKeys(value, ["type", "timestamp"]) &&
    value["type"] === "client.heartbeat" &&
    typeof value["timestamp"] === "string"
  );
}

function websocketSink(peer: TerminalWebSocketPeer): TerminalStreamSink {
  return {
    send(event: TerminalStreamServerEvent): Promise<void> {
      return new Promise((resolve, reject) => {
        peer.send(JSON.stringify(event), (error) => error ? reject(error) : resolve());
      });
    },
    bufferedBytes: () => peer.bufferedAmount,
    close: (code, reason) => peer.close(code, reason),
  };
}

/**
 * Sends the `server.error` frame declared by `asyncapi-contract.yaml` before the
 * socket closes. A bare close code tells the app that something went wrong but
 * not whether retrying is pointless, so the client cannot distinguish a
 * malformed frame from a revoked session. Best-effort by design: the close must
 * proceed even if the transport is already gone, and the frame carries a code
 * and a correlation id only — never a message that could echo terminal content.
 */
function sendStreamError(
  peer: TerminalWebSocketPeer,
  code: string,
  recoverable: boolean,
): void {
  const frame: TerminalStreamErrorEvent = {
    type: "server.error",
    code,
    recoverable,
    correlationId: randomUUID(),
  };
  try {
    peer.send(JSON.stringify(frame), () => undefined);
  } catch {
    // The peer is already unusable; the close below is the only remaining step.
  }
}

export class TerminalWebSocketProtocol {
  constructor(
    private readonly streams: TerminalStreamService,
    private readonly membership: ProjectMembershipPort,
    private readonly helloTimeoutMs = HELLO_TIMEOUT_MS,
  ) {}

  accept(principalId: string, peer: TerminalWebSocketPeer): void {
    let connection: TerminalStreamConnection | undefined;
    let closed = false;
    let receivedHello = false;
    let messageQueue = Promise.resolve();
    const helloTimer = setTimeout(() => {
      if (!receivedHello && !closed) {
        closed = true;
        sendStreamError(peer, "hello_timeout", true);
        peer.close(1008, "terminal hello timeout");
      }
    }, this.helloTimeoutMs);
    helloTimer.unref?.();

    const closeConnection = async (): Promise<void> => {
      if (closed && !connection) return;
      closed = true;
      clearTimeout(helloTimer);
      const activeConnection = connection;
      connection = undefined;
      await activeConnection?.close();
    };

    peer.onClose(() => {
      void closeConnection();
    });
    peer.onMessage((data, isBinary) => {
      messageQueue = messageQueue.then(async () => {
        if (closed) return;
        const message = parseMessage(data, isBinary);
        if (!message) {
          sendStreamError(peer, "invalid_message", false);
          peer.close(1008, "invalid terminal message");
          await closeConnection();
          return;
        }
        if (!receivedHello) {
          if (!isHello(message)) {
            sendStreamError(peer, "hello_required", false);
            peer.close(1008, "client.hello required");
            await closeConnection();
            return;
          }
          receivedHello = true;
          clearTimeout(helloTimer);
          if (!await this.membership.canControlTerminal(principalId, message.projectId)) {
            sendStreamError(peer, "forbidden", false);
            peer.close(1008, "project terminal access denied");
            await closeConnection();
            return;
          }
          try {
            const openedConnection = await this.streams.connect({
              projectId: message.projectId,
              sessionId: message.sessionId,
              lastAckSequence: message.lastAckSequence,
            }, websocketSink(peer));
            if (closed) {
              await openedConnection.close();
              return;
            }
            connection = openedConnection;
          } catch (error) {
            const invalid = (error as TerminalStreamError)?.code === "invalid_message";
            sendStreamError(peer, invalid ? "invalid_message" : "stream_unavailable", !invalid);
            peer.close(invalid ? 1008 : 1011, "terminal stream unavailable");
            await closeConnection();
          }
          return;
        }
        if (!connection) {
          sendStreamError(peer, "stream_unavailable", true);
          peer.close(1011, "terminal stream unavailable");
          await closeConnection();
          return;
        }
        try {
          if (isAcknowledgement(message)) {
            await connection.acknowledge(message);
          } else if (isHeartbeat(message)) {
            await connection.heartbeat(message);
          } else {
            throw new Error("Unsupported terminal message");
          }
        } catch {
          sendStreamError(peer, "invalid_control_message", false);
          peer.close(1008, "invalid terminal control message");
          await closeConnection();
        }
      }).catch(() => {
        sendStreamError(peer, "stream_failed", true);
        peer.close(1011, "terminal stream failure");
        void closeConnection();
      });
    });
  }
}

function bearerToken(request: IncomingMessage): string | undefined {
  const authorization = request.headers.authorization;
  if (!authorization) return undefined;
  const match = /^Bearer ([A-Za-z0-9._~-]+)$/.exec(authorization);
  return match?.[1];
}

function rejectUpgrade(socket: Duplex, status: 401 | 403 | 404): void {
  if (socket.destroyed) return;
  const label = status === 401 ? "Unauthorized" : status === 403 ? "Forbidden" : "Not Found";
  socket.end(
    `HTTP/1.1 ${status} ${label}\r\nConnection: close\r\nCache-Control: no-store\r\nContent-Length: 0\r\n\r\n`,
  );
}

function wrapWebSocket(socket: WebSocket): TerminalWebSocketPeer {
  return {
    get bufferedAmount() {
      return socket.bufferedAmount;
    },
    send(text, callback) {
      socket.send(text, callback);
    },
    close(code, reason) {
      socket.close(code, reason);
    },
    onMessage(listener) {
      socket.on("message", (data: RawData, isBinary: boolean) => {
        const bytes = Array.isArray(data)
          ? Buffer.concat(data)
          : data instanceof ArrayBuffer
            ? Buffer.from(data)
            : Buffer.from(data);
        listener(bytes, isBinary);
      });
    },
    onClose(listener) {
      socket.once("close", listener);
    },
  };
}

export function attachTerminalWebSocketGateway(input: {
  server: HttpsServer;
  deviceAuth: DeviceAuthService;
  membership: ProjectMembershipPort;
  streams: TerminalStreamService;
  now?: () => Date;
}): Readonly<{ dispose(): void }> {
  const protocol = new TerminalWebSocketProtocol(input.streams, input.membership);
  const websocketServer = new WebSocketServer({
    noServer: true,
    clientTracking: false,
    perMessageDeflate: false,
    maxPayload: MAX_MESSAGE_BYTES,
  });
  const onUpgrade = (
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): void => {
    void (async () => {
      if (request.url !== STREAM_PATH) {
        rejectUpgrade(socket, 404);
        return;
      }
      const token = bearerToken(request);
      if (!token) {
        rejectUpgrade(socket, 401);
        return;
      }
      let principalId: string;
      try {
        const claims = await input.deviceAuth.authorizeAccessToken(
          token,
          "terminal:write",
          input.now?.() ?? new Date(),
        );
        principalId = claims.sub;
      } catch {
        rejectUpgrade(socket, 403);
        return;
      }
      websocketServer.handleUpgrade(request, socket, head, (websocket) => {
        protocol.accept(principalId, wrapWebSocket(websocket));
      });
    })().catch(() => rejectUpgrade(socket, 403));
  };
  input.server.on("upgrade", onUpgrade);
  return Object.freeze({
    dispose() {
      input.server.removeListener("upgrade", onUpgrade);
      websocketServer.close();
    },
  });
}
