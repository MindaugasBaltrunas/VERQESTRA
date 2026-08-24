import type { ConnectionState, TerminalState } from "../../model/state.js";
import {
  exactKeys,
  isDateTime,
  isRecord,
  isSafeInteger,
  UUID_PATTERN,
  type JsonRecord,
} from "../shared/gateway-format.js";

/**
 * NUKRYPIMAS (dubliavimas, ne elgesys): etalone šis failas turėjo SAVO `isRecord`, `exactKeys`,
 * `parseJson`, `validDateTime` ir savo `UUID_PATTERN` kopijas. Keturios pirmosios buvo
 * pažodinės `gateway-format.ts` kopijos, tad jos importuojamos — dvi to paties fakto kopijos
 * yra būtent tai, kas šioje migracijoje jau kartą leido lūžiui pragyventi.
 *
 * DU dalykai SĄMONINGAI palikti vietiniai, nes jie NE kopijos:
 *  - `ACCESS_TOKEN_PATTERN` čia yra `[A-Za-z0-9._~-]{16,4096}`, o `gateway-format.ts` — dviejų
 *    segmentų `a.b` forma. WebSocket'as tikrina, ar tokenas apskritai gali keliauti antraštėje;
 *    HTTP klientas tikrina saugomo kredencialo formą. Suvienodinimas būtų tylus vieno iš dviejų
 *    kontraktų sugriežtinimas arba atlaisvinimas.
 *  - `parseJson` čia be 1 MiB baitų ribos: srauto kadrai ribojami `MAX_OUTPUT_CHARACTERS` ir
 *    transporto, o `gateway-format.parseJson` riba aprašo HTTP atsakymo kūną.
 */
const ACCESS_TOKEN_PATTERN = /^[A-Za-z0-9._~-]{16,4096}$/;
const MAX_OUTPUT_CHARACTERS = 65_536;

export interface MobileWebSocketPort {
  send(text: string): void;
  close(code: number, reason: string): void;
  onOpen(listener: () => void): void;
  onMessage(listener: (text: string) => void): void;
  onClose(listener: () => void): void;
  onError(listener: () => void): void;
}

export interface MobileWebSocketFactory {
  create(input: Readonly<{
    url: string;
    headers: Readonly<{ Authorization: string }>;
  }>): MobileWebSocketPort;
}

export interface ReconnectSchedulerPort {
  schedule(delayMs: number, callback: () => void): Readonly<{ cancel(): void }>;
}

export type TerminalStreamSnapshot = Readonly<{
  sessionId: string;
  state: TerminalState;
  ownerDeviceId: string;
  leaseGeneration: number;
  leaseExpiresAt: string;
  nextSequence: number;
  historyTruncated: boolean;
}>;

export interface TerminalStreamClientObserver {
  onConnectionChanged(state: ConnectionState): void;
  onSnapshot(snapshot: TerminalStreamSnapshot): void;
  onOutput(data: string, sequence: number): void;
  onHistoryTruncated(firstAvailableSequence: number): void;
  onError(code: "invalid_configuration" | "protocol_error" | "transport_error"): void;
}

export type TerminalStreamClientInput = Readonly<{
  url: string;
  accessToken: string;
  projectId: string;
  sessionId: string;
  lastAckSequence: number;
}>;

function parseJson(text: string): JsonRecord | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function terminalState(value: unknown): TerminalState | undefined {
  switch (value) {
    case "live":
    case "closing":
    case "ended":
    case "failed":
      return value;
    case "creating":
    case "starting":
      return "creating";
    case "interrupting":
      return "live";
    case "orphaned":
      return "read-only";
    default:
      return undefined;
  }
}

