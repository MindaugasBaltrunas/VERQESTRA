import { GatewayHttpClient, TerminalStreamClient } from "../core";
import type {
  MobileHttpTransportPort,
  MobileWebSocketFactory,
  MobileWebSocketPort,
} from "../core";

/**
 * Platform transports for the two network adapters the MVC core defines but
 * cannot build itself: `GatewayHttpClient` needs an HTTP transport,
 * `TerminalStreamClient` needs a WebSocket factory. Both wrap globals React
 * Native already provides (`fetch`, `WebSocket`), so this module adds no new
 * dependency.
 *
 * `CredentialPort`, `DeviceProofPort` and `MobileIdPort` have no production
 * adapter yet — the former two need `expo-secure-store` and device-identity
 * signing (tasks 119/120), the third needs a random UUID source. The two
 * factories below accept them as parameters instead of constructing them, so
 * this module wires exactly what exists today and leaves the rest to the
 * task that supplies those adapters.
 */

export function createReactNativeHttpTransport(): MobileHttpTransportPort {
  return {
    async request(input) {
      const response = await fetch(input.url, {
        method: input.method,
        headers: input.headers,
        ...(input.body === undefined ? {} : { body: input.body }),
      });
      return Object.freeze({
        status: response.status,
        body: await response.text(),
      });
    },
  };
}

/**
 * React Native's `WebSocket` accepts a third constructor argument carrying
 * request headers — the only way to attach the bearer token to the stream
 * handshake, since a mobile client has no cookie jar to rely on. That
 * argument is a React Native runtime extension the ambient `WebSocket` type
 * available at build time does not declare, hence the local override.
 */
interface ReactNativeWebSocketConstructor {
  new(
    url: string,
    protocols: undefined,
    options: Readonly<{ headers: Readonly<Record<string, string>> }>,
  ): WebSocket;
}

function toMobileSocket(socket: WebSocket): MobileWebSocketPort {
  return {
    send: (text) => socket.send(text),
    close: (code, reason) => socket.close(code, reason),
    onOpen: (listener) => {
      socket.onopen = () => listener();
    },
    onMessage: (listener) => {
      socket.onmessage = (event) => listener(String(event.data));
    },
    onClose: (listener) => {
      socket.onclose = () => listener();
    },
    onError: (listener) => {
      socket.onerror = () => listener();
    },
  };
}

export function createReactNativeWebSocketFactory(): MobileWebSocketFactory {
  const NativeWebSocket = WebSocket as unknown as ReactNativeWebSocketConstructor;
  return {
    create(input) {
      const socket = new NativeWebSocket(input.url, undefined, { headers: input.headers });
      return toMobileSocket(socket);
    },
  };
}

/**
 * Expo inlines `EXPO_PUBLIC_`-prefixed environment variables into the client
 * bundle at build time; that mechanism, not a config file or a new
 * dependency, is the "explicit configuration point" this variable name is
 * read from. There is deliberately no fallback: a gateway shell with no
 * configured host must fail loudly rather than default to guessing one.
 */
export function readGatewayBaseUrl(): string {
  const value = process.env.EXPO_PUBLIC_GATEWAY_BASE_URL;
  if (!value) {
    throw new Error("EXPO_PUBLIC_GATEWAY_BASE_URL is not configured");
  }
  return value;
}

type GatewayHttpClientParams = ConstructorParameters<typeof GatewayHttpClient>;

export function createGatewayHttpClient(input: Readonly<{
  baseUrl: GatewayHttpClientParams[0];
  credentials: GatewayHttpClientParams[2];
  proofs: GatewayHttpClientParams[3];
  ids: GatewayHttpClientParams[4];
  transport?: MobileHttpTransportPort;
}>): GatewayHttpClient {
  return new GatewayHttpClient(
    input.baseUrl,
    input.transport ?? createReactNativeHttpTransport(),
    input.credentials,
    input.proofs,
    input.ids,
  );
}

type TerminalStreamClientParams = ConstructorParameters<typeof TerminalStreamClient>;

export function createTerminalStreamClient(input: Readonly<{
  scheduler: TerminalStreamClientParams[1];
  observer: TerminalStreamClientParams[2];
  sockets?: MobileWebSocketFactory;
}>): TerminalStreamClient {
  return new TerminalStreamClient(
    input.sockets ?? createReactNativeWebSocketFactory(),
    input.scheduler,
    input.observer,
  );
}
