import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

/**
 * `native-runtime.ts` wires the two transports the MVC core cannot build for
 * itself (an HTTP transport and a WebSocket factory) out of React Native
 * globals. It cannot be imported here the way `gateway-http-client.test.ts`
 * imports its subject: importing it pulls in `../core`, which re-exports
 * `@verqestra/mobile-app` — a package Metro resolves through
 * `metro.config.js`'s `extraNodeModules` mapping, not through a `main` or
 * `exports` field a plain `node --test` run can follow (see the "cannot
 * prove" note in `core-seam.test.ts`). Every existing native-shell suite
 * works around the same gap by reading source as text instead of importing
 * it; this suite does the same, and checks the transport adapters against
 * the port contracts they claim to satisfy (`MobileHttpTransportPort`,
 * `MobileWebSocketPort`, `MobileWebSocketFactory` in
 * `mobile-app/src/adapters/network/*.ts`) by inspecting what they do with
 * the request/response shape and the WebSocket event callbacks, the same
 * facts `gateway-http-client.test.ts` and `terminal-stream-client.test.ts`
 * pin down by construction.
 */

const nativeRoot = path.resolve(__dirname, "..", "..");
const runtimeFile = path.join(nativeRoot, "src", "composition", "native-runtime.ts");

async function runtimeSource(): Promise<string> {
  return readFile(runtimeFile, "utf8");
}

function importSpecifiers(source: string): string[] {
  const pattern = /import\s+(?:type\s+)?(?:\{[^}]*\}|[\w*\s,]+)\s*from\s*["']([^"']+)["']/g;
  return [...source.matchAll(pattern)].map((match) => match[1] ?? "");
}

/**
 * Every module `native-runtime.ts` may name. The list stays exact and therefore
 * fail-closed: `../core` is the single seam to the MVC core, the adapter path is
 * native-shell-internal, and `expo-secure-store` is the one platform package the
 * composition root binds to a port (task 119). A new bare specifier here has to
 * be argued for by editing this line.
 */
const allowedRuntimeImports: ReadonlySet<string> = new Set([
  "../core",
  "../adapters/expo-secure-store-adapter",
  "expo-secure-store",
]);

test("native-runtime reaches the core only through the seam and names only audited modules", async () => {
  const source = await runtimeSource();
  const specifiers = importSpecifiers(source);
  assert.ok(specifiers.length > 0, "no import statements found in native-runtime.ts");
  for (const specifier of specifiers) {
    assert.ok(allowedRuntimeImports.has(specifier), `unexpected import source: ${specifier}`);
  }
  // The core is still reached one way only; widening the list above must not
  // quietly introduce a second route to `@verqestra/mobile-app`.
  assert.doesNotMatch(source, /from\s+["']@verqestra\/mobile-app["']/);
});

test("the HTTP transport is built from the global fetch, not a new dependency", async () => {
  const source = await runtimeSource();
  assert.match(source, /createReactNativeHttpTransport[\s\S]*?await fetch\(/);
  assert.doesNotMatch(source, /node-fetch|axios|cross-fetch/);
});

test("the HTTP transport maps a fetch Response onto the MobileHttpTransportPort shape", async () => {
  const source = await runtimeSource();
  const body = source.slice(source.indexOf("createReactNativeHttpTransport"));
  assert.match(body, /status:\s*response\.status/);
  assert.match(body, /body:\s*await response\.text\(\)/);
});

test("the HTTP transport forwards an absent body as no body at all, not an empty string", async () => {
  const source = await runtimeSource();
  const body = source.slice(source.indexOf("createReactNativeHttpTransport"));
  assert.match(body, /input\.body === undefined \? \{\} : \{ body: input\.body \}/);
});

test("the WebSocket factory is built from the global WebSocket, not a new dependency", async () => {
  const source = await runtimeSource();
  assert.match(source, /createReactNativeWebSocketFactory[\s\S]*?WebSocket as unknown as ReactNativeWebSocketConstructor/);
  assert.doesNotMatch(source, /["']ws["']|["']isomorphic-ws["']/);
});

test("the WebSocket factory carries the Authorization header into the native handshake", async () => {
  const source = await runtimeSource();
  const body = source.slice(source.indexOf("createReactNativeWebSocketFactory"));
  assert.match(body, /new NativeWebSocket\(input\.url, undefined, \{ headers: input\.headers \}\)/);
});

test("the WebSocket wrapper implements every MobileWebSocketPort method", async () => {
  const source = await runtimeSource();
  const body = source.slice(source.indexOf("function toMobileSocket"), source.indexOf("createReactNativeWebSocketFactory"));
  for (const member of ["send", "close", "onOpen", "onMessage", "onClose", "onError"]) {
    assert.match(body, new RegExp(`\\b${member}\\s*:`), `toMobileSocket does not implement ${member}`);
  }
});

test("createGatewayHttpClient forwards credentials, proofs and ids untouched, without fabricating them", async () => {
  const source = await runtimeSource();
  const body = source.slice(source.indexOf("export function createGatewayHttpClient"));
  assert.match(body, /new GatewayHttpClient\(\s*input\.baseUrl,\s*input\.transport \?\? createReactNativeHttpTransport\(\),\s*input\.credentials,\s*input\.proofs,\s*input\.ids,?\s*\)/);
});

test("createTerminalStreamClient forwards the scheduler and observer untouched, without fabricating them", async () => {
  const source = await runtimeSource();
  const body = source.slice(source.indexOf("export function createTerminalStreamClient"));
  assert.match(body, /new TerminalStreamClient\(\s*input\.sockets \?\? createReactNativeWebSocketFactory\(\),\s*input\.scheduler,\s*input\.observer,?\s*\)/);
});

test("the gateway base URL has no default and comes from an Expo public env var", async () => {
  const source = await runtimeSource();
  const body = source.slice(source.indexOf("export function readGatewayBaseUrl"));
  assert.match(body, /process\.env\.EXPO_PUBLIC_GATEWAY_BASE_URL/);
  assert.match(body, /if \(!value\)\s*\{\s*throw new Error/);
});

/**
 * The native package's runtime dependencies, as an exact list rather than a
 * subset check: a dependency is a permanent security and bundle-size surface, so
 * an unaudited addition must fail here rather than arrive with a feature.
 *
 * The transports still contribute nothing — they wrap `fetch` and `WebSocket`.
 * `expo-secure-store` is the single deliberate addition (task 119, operator
 * approved 2026-09-02): the OS keystore has no global to wrap, so `SecureStorePort`
 * cannot be implemented without it.
 */
const auditedRuntimeDependencies = [
  "@verqestra/mobile-app",
  "expo",
  "expo-secure-store",
  "react",
  "react-native",
];

test("the native package's runtime dependencies stay an exact, audited list", async () => {
  const manifest = JSON.parse(await readFile(path.join(nativeRoot, "package.json"), "utf8")) as Readonly<{
    dependencies?: Readonly<Record<string, string>>;
  }>;
  const dependencyNames = Object.keys(manifest.dependencies ?? {}).sort();
  assert.deepEqual(dependencyNames, auditedRuntimeDependencies);
});
