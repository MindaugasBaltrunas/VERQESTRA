import { GatewayHttpClient, TerminalStreamClient } from "../core";
import type {
  AgLoopUiReadPort,
  CredentialPort,
  DeviceProofPort,
  GatewayPort,
  HostConnectionsReadPort,
  MobileHttpTransportPort,
  MobileIdPort,
  MobileWebSocketFactory,
  ProjectsReadPort,
  ReconnectSchedulerPort,
  SessionReviewReadPort,
  TerminalStreamClientObserver,
  TerminalStreamControlPort,
} from "../core";
import type { AppProps } from "../App";

/**
 * Platform composition root of the native shell.
 *
 * `create-app-runtime.ts` deliberately takes its ports from outside; this is the
 * module that builds the ones React Native itself can provide — the HTTP
 * transport, the WebSocket transport, the reconnect clock and the UUID source —
 * and hands the shell whatever ports exist. It adds no dependency: `fetch`,
 * `WebSocket`, `setTimeout` and `crypto` are Hermes/React Native globals, so the
 * transports below are adapters over the runtime, not over a package.
 *
 * What this module does NOT construct, and why — each is a named follow-up, not
 * an omission:
 *
 *  - the four read ports (`agLoopReads`, `sessionReviewReads`, `connectionsReads`,
 *    `projectsReads`). No adapter implements them anywhere in the workspace: the
 *    contracts live in `mobile-app/src/model/*-read.ts` and the gateway serves
 *    the endpoints (`contracts/api-contract.yaml`), but the HTTP clients between
 *    them were never written. They belong beside `gateway-http-client.ts` in the
 *    platform-independent package, not here, so this module accepts them and
 *    never invents them;
 *  - `CredentialPort` and `DeviceProofPort`, which `GatewayHttpClient` needs —
 *    both are backed by the OS keystore (task 119);
 *  - `TerminalWriteGatePort`, which `MobileTerminalPorts` requires (task 120),
 *    and `SpeechRecognitionPort` (task 121);
 *  - `MobileTerminalPorts` as a whole, for a reason no adapter task removes:
 *    its `stream` port only reports to the UI through an observer bound to the
 *    reducer's `dispatch`, and `dispatch` is created inside `App` by
 *    `useReducer`. Nothing that runs before `App` mounts can build it, so the
 *    terminal ports cannot be a prop composed at the entry point the way the
 *    read ports can. {@link createTerminalStreamControl} is the piece that
 *    closes once a caller with a dispatcher exists.
 */

/** Explicit configuration point for the host gateway; deliberately has no default. */
export const gatewayBaseUrlVariable = "EXPO_PUBLIC_VERQESTRA_GATEWAY_URL";

/**
 * Same shape `gateway-format.ts` enforces on the core side. It is restated here
 * rather than imported because the core does not export it, and a shell that
 * accepted a looser URL would only push the rejection into the first request.
 */