function parseSnapshot(value: JsonRecord, sessionId: string): TerminalStreamSnapshot | undefined {
  if (
    !exactKeys(value, [
      "type",
      "sessionId",
      "timestamp",
      "state",
      "lease",
      "nextSequence",
      "historyTruncated",
    ])
  ) {
    return undefined;
  }
  const nextSequence = value["nextSequence"];
  const historyTruncated = value["historyTruncated"];
  const lease = value["lease"];
  if (
    value["type"] !== "server.snapshot" ||
    value["sessionId"] !== sessionId ||
    !isDateTime(value["timestamp"]) ||
    !isSafeInteger(nextSequence) ||
    nextSequence < 1 ||
    typeof historyTruncated !== "boolean" ||
    !isRecord(lease) ||
    !exactKeys(lease, ["ownerDeviceId", "generation", "expiresAt"])
  ) {
    return undefined;
  }
  const generation = lease["generation"];
  const expiresAt = lease["expiresAt"];
  if (
    !UUID_PATTERN.test(String(lease["ownerDeviceId"])) ||
    !isSafeInteger(generation) ||
    generation < 1 ||
    !isDateTime(expiresAt)
  ) {
    return undefined;
  }
  const state = terminalState(value["state"]);
  if (!state) return undefined;
  return Object.freeze({
    sessionId,
    state,
    ownerDeviceId: String(lease["ownerDeviceId"]),
    leaseGeneration: generation,
    leaseExpiresAt: expiresAt,
    nextSequence,
    historyTruncated,
  });
}

function parseOutput(value: JsonRecord, sessionId: string): Readonly<{
  sequence: number;
  data: string;
}> | undefined {
  const sequence = value["sequence"];
  const data = value["data"];
  if (
    !exactKeys(value, ["type", "sessionId", "sequence", "timestamp", "data"]) ||
    value["type"] !== "server.output" ||
    value["sessionId"] !== sessionId ||
    !isSafeInteger(sequence) ||
    sequence < 1 ||
    !isDateTime(value["timestamp"]) ||
    typeof data !== "string" ||
    data.length > MAX_OUTPUT_CHARACTERS
  ) {
    return undefined;
  }
  return Object.freeze({ sequence, data });
}

