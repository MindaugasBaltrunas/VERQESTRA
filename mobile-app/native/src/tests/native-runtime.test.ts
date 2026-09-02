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

test("native-runtime imports transports only through the core seam", async () => {
  const source = await runtimeSource();
  const specifiers = importSpecifiers(source);
  assert.ok(specifiers.length > 0, "no import statements found in native-runtime.ts");
  for (const specifier of specifiers) {
    assert.equal(specifier, "../core", `unexpected import source: ${specifier}`);
  }
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

test("wiring the transports adds no runtime dependency to the native package", async () => {
  const manifest = JSON.parse(await readFile(path.join(nativeRoot, "package.json"), "utf8")) as Readonly<{
    dependencies?: Readonly<Record<string, string>>;
  }>;
  const dependencyNames = Object.keys(manifest.dependencies ?? {}).sort();
  assert.deepEqual(dependencyNames, ["@verqestra/mobile-app", "expo", "react", "react-native"]);
});
