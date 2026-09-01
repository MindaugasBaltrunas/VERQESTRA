import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

/**
 * Node-only checks on the platform composition root.
 *
 * The module is read as text, exactly like the screen and seam suites: it
 * imports `AppProps` from `App.tsx` and the port types from the core barrel,
 * neither of which resolves in the Node test build (`tsconfig.node.json` has no
 * JSX and the core package declares no `main`/`types`). Loading it here would
 * therefore tie this suite to a device toolchain the CI machine does not have.
 *
 * NUKRYPIMAS (kelias, ne taisyklės): `process.cwd()` → `__dirname` (žr. `core-seam.test.ts`).
 */

const nativeRoot = path.resolve(__dirname, "..", "..");
const shellRoot = path.join(nativeRoot, "src");

async function readShellFile(relative: string): Promise<string> {
  return readFile(path.join(shellRoot, relative), "utf8");
}

async function readRuntime(): Promise<string> {
  return readShellFile("composition/native-runtime.ts");
}

test("the Expo entry registers a composed App, never a bare one", async () => {
  const entry = await readFile(path.join(nativeRoot, "index.js"), "utf8");

  assert.match(entry, /require\("\.\/src\/composition\/native-runtime"\)/);
  assert.match(entry, /createNativeAppProps\(\)/);
  // The defect this suite exists for: `registerRootComponent(App)` hands the
  // shell no props at all, so no adapter can ever reach a screen.
  assert.doesNotMatch(entry, /registerRootComponent\(\s*App\s*\)/);
  assert.match(entry, /registerRootComponent\(\s*Root\s*\)/);
  // Composed once at entry, not per render: the ports an installation has do
  // not change between frames, and rebuilding them would give every controller
  // a new identity on every render.
  assert.match(entry, /const props = createNativeAppProps\(\);/);
  assert.match(entry, /createElement\(App, props\)/);
});

test("the composition root passes on every read port App declares", async () => {
  const runtime = await readRuntime();

  for (const port of [
    "agLoopReads",
    "sessionReviewReads",
    "connectionsReads",
    "projectsReads",
  ]) {
    assert.match(
      runtime,
      new RegExp(`${port}: ports\\.${port}`),
      `the composition root drops ${port}`,
    );
  }
});

test("the composition root fabricates no data behind a missing port", async () => {
  const runtime = await readRuntime();

  // A stub would make a space look wired while showing invented rows, which is
  // strictly worse than the honest placeholder the presenters already render.
  for (const forbidden of [
    "readDashboard",
    "readTaskBucket",
    "readProjects",
    "readRepositoryStatus",
    "Promise.resolve",
  ]) {
    assert.ok(!runtime.includes(forbidden), `the composition root fakes a port: ${forbidden}`);
  }
});

test("the host endpoint comes from configuration, never from a literal", async () => {
  const runtime = await readRuntime();

  assert.match(runtime, /process\.env\.EXPO_PUBLIC_VERQESTRA_GATEWAY_URL/);
  assert.match(runtime, /process\.env\.EXPO_PUBLIC_VERQESTRA_TERMINAL_STREAM_URL/);
  // Expo inlines `process.env.EXPO_PUBLIC_X` only as a literal member access; a
  // computed lookup compiles and then reads `undefined` on a device.
  assert.doesNotMatch(runtime, /process\.env\[/);
  for (const scheme of ["https://", "wss://", "http://", "ws://"]) {
    assert.ok(!runtime.includes(scheme), `the composition root hardcodes a host: ${scheme}`);
  }
});

test("the composition root duplicates no gateway URL validation", async () => {
  const runtime = await readRuntime();

  // `GatewayHttpClient` and `TerminalStreamClient` already refuse a malformed
  // URL. A second copy of those rules here could only drift from the ones that
  // actually guard the wire.
  assert.doesNotMatch(runtime, /\/\^\S*(?:https?|wss?)/i);
  assert.doesNotMatch(runtime, /startsWith\(/);
});

test("an unconfigured stream endpoint composes no Terminal space", async () => {
  const runtime = await readRuntime();

  // A Terminal space whose first action cannot reach a host is a dead control,
  // exactly like one composed without a write gate.
  assert.match(runtime, /if\s*\(!ports\s*\|\|\s*streamUrl === null\)\s*return undefined;/);
});

test("the shell endpoint is the composition root's field, not an adapter's", async () => {
  const runtime = await readRuntime();

  // `NativeTerminalPorts` is `MobileTerminalPorts` minus `streamUrl`: derived,
  // so a port added to the runtime contract cannot go missing here unnoticed.
  assert.match(runtime, /Omit<MobileTerminalPorts,\s*"streamUrl">/);
  assert.match(runtime, /\{\s*\.\.\.ports,\s*streamUrl\s*\}/);
});

test("the composition root reaches the core only for types", async () => {
  const runtime = await readRuntime();

  // Every port it names is injected. A value import from the seam would mean it
  // had started constructing adapters — the responsibility this module states
  // it does not take, and the one the write gate depends on it not taking.
  for (const match of runtime.matchAll(/import\s+(type\s+)?\{[^}]*\}\s*from\s*"\.\.\/core"/g)) {
    assert.ok(match[1], "the composition root imports a value from the core seam");
  }
});
