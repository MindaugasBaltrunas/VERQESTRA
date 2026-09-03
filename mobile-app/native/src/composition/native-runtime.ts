import * as LocalAuthentication from "expo-local-authentication";
import * as SecureStore from "expo-secure-store";
import { ExpoSpeechRecognitionModule as SpeechRecognition } from "expo-speech-recognition";
import { GatewayHttpClient, SecureCloudConsentStore, TerminalStreamClient } from "../core";
import type {
  BiometricAuthenticatorPort,
  MobileHttpTransportPort,
  MobileWebSocketFactory,
  MobileWebSocketPort,
  SecureStorePort,
  SpeechConsentPort,
  SpeechRecognitionPort,
} from "../core";
import { createExpoBiometricAuthenticator } from "../adapters/expo-biometric-authenticator";
import type { ExpoLocalAuthenticationModule } from "../adapters/expo-biometric-authenticator";
import { createExpoSecureStoreAdapter } from "../adapters/expo-secure-store-adapter";
import type { ExpoSecureStoreModule } from "../adapters/expo-secure-store-adapter";
import { createNativeSpeechRecognizer } from "../adapters/native-speech-recognizer";
import type { ExpoSpeechRecognitionModule } from "../adapters/native-speech-recognizer";

/**
 * Platform transports for the two network adapters the MVC core defines but
 * cannot build itself: `GatewayHttpClient` needs an HTTP transport,
 * `TerminalStreamClient` needs a WebSocket factory. Both wrap globals React
 * Native already provides (`fetch`, `WebSocket`), so they add no dependency.
 *
 * This module is also where the platform packages the shell needs by name are
 * bound to ports: `expo-secure-store` behind `SecureStorePort`,
 * `expo-local-authentication` behind `BiometricAuthenticatorPort` and
 * `expo-speech-recognition` behind `SpeechRecognitionPort`. A composition root
 * is the correct place for that — the adapters themselves stay module-free, and
 * each import appears exactly once in the package.
 *
 * `DeviceProofPort` and `MobileIdPort` still have no production adapter: the
 * former needs device-identity signing, the latter a random UUID source. The
 * factories below accept them as parameters instead of constructing them, so this
 * module wires exactly what exists today.
 *
 * What still cannot be wired here, and why: `MobileTerminalPorts.writeGate` wants
 * the core's `BiometricWriteGate` decorator standing on the authenticator below,
 * and `credentials` wants `SecureCredentialStore` standing on the secure store
 * above. Neither class is re-exported by `@verqestra/mobile-app`'s barrel, and
 * `mvc-boundaries.test.ts` allows the shell no other route into the core — not
 * even through the seam module. Reaching them needs a barrel change, which is a
 * public-contract decision this package cannot take on its own.
 */

/**
 * `SecureStorePort` backed by the OS keystore.
 *
 * The annotated return type is the seam's only compile-time check that the
 * adapter's locally restated shape still matches the core's port: the adapter
 * cannot import `SecureStorePort` without becoming unloadable outside Metro, so
 * the two shapes meet here, in the one file that can see both.
 *
 * `WHEN_UNLOCKED_THIS_DEVICE_ONLY` is passed explicitly rather than defaulted
 * inside the adapter: pairing credentials must not travel in an encrypted backup
 * to a second device, and that is a decision worth reading in the wiring.
 */
export function createReactNativeSecureStore(
  module: ExpoSecureStoreModule = SecureStore,
): SecureStorePort {
  return createExpoSecureStoreAdapter({
    module,
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
}

/**
 * `BiometricAuthenticatorPort` backed by the OS biometric prompt.
 *
 * The annotated return type is the seam's only compile-time check that the
 * adapter's locally restated outcome union still matches the core's port, for
 * the same reason `createReactNativeSecureStore` carries one.
 *
 * The device-passcode fallback is left closed — the adapter's default — and is
 * not exposed as a parameter here: the gate in front of terminal writes asks for
 * a biometric confirmation, and an opt-out worth having would be a policy
 * decision written down in the core, not a flag a wiring site can flip.
 */
export function createReactNativeBiometricAuthenticator(
  module: ExpoLocalAuthenticationModule = LocalAuthentication,
): BiometricAuthenticatorPort {
  return createExpoBiometricAuthenticator({ module });
}

/**
 * Whether the speech module is actually linked into this binary.
 *
 * `expo-speech-recognition` is autolinked in a development or production build,
 * but a client running under a runtime that does not carry it resolves the
 * import to something with no methods on it. That case is a missing ability, not
 * a broken shell: `MobileTerminalPorts.speech` is optional precisely so an
 * unwired recogniser removes push-to-talk instead of leaving an unguarded voice
 * path behind, so it is detected here rather than surfacing as a crash on the
 * first hold.
 */
function isLinkedSpeechModule(
  module: Partial<ExpoSpeechRecognitionModule> | undefined,
): module is ExpoSpeechRecognitionModule {
  return module !== undefined
    && typeof module.isRecognitionAvailable === "function"
    && typeof module.supportsOnDeviceRecognition === "function"
    && typeof module.start === "function"
    && typeof module.addListener === "function";
}

/**
 * `SpeechRecognitionPort` backed by the platform recogniser, or `undefined` when
 * this build has none.
 *
 * The annotated return type is the seam's only compile-time check that the
 * adapter's locally restated capability, result and handle shapes still match
 * the core's port, for the same reason `createReactNativeSecureStore` carries
 * one.
 */
export function createReactNativeSpeechRecognizer(
  module: Partial<ExpoSpeechRecognitionModule> | undefined = SpeechRecognition,
): SpeechRecognitionPort | undefined {
  if (!isLinkedSpeechModule(module)) return undefined;
  return createNativeSpeechRecognizer({ module });
}

/**
 * `SpeechConsentPort` backed by the OS keystore.
 *
 * Unlike `writeGate` and `credentials` below, this decorator is reachable: the
 * core's barrel re-exports `SecureCloudConsentStore`, so the consent slot is
 * bound here instead of being left to a shell that would have to invent its own
 * storage — and inventing one is how a grant ends up somewhere it survives an
 * uninstall.
 */
export function createReactNativeSpeechConsent(
  store: SecureStorePort = createReactNativeSecureStore(),
): SpeechConsentPort {
  return new SecureCloudConsentStore(store);
}

/**
 * The pair `MobileTerminalPorts` takes for push-to-talk.
 *
 * `speech` is omitted rather than passed as `undefined` when no recogniser is
 * linked, so an unwired build hands the App exactly the shape it documents as
 * "no push-to-talk at all". `speechConsent` is always wired: it stores a refusal
 * as an absence, so a consent store with nothing in it blocks cloud
 * transcription rather than enabling anything.
 */
export function createReactNativeSpeechPorts(input?: Readonly<{
  module?: Partial<ExpoSpeechRecognitionModule> | undefined;
  store?: SecureStorePort;
}>): Readonly<{ speech?: SpeechRecognitionPort; speechConsent: SpeechConsentPort }> {
  const speech = createReactNativeSpeechRecognizer(input?.module);
  return {
    ...(speech === undefined ? {} : { speech }),
    speechConsent: createReactNativeSpeechConsent(input?.store),
  };
}

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
