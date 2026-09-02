import assert from "node:assert/strict";
import { createServer, type AddressInfo } from "node:net";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  GATEWAY_CONFIGURATION_FILE_NAME,
  GatewayNotConfiguredError,
} from "../composition/gateway-configuration.js";
import { startGateway, type GatewayRuntime } from "../composition/gateway-main.js";
import type { HostDataEnvironment } from "../infrastructure/gateway-data-directory.js";
import { createTestCertificate } from "./x509-test-certificate.js";

/**
 * The composition root, driven end to end.
 *
 * Every part of this gateway had a suite before this one and the package was
 * still not runnable: nothing composed the parts, so `pnpm start` had nothing to
 * point at. Doubles would reproduce that gap exactly — a composition test that
 * stubs the composition proves only that the stub agrees with itself. So this
 * suite runs the real wiring against real adapters, on a loopback diagnostic
 * bind the policy admits by name, with a certificate generated for this run.
 *
 * Paths are resolved from this module rather than from `process.cwd()`, the same
 * rule the other conformance suites follow.
 */

const packageRoot = resolve(fileURLToPath(import.meta.url), "../../../");

const NOT_BEFORE = new Date(Date.now() - 24 * 60 * 60 * 1000);
const NOT_AFTER = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
const LOOPBACK = "127.0.0.1";

/** A port the host is not using right now, taken and released by the kernel. */
async function freePort(): Promise<number> {
  const probe = createServer();
  const port = await new Promise<number>((settle, fail) => {
    probe.once("error", fail);
    probe.listen({ host: LOOPBACK, port: 0, exclusive: true }, () => {
      settle((probe.address() as AddressInfo).port);
    });
  });
  await new Promise<void>((settle) => probe.close(() => settle()));
  return port;
}

/** True while nothing is listening on the port — the fail-closed assertion. */
async function isFree(port: number): Promise<boolean> {
  const probe = createServer();
  const bound = await new Promise<boolean>((settle) => {
    probe.once("error", () => settle(false));
    probe.listen({ host: LOOPBACK, port, exclusive: true }, () => settle(true));
  });
  await new Promise<void>((settle) => probe.close(() => settle()));
  return bound;
}

function environmentFor(dataDirectory: string): HostDataEnvironment {
  return {
    platform: process.platform,
    env: { ...process.env, AG_MOBILE_GATEWAY_DATA_DIR: dataDirectory },
    homeDirectory: homedir(),
  };
}

/** The five gates the policy requires, each an absolute executable that exits 0. */
function gateCatalogue(): ReadonlyArray<Record<string, unknown>> {
  return ["readme", "architecture", "secret", "typecheck", "test"].map((name) => ({
    name,
    executable: process.execPath,
    args: ["--version"],
    timeoutMs: 60_000,
  }));
}

type Scratch = Readonly<{
  dataDirectory: string;
  bindPort: number;
  localControlPort: number;
  cleanup: () => Promise<void>;
}>;

async function scratch(options: { withCertificate: boolean }): Promise<Scratch> {
  const dataDirectory = await mkdtemp(join(tmpdir(), "vq-gateway-main-"));
  const bindPort = await freePort();
  const localControlPort = await freePort();
  const configuration = {
    bind: { address: LOOPBACK, port: bindPort, allowLoopback: true },
    workspaceRoots: { primary: dataDirectory },
    sessionRoot: join(dataDirectory, "sessions"),
    localControl: { loopbackPort: localControlPort },
    gates: gateCatalogue(),
  };
  await writeFile(
    join(dataDirectory, GATEWAY_CONFIGURATION_FILE_NAME),
    JSON.stringify(configuration),
    "utf8",
  );
  if (options.withCertificate) {
    const certificate = createTestCertificate({
      commonName: "vq-mobile-host",
      ipSans: [LOOPBACK],
      notBefore: NOT_BEFORE,
      notAfter: NOT_AFTER,
    });
    await writeFile(
      join(dataDirectory, "host-certificate.pem"),
      certificate.certificatePem,
      { encoding: "utf8", mode: 0o600 },
    );
    await writeFile(
      join(dataDirectory, "host-private-key.pem"),
      certificate.privateKeyPem,
      { encoding: "utf8", mode: 0o600 },
    );
  }
  return {
    dataDirectory,
    bindPort,
    localControlPort,
    cleanup: () => rm(dataDirectory, { recursive: true, force: true }),
  };
}

