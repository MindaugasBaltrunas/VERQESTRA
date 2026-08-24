import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DeviceAuthService } from "../application/device-auth-service.js";
import { HostBootstrapError } from "../application/host-bootstrap.js";
import { HOST_FINGERPRINT_PATTERN } from "../application/host-identity.js";
import { AtomicJsonDeviceAuthStateStore } from "../infrastructure/atomic-json-device-auth-state-store.js";
import {
  assertFailsClosed,
  assigned,
  BIND_ADDRESS,
  BIND_PORT,
  certificateSource,
  fixture,
  hostCertificate,
  interfaceSource,
  material,
  NOT_AFTER,
  NOT_BEFORE,
  NOW,
} from "./host-bootstrap-doubles.js";

/**
 * Host bootstrap: the BINDING half.
 *
 * SKAIDYMAS (VERQESTRA ≤500 eil. vartas): `host-bootstrap.test.ts` įrodo, kada tapatybė
 * neįrodoma; čia — kada tapatybė ĮRODYTA, bet lizdas vis tiek neatsidaro (bind politika,
 * hosto neturimas adresas), ir kaip atrodo pilnas ciklas `ready → listening → stopped`.
 */

test("a valid certificate does not buy an exemption from the bind policy", async () => {
  // The certificate genuinely covers `0.0.0.0`; identity is proven and the bind
  // is still refused, because coverage is not permission.
  const active = fixture({
    certificates: certificateSource(async () => material(hostCertificate({ ipSans: ["0.0.0.0"] }))),
    interfaces: interfaceSource([assigned("0.0.0.0", "ipv4")]),
  });
  await assertFailsClosed(
    active,
    active.bootstrap.configure({ address: "0.0.0.0", port: BIND_PORT, now: NOW }),
    "wildcard_forbidden",
  );
});

test("an allowed address this host does not hold is refused", async () => {
  const active = fixture({
    interfaces: interfaceSource([assigned("10.0.0.6", "ipv4"), assigned("127.0.0.1", "ipv4", true)]),
  });
  await assertFailsClosed(
    active,
    active.bootstrap.configure({ address: BIND_ADDRESS, port: BIND_PORT, now: NOW }),
    "bind_address_not_assigned",
  );
});

test("a real bind is not satisfied by a host-internal interface", async () => {
  const active = fixture({
    interfaces: interfaceSource([assigned(BIND_ADDRESS, "ipv4", true)]),
  });
  await assertFailsClosed(
    active,
    active.bootstrap.configure({ address: BIND_ADDRESS, port: BIND_PORT, now: NOW }),
    "bind_address_not_assigned",
  );
});

test("an unusable interface list is a failure, never an assumption", async () => {
  const active = fixture({
    interfaces: {
      addresses: async () => {
        throw new Error("netlink unavailable");
      },
    },
  });
  await assertFailsClosed(
    active,
    active.bootstrap.configure({ address: BIND_ADDRESS, port: BIND_PORT, now: NOW }),
    "interface_enumeration_failed",
  );
});

test("a proven host reaches ready, then listening, with a pinnable fingerprint", async () => {
  const certificate = hostCertificate();
  const active = fixture({ certificates: certificateSource(async () => material(certificate)) });

  const configured = await active.bootstrap.configure({
    address: BIND_ADDRESS,
    port: BIND_PORT,
    now: NOW,
  });
  assert.equal(active.bootstrap.status().state, "ready");
  assert.equal(configured.address, BIND_ADDRESS);
  assert.equal(configured.port, BIND_PORT);
  assert.equal(configured.family, "ipv4");
  assert.equal(configured.addressClass, "rfc1918");
  assert.equal(configured.loopbackDiagnostic, false);
  assert.equal(configured.pairingOrigin, `https://${BIND_ADDRESS}:${BIND_PORT}`);
  assert.equal(configured.identity.addressCoverage, "ip-san");
  assert.equal(configured.identity.selfSigned, true);
  assert.equal(configured.identity.keyType, "ed25519");
  assert.equal(configured.identity.validFrom, NOT_BEFORE.toISOString());
  assert.equal(configured.identity.validTo, NOT_AFTER.toISOString());

  const fingerprint = active.bootstrap.hostFingerprint();
  assert.equal(fingerprint, `sha256:${certificate.derSha256Hex}`);
  assert.match(fingerprint, HOST_FINGERPRINT_PATTERN);
  assert.equal(fingerprint.length, 71);

  const listening = await active.bootstrap.start();
  assert.deepEqual(listening, configured);
  assert.equal(active.listener.startCalls, 1);
  assert.deepEqual(active.listener.requests[0], {
    address: BIND_ADDRESS,
    port: BIND_PORT,
    family: "ipv4",
  });
  const status = active.bootstrap.status();
  assert.equal(status.state, "listening");
  assert.equal(status.state === "listening" && status.binding.pairingOrigin, configured.pairingOrigin);
  // The identity survives the transition: the phone pins one fingerprint.
  assert.equal(active.bootstrap.hostFingerprint(), fingerprint);
});