const gatewayBaseUrlPattern = /^https:\/\/[^/?#]+(?::\d+)?\/v1$/;

const httpsPrefix = "https://";

/**
 * Minimal structural views of the React Native globals. They are declared here
 * instead of pulled from a DOM or React Native lib because this module is also
 * read by the Node-only shell suites, and a global's full type would drag a
 * device toolchain into a source check.
 */
type FetchLike = (url: string, init: Readonly<{
  method: string;
  headers: Readonly<Record<string, string>>;
  body?: string;
}>) => Promise<Readonly<{ status: number; text(): Promise<string> }>>;

type WebSocketLike = {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onmessage: ((event: Readonly<{ data: unknown }>) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
};

/**
 * React Native's own constructor signature: the third argument carries the
 * request headers, which is the only way the stream can present its bearer token
 * — the browser `WebSocket` has no equivalent.
 */
type WebSocketConstructorLike = new (
  url: string,
  protocols: undefined,
  options: Readonly<{ headers: Readonly<Record<string, string>> }>,
) => WebSocketLike;

type TimerSchedulerLike = Readonly<{
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}>;

type RandomUuidLike = () => string;

/**
 * The platform globals this shell reads, and nothing else. The assertion is the
 * one unavoidable one in the package: `globalThis` is typed by whichever lib the
 * consuming tsconfig loads, and this module must compile under the Node-only
 * shell config as well as under Expo's.
 */
type NativeGlobals = Readonly<{
  fetch?: FetchLike;
  WebSocket?: WebSocketConstructorLike;
  setTimeout?: TimerSchedulerLike["setTimeout"];
  clearTimeout?: TimerSchedulerLike["clearTimeout"];
  crypto?: Readonly<{ randomUUID?: RandomUuidLike }>;
  process?: Readonly<{ env?: Readonly<{ EXPO_PUBLIC_VERQESTRA_GATEWAY_URL?: string }> }>;
}>;

function nativeGlobals(): NativeGlobals {
  return globalThis as unknown as NativeGlobals;
}

/**
 * The configured value, read as a literal member expression on purpose: Expo
 * inlines `process.env.EXPO_PUBLIC_*` into the bundle at build time, and only
 * for a static property access. A lookup by variable key — the obvious way to
 * write this — survives typecheck and every Node-side test, then reads
 * `undefined` on device, where nothing is left to look it up in.
 */
function configuredGatewayBaseUrl(): string | undefined {
  return nativeGlobals().process?.env?.EXPO_PUBLIC_VERQESTRA_GATEWAY_URL;
}

/**
 * The configured gateway base URL, or `null` when the build named none or named
 * one the core would reject. `null` is a real answer: an unconfigured build has
 * no host, and the spaces say so rather than dialling a guessed address.
 */
export function readGatewayBaseUrl(value: string | undefined): string | null {
  return value !== undefined && gatewayBaseUrlPattern.test(value) ? value : null;
}

/**
 * Terminal stream endpoint of a gateway. Derived, never configured separately:
 * two URLs pointing at different hosts is a failure mode with no upside, and the
 * core validates the `wss://…/v1/terminal-stream` shape this produces.
 */
export function terminalStreamUrl(baseUrl: string): string {
  return `wss://${baseUrl.slice(httpsPrefix.length)}/terminal-stream`;
}

/** `MobileHttpTransportPort` over the runtime `fetch`; it adds no policy of its own. */
export function createFetchHttpTransport(fetchImpl: FetchLike): MobileHttpTransportPort {
  return Object.freeze({
    async request(input: Parameters<MobileHttpTransportPort["request"]>[0]) {
      // A rejected `fetch` is deliberately not caught here: `GatewayHttpClient`
      // maps it onto its own `transport_failed`, and catching it twice would
      // mean two places deciding what a dead network looks like.
      const response = await fetchImpl(input.url, {
        method: input.method,
        headers: input.headers,
        ...(input.body === undefined ? {} : { body: input.body }),
      });
      return Object.freeze({ status: response.status, body: await response.text() });
    },
  });
}

/** `MobileWebSocketFactory` over the runtime `WebSocket`. */
export function createWebSocketFactory(
  construct: WebSocketConstructorLike,
): MobileWebSocketFactory {
  return Object.freeze({
    create(input: Parameters<MobileWebSocketFactory["create"]>[0]) {
      const socket = new construct(input.url, undefined, { headers: input.headers });
      return Object.freeze({
        send(text: string) {
          socket.send(text);
        },
        close(code: number, reason: string) {
          socket.close(code, reason);
        },
        onOpen(listener: () => void) {
          socket.onopen = listener;
        },
        onMessage(listener: (text: string) => void) {
          // The gateway stream is a text protocol. A binary frame is a protocol
          // violation, and an empty payload is what the client already treats as
          // one — so it is forwarded as such instead of being dropped, which
          // would leave the stream waiting for a frame that already arrived.
          socket.onmessage = (event) => {
            listener(typeof event.data === "string" ? event.data : "");
          };
        },
        onClose(listener: () => void) {
          socket.onclose = listener;
        },
        onError(listener: () => void) {
          socket.onerror = listener;
        },
      });
    },
  });
}

/** `ReconnectSchedulerPort` over the runtime timers; the backoff itself is the core's. */
export function createReconnectScheduler(timers: TimerSchedulerLike): ReconnectSchedulerPort {
  return Object.freeze({
    schedule(delayMs: number, callback: () => void) {
      const handle = timers.setTimeout(callback, delayMs);
      return Object.freeze({
        cancel() {
          timers.clearTimeout(handle);
        },
      });
    },
  });
}

/**
 * `MobileIdPort` over the runtime CSPRNG. The shape is not checked here on
 * purpose: `GatewayHttpClient` rejects a malformed id itself, so a device whose
 * runtime returns something else fails at the request it would have corrupted
 * rather than at startup.
 */
export function createUuidSource(randomUuid: RandomUuidLike): MobileIdPort {
  return Object.freeze({ nextUuid: () => randomUuid() });
}

/**
 * Everything the gateway ports need from the platform, or `null` when the build
 * named no gateway or the runtime is missing a global this shell cannot
 * substitute.
 */
export type NativeGatewayTransports = Readonly<{
  baseUrl: string;
  streamUrl: string;
  transport: MobileHttpTransportPort;
  sockets: MobileWebSocketFactory;
  scheduler: ReconnectSchedulerPort;
  ids: MobileIdPort;
}>;

export function createNativeGatewayTransports(
  configuredUrl: string | undefined = configuredGatewayBaseUrl(),
  globals: NativeGlobals = nativeGlobals(),
): NativeGatewayTransports | null {
  const baseUrl = readGatewayBaseUrl(configuredUrl);
  const { fetch: fetchImpl, WebSocket: socketConstructor, crypto } = globals;
  const setTimeoutImpl = globals.setTimeout;
  const clearTimeoutImpl = globals.clearTimeout;
  const randomUuid = crypto?.randomUUID;
  if (
    baseUrl === null ||
    fetchImpl === undefined ||
    socketConstructor === undefined ||
    setTimeoutImpl === undefined ||
    clearTimeoutImpl === undefined ||
    randomUuid === undefined
  ) {
    return null;
  }
  return Object.freeze({
    baseUrl,
    streamUrl: terminalStreamUrl(baseUrl),
    transport: createFetchHttpTransport(fetchImpl),
    sockets: createWebSocketFactory(socketConstructor),
    scheduler: createReconnectScheduler(Object.freeze({
      setTimeout: setTimeoutImpl,
      clearTimeout: clearTimeoutImpl,
    })),
    ids: createUuidSource(() => randomUuid.call(crypto)),
  });
}

/** The gateway write port. Its credential and proof ports are the keystore's (task 119). */
export function createGatewayPort(input: Readonly<{
  transports: NativeGatewayTransports;
  credentials: CredentialPort;
  proofs: DeviceProofPort;
}>): GatewayPort {
  return new GatewayHttpClient(
    input.transports.baseUrl,
    input.transports.transport,
    input.credentials,
    input.proofs,
    input.transports.ids,
  );
}

/**
 * The terminal stream port. The observer is the caller's because it is the only
 * part that needs the reducer's `dispatch`; see the module note on why no caller
 * with one exists yet.
 */
export function createTerminalStreamControl(input: Readonly<{
  transports: NativeGatewayTransports;
  observer: TerminalStreamClientObserver;
}>): TerminalStreamControlPort {
  return new TerminalStreamClient(input.transports.sockets, input.transports.scheduler, input.observer);
}

/**
 * Ports the shell is given rather than building. Every one of them is optional
 * for the same reason the matching `AppProps` field is: a space whose port is
 * absent reports that it is unwired instead of showing invented data.
 */
export type NativePlatformPorts = Readonly<{
  agLoopReads?: AgLoopUiReadPort;
  sessionReviewReads?: SessionReviewReadPort;
  connectionsReads?: HostConnectionsReadPort;
  projectsReads?: ProjectsReadPort;
  projectId?: string;
  sessionId?: string;
}>;

/**
 * The props the entry point mounts `App` with. Conditional spreads rather than
 * explicit `undefined`, so a port the shell has no answer for is absent from the
 * object instead of present and empty.
 */
export function createNativeAppProps(ports: NativePlatformPorts = {}): AppProps {
  return Object.freeze({
    ...(ports.agLoopReads === undefined ? {} : { agLoopReads: ports.agLoopReads }),
    ...(ports.sessionReviewReads === undefined
      ? {}
      : { sessionReviewReads: ports.sessionReviewReads }),
    ...(ports.connectionsReads === undefined ? {} : { connectionsReads: ports.connectionsReads }),
    ...(ports.projectsReads === undefined ? {} : { projectsReads: ports.projectsReads }),
    ...(ports.projectId === undefined ? {} : { projectId: ports.projectId }),
    ...(ports.sessionId === undefined ? {} : { sessionId: ports.sessionId }),
  });
}