test("a complete configuration raises the TLS listener and the local control channel", async () => {
  const active = await scratch({ withCertificate: true });
  let runtime: GatewayRuntime | undefined;
  try {
    runtime = await startGateway({ environment: environmentFor(active.dataDirectory) });
    // The bind target the policy approved, and the pairing origin an operator
    // would show a phone — https, never http.
    assert.equal(runtime.binding.address, LOOPBACK);
    assert.equal(runtime.binding.port, active.bindPort);
    assert.equal(runtime.binding.addressClass, "loopback");
    assert.equal(runtime.binding.loopbackDiagnostic, true);
    assert.equal(runtime.binding.pairingOrigin, `https://${LOOPBACK}:${active.bindPort}`);
    // Both sockets are real: the remote listener and the SEPARATE local control
    // endpoint the contract keeps off the phone-facing server.
    assert.equal(await isFree(active.bindPort), false, "the gateway listener must hold its port");
    assert.equal(runtime.localControl.kind, "loopback-http");
    assert.equal(await isFree(active.localControlPort), false, "local control must hold its port");
  } finally {
    await runtime?.stop();
    await active.cleanup();
  }
  // Stopping releases both, so a restart is not blocked by its own predecessor.
  assert.equal(await isFree(active.bindPort), true);
  assert.equal(await isFree(active.localControlPort), true);
});

test("a missing host certificate is not_configured, and opens no socket at all", async () => {
  const active = await scratch({ withCertificate: false });
  try {
    await assert.rejects(
      startGateway({ environment: environmentFor(active.dataDirectory) }),
      (error: unknown) =>
        error instanceof GatewayNotConfiguredError && error.reason === "certificate_missing",
      "an unconfigured certificate must surface as not_configured, not as a stack trace",
    );
    // The point of the refusal: no degraded listener took the certificate's
    // place. Both ports are still exactly as free as before the attempt.
    assert.equal(await isFree(active.bindPort), true, "no listener may survive the refusal");
    assert.equal(await isFree(active.localControlPort), true);
  } finally {
    await active.cleanup();
  }
});

test("a missing configuration file names itself rather than failing obscurely", async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "vq-gateway-main-"));
  try {
    await assert.rejects(
      startGateway({ environment: environmentFor(dataDirectory) }),
      (error: unknown) =>
        error instanceof GatewayNotConfiguredError &&
        error.reason === "configuration_missing" &&
        error.message.includes(GATEWAY_CONFIGURATION_FILE_NAME),
    );
  } finally {
    await rm(dataDirectory, { recursive: true, force: true });
  }
});

test("the composition root can serve no plain HTTP", async () => {
  const files = ["gateway-main.ts", "gateway-configuration.ts"];
  for (const name of files) {
    const source = await readFile(join(packageRoot, "src", "composition", name), "utf8");
    // A fallback would have to enter through one of these; the phone-facing
    // socket is built by `createGatewayTlsServer` and by nothing else.
    // `node:http` is reachable only through the local control transport, which
    // is a different listener on a different endpoint.
    for (const module of [/["'](?:node:)?http["']/, /["'](?:node:)?net["']/, /["']node:tls["']/]) {
      assert.doesNotMatch(source, module, `${name} must open no cleartext listener`);
    }
  }
  const root = await readFile(join(packageRoot, "src", "composition", "gateway-main.ts"), "utf8");
  assert.match(root, /createGatewayTlsServer/);
});

test("the start script points at the composition root this package actually builds", async () => {
  const manifest = JSON.parse(
    await readFile(join(packageRoot, "package.json"), "utf8"),
  ) as { scripts?: Record<string, string> };
  const start = manifest.scripts?.["start"];
  assert.ok(start !== undefined, "the package must declare a start script");

  const compiled = /node\s+(dist\/\S+\.js)/.exec(start)?.[1];
  assert.ok(compiled !== undefined, `start must run a compiled entry point, got: ${start}`);
  // Both ends of the claim: the entry exists as source, and the build really
  // emitted it. This suite runs from `dist`, so a stale or misspelled path here
  // is caught by the same run that produced it.
  const sourceEntry = join(packageRoot, compiled.replace(/^dist\//, "src/").replace(/\.js$/, ".ts"));
  await assert.doesNotReject(readFile(sourceEntry, "utf8"), `${sourceEntry} must exist`);
  await assert.doesNotReject(
    readFile(join(packageRoot, compiled), "utf8"),
    `${compiled} must be emitted by the build`,
  );
});
