import type {
  TerminalOutputStream,
  TerminalSessionSnapshot,
} from "./terminal-supervisor.js";
import type { TerminalSequencedEvent } from "../domain/terminal-replay-buffer.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type TerminalStreamLimits = Readonly<{
  maxBufferedBytes: number;
  maxUnacknowledgedEvents: number;
}>;

export const TERMINAL_STREAM_LIMITS: TerminalStreamLimits = Object.freeze({
  maxBufferedBytes: 1024 * 1024,
  maxUnacknowledgedEvents: 256,
});

export type TerminalSnapshotEvent = Readonly<{
  type: "server.snapshot";
  sessionId: string;
  timestamp: string;
  state: TerminalSessionSnapshot["state"];
  lease: Readonly<{
    ownerDeviceId: string;
    generation: number;
    expiresAt: string;
  }>;
  nextSequence: number;
  historyTruncated: boolean;
}>;

/** Error frame from `asyncapi-contract.yaml`; unsequenced, so it never consumes an ack. */
export type TerminalStreamErrorEvent = Readonly<{
  type: "server.error";
  code: string;
  recoverable: boolean;
  correlationId: string;
}>;

export type TerminalStreamServerEvent =
  | TerminalSnapshotEvent
  | TerminalSequencedEvent
  | TerminalStreamErrorEvent;

/**
 * The full protocol vocabulary, asserted against `asyncapi-contract.yaml` by
 * `asyncapi-contract-conformance.test.ts` so declared and produced message
 * types cannot drift.
 */
export const TERMINAL_STREAM_SERVER_MESSAGE_TYPES = Object.freeze([
  "server.snapshot",
  "server.output",
  "server.input",
  "server.lease",
  "server.session",
  "server.error",
] as const);

export const TERMINAL_STREAM_CLIENT_MESSAGE_TYPES = Object.freeze([
  "client.hello",
  "client.ack",
  "client.heartbeat",
] as const);

export interface TerminalOutputStreamPort {
  openOutputStream(input: {
    projectId: string;
    sessionId: string;
    lastAckSequence: number;
    onEvent: (event: TerminalSequencedEvent) => void;
  }): Promise<TerminalOutputStream>;
}

export interface TerminalStreamSink {
  send(event: TerminalStreamServerEvent): Promise<void>;
  bufferedBytes(): number;
  close(code: number, reason: string): void;
}

export type TerminalStreamConnection = Readonly<{
  acknowledge(input: { sessionId: string; sequence: number }): Promise<void>;
  heartbeat(input: { timestamp: string }): Promise<void>;
  close(): Promise<void>;
}>;

export class TerminalStreamError extends Error {
  constructor(
    readonly code: "invalid_message" | "backpressure" | "transport_failed",
    message: string,
  ) {
    super(message);
    this.name = "TerminalStreamError";
  }
}

export class TerminalStreamService {
  constructor(
    private readonly terminals: TerminalOutputStreamPort,
    private readonly clock: () => Date = () => new Date(),
    private readonly limits: TerminalStreamLimits = TERMINAL_STREAM_LIMITS,
  ) {
    if (
      !Number.isSafeInteger(limits.maxBufferedBytes) ||
      limits.maxBufferedBytes <= 0 ||
      !Number.isSafeInteger(limits.maxUnacknowledgedEvents) ||
      limits.maxUnacknowledgedEvents <= 0
    ) {
      throw new Error("Terminal stream limits are invalid");
    }
  }

  async connect(
    input: {
      projectId: string;
      sessionId: string;
      lastAckSequence: number;
    },
    sink: TerminalStreamSink,
  ): Promise<TerminalStreamConnection> {
    if (
      !UUID_PATTERN.test(input.projectId) ||
      !UUID_PATTERN.test(input.sessionId) ||
      !Number.isSafeInteger(input.lastAckSequence) ||
      input.lastAckSequence < 0
    ) {
      throw new TerminalStreamError("invalid_message", "Terminal hello is invalid");
    }

    let closed = false;
    let ready = false;
    let lastAcknowledged = input.lastAckSequence;
    let latestSent = input.lastAckSequence;
    let sendQueue = Promise.resolve();
    let stream: TerminalOutputStream | undefined;
    let streamClose: Promise<void> | undefined;
    const beforeReady: TerminalSequencedEvent[] = [];

    const closeStream = (): Promise<void> => {
      if (!stream) return Promise.resolve();
      streamClose ??= stream.close();
      return streamClose;
    };
    const closeTransport = (code: number, reason: string): void => {
      if (closed) return;
      closed = true;
      sink.close(code, reason);
      void closeStream().catch(() => undefined);
    };
    const queueEvent = (event: TerminalSequencedEvent): void => {
      if (closed || event.sequence <= latestSent) return;
      if (!ready) {
        if (beforeReady.length >= this.limits.maxUnacknowledgedEvents) {
          closeTransport(1013, "terminal stream initialization overflow");
          return;
        }
        beforeReady.push(event);
        return;
      }
      sendQueue = sendQueue.then(async () => {
        if (closed || event.sequence <= latestSent) return;
        if (
          sink.bufferedBytes() > this.limits.maxBufferedBytes ||
          event.sequence - lastAcknowledged > this.limits.maxUnacknowledgedEvents
        ) {
          closeTransport(1013, "terminal stream backpressure");
          return;
        }
        try {
          await sink.send(event);
          latestSent = event.sequence;
        } catch {
          closeTransport(1011, "terminal stream send failed");
        }
      });
    };

    stream = await this.terminals.openOutputStream({
      ...input,
      onEvent: queueEvent,
    });
    if (closed) void closeStream().catch(() => undefined);
    try {
      await sink.send(Object.freeze({
        type: "server.snapshot" as const,
        sessionId: stream.snapshot.sessionId,
        timestamp: this.clock().toISOString(),
        state: stream.snapshot.state,
        lease: Object.freeze({
          ownerDeviceId: stream.snapshot.lease.ownerDeviceId,
          generation: stream.snapshot.lease.generation,
          expiresAt: stream.snapshot.lease.expiresAt,
        }),
        nextSequence: stream.replay.nextSequence,
        historyTruncated: stream.replay.historyTruncated,
      }));
      for (const event of stream.replay.events) {
        if (
          sink.bufferedBytes() > this.limits.maxBufferedBytes ||
          event.sequence - lastAcknowledged > this.limits.maxUnacknowledgedEvents
        ) {
          closeTransport(1013, "terminal replay backpressure");
          break;
        }
        await sink.send(event);
        latestSent = event.sequence;
      }
    } catch {
      closeTransport(1011, "terminal stream initialization failed");
    }
    ready = true;
    for (const event of beforeReady) queueEvent(event);
    beforeReady.length = 0;

    return Object.freeze({
      acknowledge: async ({ sessionId, sequence }) => {
        if (
          closed ||
          sessionId !== input.sessionId ||
          !Number.isSafeInteger(sequence) ||
          sequence < lastAcknowledged ||
          sequence > latestSent
        ) {
          closeTransport(1008, "invalid terminal acknowledgement");
          throw new TerminalStreamError("invalid_message", "Terminal acknowledgement is invalid");
        }
        lastAcknowledged = sequence;
      },
      heartbeat: async ({ timestamp }) => {
        if (closed || !Number.isFinite(Date.parse(timestamp))) {
          closeTransport(1008, "invalid terminal heartbeat");
          throw new TerminalStreamError("invalid_message", "Terminal heartbeat is invalid");
        }
      },
      close: async () => {
        if (!closed) closed = true;
        await sendQueue;
        await closeStream();
      },
    });
  }
}
