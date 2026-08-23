export const MAX_TERMINAL_FRAME_BYTES = 64 * 1024;
export const MAX_TERMINAL_REPLAY_BYTES = 8 * 1024 * 1024;
export const MAX_TERMINAL_REPLAY_AGE_MS = 30 * 60 * 1000;

import type { TerminalSession } from "./terminal-session.js";

export type TerminalOutputEvent = Readonly<{
  type: "server.output";
  sessionId: string;
  sequence: number;
  timestamp: string;
  data: string;
}>;

export type TerminalInputEvent = Readonly<{
  type: "server.input";
  sessionId: string;
  sequence: number;
  timestamp: string;
  inputId: string;
  status: "accepted" | "written" | "rejected" | "unknown";
}>;

export type TerminalLeaseEvent = Readonly<{
  type: "server.lease";
  sessionId: string;
  sequence: number;
  timestamp: string;
  ownerDeviceId: string;
  generation: number;
  expiresAt: string;
}>;

export type TerminalSessionStateEvent = Readonly<{
  type: "server.session";
  sessionId: string;
  sequence: number;
  timestamp: string;
  state: TerminalSession["state"];
  reason?: string;
}>;

/**
 * Every server event that carries a `sequence`.
 *
 * `asyncapi-contract.yaml` gives `server.output`, `server.input`, `server.lease`
 * and `server.session` a shared `EventBase`, and `client.ack` acknowledges a
 * bare `sequence`. They therefore MUST share one monotonic sequence space per
 * session — otherwise an acknowledgement is ambiguous and reconnect replay
 * cannot decide what the client already has. That is why lifecycle events live
 * in the replay log next to output rather than in a side channel.
 */
export type TerminalSequencedEvent =
  | TerminalOutputEvent
  | TerminalInputEvent
  | TerminalLeaseEvent
  | TerminalSessionStateEvent;

/** A lifecycle event before the log assigns it identity, sequence and time. */
export type TerminalLifecyclePayload =
  | Readonly<{ type: "server.input"; inputId: string; status: TerminalInputEvent["status"] }>
  | Readonly<{ type: "server.lease"; ownerDeviceId: string; generation: number; expiresAt: string }>
  | Readonly<{ type: "server.session"; state: TerminalSession["state"]; reason?: string }>;

export type TerminalReplayResult = Readonly<{
  events: readonly TerminalSequencedEvent[];
  nextSequence: number;
  historyTruncated: boolean;
}>;

type StoredOutputEvent = {
  event: TerminalSequencedEvent;
  bytes: number;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function splitUtf8(value: string, maxBytes: number): string[] {
  const chunks: string[] = [];
  let current = "";
  let currentBytes = 0;
  for (const character of value) {
    const characterBytes = utf8Bytes(character);
    if (currentBytes + characterBytes > maxBytes && current.length > 0) {
      chunks.push(current);
      current = "";
      currentBytes = 0;
    }
    current += character;
    currentBytes += characterBytes;
  }
  if (current.length > 0) {
    chunks.push(current);
  }
  return chunks;
}

export class TerminalReplayBuffer {
  private readonly entries: StoredOutputEvent[] = [];
  private totalBytes = 0;
  private next = 1;

  constructor(
    readonly sessionId: string,
    private readonly maxBytes = MAX_TERMINAL_REPLAY_BYTES,
    private readonly maxAgeMs = MAX_TERMINAL_REPLAY_AGE_MS,
    private readonly maxEvents = 4_096,
  ) {
    if (
      !UUID_PATTERN.test(sessionId) ||
      !Number.isSafeInteger(maxBytes) ||
      maxBytes <= 0 ||
      maxBytes > MAX_TERMINAL_REPLAY_BYTES ||
      !Number.isSafeInteger(maxAgeMs) ||
      maxAgeMs <= 0 ||
      maxAgeMs > MAX_TERMINAL_REPLAY_AGE_MS ||
      !Number.isSafeInteger(maxEvents) ||
      maxEvents <= 0
    ) {
      throw new Error("Terminal replay limits are invalid");
    }
  }

  private prune(now: Date): void {
    const oldestTimestamp = now.getTime() - this.maxAgeMs;
    while (
      this.entries.length > 0 &&
      (
        this.entries.length > this.maxEvents ||
        this.totalBytes > this.maxBytes ||
        Date.parse(this.entries[0]!.event.timestamp) < oldestTimestamp
      )
    ) {
      const removed = this.entries.shift();
      if (removed) {
        this.totalBytes -= removed.bytes;
      }
    }
  }

  append(sanitizedData: string, now = new Date()): readonly TerminalOutputEvent[] {
    if (sanitizedData.length === 0) {
      this.prune(now);
      return [];
    }
    const appended: TerminalOutputEvent[] = [];
    for (const data of splitUtf8(sanitizedData, MAX_TERMINAL_FRAME_BYTES)) {
      const bytes = utf8Bytes(data);
      const event = Object.freeze({
        type: "server.output" as const,
        sessionId: this.sessionId,
        sequence: this.next,
        timestamp: now.toISOString(),
        data,
      });
      this.next += 1;
      this.entries.push({ event, bytes });
      this.totalBytes += bytes;
      appended.push(event);
      this.prune(now);
    }
    return Object.freeze(appended);
  }

  /**
   * Appends one lifecycle event, taking the next sequence from the same space as
   * terminal output so a single `client.ack` covers both.
   */
  appendLifecycle(payload: TerminalLifecyclePayload, now = new Date()): TerminalSequencedEvent {
    const event = Object.freeze({
      ...payload,
      sessionId: this.sessionId,
      sequence: this.next,
      timestamp: now.toISOString(),
    }) as TerminalSequencedEvent;
    this.next += 1;
    const bytes = utf8Bytes(JSON.stringify(event));
    this.entries.push({ event, bytes });
    this.totalBytes += bytes;
    this.prune(now);
    return event;
  }

  replayAfter(lastAckSequence: number, now = new Date()): TerminalReplayResult {
    if (
      !Number.isSafeInteger(lastAckSequence) ||
      lastAckSequence < 0 ||
      lastAckSequence >= this.next
    ) {
      throw new Error("Acknowledged terminal sequence is invalid");
    }
    this.prune(now);
    const earliest = this.entries[0]?.event.sequence ?? this.next;
    const historyTruncated = lastAckSequence < earliest - 1;
    return Object.freeze({
      events: historyTruncated
        ? Object.freeze([])
        : Object.freeze(
          this.entries
            .map(({ event }) => event)
            .filter((event) => event.sequence > lastAckSequence),
        ),
      nextSequence: this.next,
      historyTruncated,
    });
  }

  snapshot(): Readonly<{ retainedEvents: number; retainedBytes: number; nextSequence: number }> {
    return Object.freeze({
      retainedEvents: this.entries.length,
      retainedBytes: this.totalBytes,
      nextSequence: this.next,
    });
  }
}
