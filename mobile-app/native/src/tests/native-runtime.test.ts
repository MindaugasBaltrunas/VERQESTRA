import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

/**
 * Node-only source checks on the native composition root.
 *
 * This suite never loads the module, for the same reason no other native suite
 * loads a shell file: `native/src/core.ts` resolves `@verqestra/mobile-app`,
 * which is a Metro/Expo seam and not a Node-resolvable package. What is checked
 * instead is everything that can drift silently — the transports the shell is
 * allowed to build, the one place the gateway URL comes from, and the two
 * cross-file agreements the shell would otherwise only break on a device.
 *
 * NUKRYPIMAS (kelias, ne taisyklės): `process.cwd()` → `__dirname` (žr. `core-seam.test.ts`).
 */

const nativeRoot = path.resolve(__dirname, "..", "..");
const shellRoot = path.join(nativeRoot, "src");
// The core package this one depends on. Read as a file, never imported: the
// dependency direction native -> core already exists, and these are drift
// guards over two literals, not a second import path into the core.
const coreSourceRoot = path.resolve(nativeRoot, "..", "src");

const runtimeFile = path.join(shellRoot, "composition", "native-runtime.ts");

async function readRuntime(): Promise<string> {
  return readFile(runtimeFile, "utf8");
}

/** Every module specifier form the composition root could use. */
const moduleSpecifierPattern = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*["']([^"']+)["']/g;

test("the composition root adds no dependency and reaches the core through the seam", async () => {
  const text = await readRuntime();
  const specifiers = [...text.matchAll(moduleSpecifierPattern)].flatMap((match) => match[1] ?? []);

  assert.ok(specifiers.length > 0, "no module specifiers extracted from the composition root");
  for (const specifier of specifiers) {
    // A bare specifier here would be a new runtime dependency of the native
    // package, which this composition is explicitly not allowed to take: the
    // transports are adapters over React Native globals, not over a package.
    assert.ok(specifier.startsWith("."), `composition root imports a package: ${specifier}`);
  }
  assert.ok(specifiers.includes("../core"), "the composition root does not use the core seam");
});

test("the transports are built from the runtime globals the shell names", async () => {
  const text = await readRuntime();

  // Each global is what one port is adapted from; losing one silently would turn
  // that port into a stub rather than a failure.
  for (const global of ["fetch", "WebSocket", "setTimeout", "clearTimeout", "randomUUID"]) {
    assert.ok(text.includes(global), `the composition root no longer adapts ${global}`);
  }
});

test("the gateway URL is read as a literal EXPO_PUBLIC member expression", async () => {
  const text = await readRuntime();

  // Expo inlines `process.env.EXPO_PUBLIC_*` at bundle time and only for a
  // static property access. A lookup by variable key typechecks, passes every
  // Node-side check and then reads `undefined` on device — so the literal form
  // is the contract, not a style choice.
  assert.match(text, /process\?\.env\?\.EXPO_PUBLIC_VERQESTRA_GATEWAY_URL/);
  assert.match(text, /gatewayBaseUrlVariable\s*=\s*"EXPO_PUBLIC_VERQESTRA_GATEWAY_URL"/);
  assert.ok(
    !/env\s*\[/.test(text),
    "the gateway URL is looked up by key, which Expo does not inline",
  );
});

/** Body of a regex literal assigned to `name`, without the delimiters. */
function assignedRegexSource(text: string, name: string): string {
  const source = new RegExp(`${name}\\s*=\\s*(/.*/)\\s*;`).exec(text)?.[1];
  assert.ok(source, `no regex literal assigned to ${name}`);
  return source.slice(1, -1);
}

test("the shell validates the gateway URL with the pattern the core enforces", async () => {
  const runtime = await readRuntime();
  const gatewayFormat = await readFile(
    path.join(coreSourceRoot, "adapters", "shared", "gateway-format.ts"),
    "utf8",
  );

  // The shell restates the pattern because the core does not export it. Restated
  // is fine; drifted is not — a shell that accepted a looser URL would only move
  // the rejection into the first request, where it reads as a dead gateway.
  assert.equal(
    assignedRegexSource(runtime, "gatewayBaseUrlPattern"),
    assignedRegexSource(gatewayFormat, "GATEWAY_BASE_URL_PATTERN"),
  );
});

test("the derived stream URL is one the core stream client accepts", async () => {
  const runtime = await readRuntime();
  const streamClient = await readFile(
    path.join(coreSourceRoot, "adapters", "network", "terminal-stream-client.ts"),
    "utf8",
  );

  const accepted = /(\/\^wss:[^\n]*?\/)\.test\(input\.url\)/.exec(streamClient)?.[1];
  assert.ok(accepted, "no stream URL pattern found in the core stream client");
  const streamUrlPattern = new RegExp(accepted.slice(1, -1));

  // The derivation the composition root performs, restated as the contract this
  // test holds it to. Both halves are asserted: that the source still performs
  // it, and that what it produces is what the core will accept.
  assert.match(runtime, /`wss:\/\/\$\{baseUrl\.slice\(httpsPrefix\.length\)\}\/terminal-stream`/);

  const httpsPrefix = "https://";
  for (const baseUrl of ["https://gateway.example/v1", "https://gateway.example:8443/v1"]) {
    assert.match(`wss://${baseUrl.slice(httpsPrefix.length)}/terminal-stream`, streamUrlPattern);
  }
});

/** Optional field names of a `Readonly<{ ... }>` type block. */
function optionalFieldNames(text: string, typeName: string): string[] {
  const start = text.indexOf(`export type ${typeName} = Readonly<{`);
  assert.notEqual(start, -1, `no ${typeName} declaration found`);
  const end = text.indexOf("}>;", start);
  assert.notEqual(end, -1, `unterminated ${typeName} declaration`);
  return [...text.slice(start, end).matchAll(/^\s*(\w+)\?:/gm)].flatMap((match) => match[1] ?? []);
}

test("the field extractor reads a real declaration and not an empty one", async () => {
  const app = await readFile(path.join(shellRoot, "App.tsx"), "utf8");
  const fields = optionalFieldNames(app, "AppProps");

  // Guards against a vacuous pass in the test below if the declaration form moves.
  assert.ok(fields.includes("agLoopReads"), `AppProps fields not extracted: ${fields.join(", ")}`);
  assert.ok(fields.length > 4, `only ${fields.length} AppProps fields extracted`);
});

test("the composition root offers and forwards every port App accepts but terminal", async () => {
  const runtime = await readRuntime();
  const app = await readFile(path.join(shellRoot, "App.tsx"), "utf8");

  const offered = optionalFieldNames(runtime, "NativePlatformPorts");
  for (const field of optionalFieldNames(app, "AppProps")) {
    // `terminal` is the one deliberate omission: `MobileTerminalPorts.stream`
    // reports to the UI through an observer bound to the reducer's `dispatch`,
    // and `dispatch` is created inside `App`. Nothing running before `App`
    // mounts can build it, so it is not a port the entry point can compose.
    if (field === "terminal") {
      assert.ok(!offered.includes(field), "terminal is offered but cannot be composed at entry");
      continue;
    }
    assert.ok(offered.includes(field), `the composition root drops the ${field} port`);
    // Offered but never forwarded is the same silent hole as not offered at all.
    assert.match(
      runtime,
      new RegExp(`\\{\\s*${field}:\\s*ports\\.${field}\\s*\\}`),
      `the composition root never forwards ${field} into AppProps`,
    );
  }
});