function validInput(input: TerminalStreamClientInput): boolean {
  return (
    /^wss:\/\/[^/?#]+(?::\d+)?\/v1\/terminal-stream$/.test(input.url) &&
    ACCESS_TOKEN_PATTERN.test(input.accessToken) &&
    UUID_PATTERN.test(input.projectId) &&
    UUID_PATTERN.test(input.sessionId) &&
    Number.isSafeInteger(input.lastAckSequence) &&
    input.lastAckSequence >= 0
  );
}

export class TerminalStreamClient {
  private desiredInput: TerminalStreamClientInput | undefined;
  private socket: MobileWebSocketPort | undefined;
  private reconnectTimer: Readonly<{ cancel(): void }> | undefined;
  private generation = 0;
  private reconnectAttempt = 0;
  private lastAckSequence = 0;
  private receivedSnapshot = false;
  private allowTruncatedGap = false;

  constructor(
    private readonly sockets: MobileWebSocketFactory,
    private readonly scheduler: ReconnectSchedulerPort,
    private readonly observer: TerminalStreamClientObserver,
  ) {}

  start(input: TerminalStreamClientInput): void {
    if (!validInput(input)) {
      this.observer.onError("invalid_configuration");
      return;
    }
    this.stopSocket();
    this.desiredInput = Object.freeze({ ...input });
    this.lastAckSequence = input.lastAckSequence;
    this.reconnectAttempt = 0;
    this.open("connecting");
  }

  stop(): void {
    this.desiredInput = undefined;
    this.reconnectTimer?.cancel();
    this.reconnectTimer = undefined;
    this.stopSocket();
    this.observer.onConnectionChanged("disconnected");
  }

  private stopSocket(): void {
    this.generation += 1;
    const active = this.socket;
    this.socket = undefined;
    active?.close(1000, "mobile stream detached");
  }

  private open(state: "connecting" | "reconnecting"): void {
    const input = this.desiredInput;
    if (!input) return;
    this.observer.onConnectionChanged(state);
    const socketGeneration = ++this.generation;
    this.receivedSnapshot = false;
    this.allowTruncatedGap = false;
    let socket: MobileWebSocketPort;
    try {
      socket = this.sockets.create({
        url: input.url,
        headers: Object.freeze({ Authorization: `Bearer ${input.accessToken}` }),
      });
    } catch {
      this.observer.onError("transport_error");
      this.scheduleReconnect(socketGeneration);
      return;
    }
    this.socket = socket;
    socket.onOpen(() => {
      if (!this.isCurrent(socketGeneration, socket)) return;
      socket.send(JSON.stringify({
        type: "client.hello",
        projectId: input.projectId,
        sessionId: input.sessionId,
        lastAckSequence: this.lastAckSequence,
      }));
    });
    socket.onMessage((text) => {
      if (!this.isCurrent(socketGeneration, socket)) return;
      this.handleMessage(text, input, socket, socketGeneration);
    });
    const disconnected = (): void => {
      if (!this.isCurrent(socketGeneration, socket)) return;
      this.socket = undefined;
      this.observer.onError("transport_error");
      this.scheduleReconnect(socketGeneration);
    };
    socket.onClose(disconnected);
    socket.onError(disconnected);
  }

  private isCurrent(generation: number, socket: MobileWebSocketPort): boolean {
    return generation === this.generation && socket === this.socket;
  }

  private handleMessage(
    text: string,
    input: TerminalStreamClientInput,
    socket: MobileWebSocketPort,
    socketGeneration: number,
  ): void {
    const message = parseJson(text);
    if (!message) {
      this.failProtocol(socket);
      return;
    }
    if (message["type"] === "server.snapshot") {
      if (this.receivedSnapshot) {
        this.failProtocol(socket);
        return;
      }
      const snapshot = parseSnapshot(message, input.sessionId);
      if (!snapshot || snapshot.nextSequence <= this.lastAckSequence) {
        this.failProtocol(socket);
        return;
      }
      this.receivedSnapshot = true;
      this.allowTruncatedGap = snapshot.historyTruncated;
      this.reconnectAttempt = 0;
      this.observer.onSnapshot(snapshot);
      this.observer.onConnectionChanged("live");
      return;
    }
    if (message["type"] === "server.output") {
      const output = parseOutput(message, input.sessionId);
      if (!this.receivedSnapshot || !output) {
        this.failProtocol(socket);
        return;
      }
      if (output.sequence <= this.lastAckSequence) {
        this.sendAcknowledgement(socket, input.sessionId);
        return;
      }
      const expected = this.lastAckSequence + 1;
      if (output.sequence !== expected) {
        if (!this.allowTruncatedGap) {
          this.failProtocol(socket);
          return;
        }
        this.observer.onHistoryTruncated(output.sequence);
      }
      this.allowTruncatedGap = false;
      this.observer.onOutput(output.data, output.sequence);
      this.lastAckSequence = output.sequence;
      this.sendAcknowledgement(socket, input.sessionId);
      return;
    }
    this.failProtocol(socket);
    if (this.isCurrent(socketGeneration, socket)) this.scheduleReconnect(socketGeneration);
  }

  private sendAcknowledgement(socket: MobileWebSocketPort, sessionId: string): void {
    socket.send(JSON.stringify({
      type: "client.ack",
      sessionId,
      sequence: this.lastAckSequence,
    }));
  }

  private failProtocol(socket: MobileWebSocketPort): void {
    if (socket !== this.socket) return;
    this.observer.onError("protocol_error");
    this.socket = undefined;
    this.generation += 1;
    socket.close(1008, "invalid gateway terminal event");
    this.scheduleReconnect(this.generation);
  }

  private scheduleReconnect(generation: number): void {
    if (!this.desiredInput || this.reconnectTimer || generation !== this.generation) return;
    this.observer.onConnectionChanged("reconnecting");
    const delayMs = Math.min(500 * (2 ** this.reconnectAttempt), 8_000);
    this.reconnectAttempt += 1;
    this.reconnectTimer = this.scheduler.schedule(delayMs, () => {
      this.reconnectTimer = undefined;
      if (!this.desiredInput || generation !== this.generation) return;
      this.open("reconnecting");
    });
  }
}