test("an advertised name is proven by a DNS SAN and becomes the pairing origin", async () => {
  const active = fixture({
    certificates: certificateSource(async () =>
      material(hostCertificate({ ipSans: [], dnsSans: ["host.tailnet.ts.net"] })),
    ),
  });
  const binding = await active.bootstrap.configure({
    address: BIND_ADDRESS,
    port: BIND_PORT,
    advertisedHost: "host.tailnet.ts.net",
    now: NOW,
  });
  assert.equal(active.bootstrap.status().state, "ready");
  assert.equal(binding.identity.addressCoverage, "dns-san");
  assert.equal(binding.pairingOrigin, "https://host.tailnet.ts.net:8443");
});

test("an IPv6 pairing origin brackets the address", async () => {
  const active = fixture({
    certificates: certificateSource(async () =>
      material(hostCertificate({ ipSans: ["fd12::1"] })),
    ),
    interfaces: interfaceSource([assigned("fd12::1", "ipv6")]),
  });
  const binding = await active.bootstrap.configure({
    address: "fd12::1",
    port: BIND_PORT,
    now: NOW,
  });
  assert.equal(binding.family, "ipv6");
  assert.equal(binding.addressClass, "unique-local");
  assert.equal(binding.pairingOrigin, "https://[fd12::1]:8443");
});

test("the bootstrap fingerprint is accepted verbatim by pairing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ag-host-bootstrap-"));
  try {
    const active = fixture();
    await active.bootstrap.configure({ address: BIND_ADDRESS, port: BIND_PORT, now: NOW });
    const hostFingerprint = active.bootstrap.hostFingerprint();

    const auth = new DeviceAuthService(
      new AtomicJsonDeviceAuthStateStore(join(directory, "device-auth.json")),
    );
    const challenge = await auth.createPairingChallenge({
      hostFingerprint,
      scopes: ["ag:read"],
      now: NOW,
    });
    // No truncation, no re-encoding: the value the phone pins is the value the
    // certificate produced.
    assert.equal(challenge.hostFingerprint, hostFingerprint);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("host identity is unavailable before a bootstrap and after a stop", async () => {
  const active = fixture();
  const notConfigured = (error: unknown): boolean =>
    error instanceof HostBootstrapError && error.code === "not_configured";

  assert.throws(() => active.bootstrap.hostFingerprint(), notConfigured);
  assert.throws(() => active.bootstrap.identity(), notConfigured);

  await active.bootstrap.configure({ address: BIND_ADDRESS, port: BIND_PORT, now: NOW });
  await active.bootstrap.start();
  await active.bootstrap.stop();

  assert.throws(() => active.bootstrap.hostFingerprint(), notConfigured);
  assert.throws(() => active.bootstrap.identity(), notConfigured);
});

test("a second start neither opens a second socket nor discards the first", async () => {
  const active = fixture();
  await active.bootstrap.configure({ address: BIND_ADDRESS, port: BIND_PORT, now: NOW });
  await active.bootstrap.start();

  await assert.rejects(
    active.bootstrap.start(),
    (error: unknown) => error instanceof HostBootstrapError && error.code === "already_listening",
  );
  assert.equal(active.listener.startCalls, 1);
  assert.equal(active.bootstrap.status().state, "listening");

  // The same rule protects the configuration under a live socket.
  await assert.rejects(
    active.bootstrap.configure({ address: BIND_ADDRESS, port: BIND_PORT, now: NOW }),
    (error: unknown) => error instanceof HostBootstrapError && error.code === "already_listening",
  );
  assert.equal(active.bootstrap.status().state, "listening");
});

test("a listener that refuses the approved binding leaves no half-configured host", async () => {
  const inUse = Object.assign(new Error("listen EADDRINUSE 10.0.0.5:8443"), {
    code: "EADDRINUSE",
  });
  const active = fixture({ listenerFailure: inUse });
  await active.bootstrap.configure({ address: BIND_ADDRESS, port: BIND_PORT, now: NOW });

  await assert.rejects(
    active.bootstrap.start(),
    (error: unknown) =>
      error instanceof HostBootstrapError && error.code === "listener_start_failed",
  );
  assert.equal(active.listener.startCalls, 1);
  const status = active.bootstrap.status();
  assert.equal(status.state, "not_configured");
  assert.equal(status.state === "not_configured" && status.lastFailure, "listener_start_failed");
  assert.throws(
    () => active.bootstrap.identity(),
    (error: unknown) => error instanceof HostBootstrapError && error.code === "not_configured",
  );
});

test("stop closes the socket exactly once and releases the identity with it", async () => {
  const active = fixture();
  await active.bootstrap.configure({ address: BIND_ADDRESS, port: BIND_PORT, now: NOW });
  await active.bootstrap.start();

  await active.bootstrap.stop();
  assert.equal(active.listener.closeCalls, 1);
  // `stopped` is declared in the transition graph but never observed: stopping
  // drops the identity too, so nothing distinguishes it from unconfigured.
  const status = active.bootstrap.status();
  assert.equal(status.state, "not_configured");
  assert.equal(status.state === "not_configured" && status.lastFailure, undefined);

  await active.bootstrap.stop();
  assert.equal(active.listener.closeCalls, 1);
});
