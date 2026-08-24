import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyBindAddress,
  evaluateBindTarget,
  isAdvertisableHostName,
  MAX_BIND_PORT,
  MIN_BIND_PORT,
  PRIVATE_BIND_ADDRESS_CLASSES,
  type BindDecision,
  type BindDenialReason,
} from "../application/bind-address-policy.js";

/**
 * Private-network bind policy.
 *
 * The policy decides what a phone-facing socket is allowed to listen on, so the
 * tests are written against the rule rather than the implementation: every
 * denial is asserted by its reason code, and the boundaries of each address
 * range are probed from both sides.
 */

/** A port that is never the reason a decision fails, so the address is. */
const NEUTRAL_PORT = 8443;

/** An address that is never the reason a decision fails, so the port is. */
const NEUTRAL_ADDRESS = "10.0.0.5";

function decide(address: string, allowLoopback?: boolean): BindDecision {
  return allowLoopback === undefined
    ? evaluateBindTarget({ address, port: NEUTRAL_PORT })
    : evaluateBindTarget({ address, port: NEUTRAL_PORT, allowLoopback });
}

function reasonFor(decision: BindDecision): BindDenialReason | "allowed" {
  return decision.allowed ? "allowed" : decision.reason;
}

function assertDenied(address: string, reason: BindDenialReason, allowLoopback?: boolean): void {
  assert.equal(reasonFor(decide(address, allowLoopback)), reason, address);
}

/**
 * Every address any test in this file feeds to the policy. The closing
 * invariant replays the whole set, so an address added to a case above cannot
 * quietly escape the "allowed implies private" rule.
 */
const WILDCARD_ADDRESSES = ["0.0.0.0", "::", "0:0:0:0:0:0:0:0", ""] as const;
const LOOPBACK_ADDRESSES = ["127.0.0.1", "127.5.5.5", "::1"] as const;
const LINK_LOCAL_ADDRESSES = ["169.254.10.5", "fe80::1"] as const;
const PRIVATE_ADDRESSES = [
  { address: "10.0.0.5", addressClass: "rfc1918", family: "ipv4" },
  { address: "172.16.0.1", addressClass: "rfc1918", family: "ipv4" },
  { address: "172.31.255.254", addressClass: "rfc1918", family: "ipv4" },
  { address: "192.168.1.10", addressClass: "rfc1918", family: "ipv4" },
  { address: "100.64.0.1", addressClass: "carrier-grade-nat", family: "ipv4" },
  { address: "100.127.255.254", addressClass: "carrier-grade-nat", family: "ipv4" },
  { address: "fd12::1", addressClass: "unique-local", family: "ipv6" },
  { address: "fc00::1", addressClass: "unique-local", family: "ipv6" },
] as const;
const OFF_BY_ONE_PUBLIC_ADDRESSES = [
  "172.15.255.255",
  "172.32.0.1",
  "192.169.1.1",
  "100.63.255.255",
  "100.128.0.1",
  "9.255.255.255",
  "11.0.0.1",
] as const;
const PUBLIC_ADDRESSES = ["8.8.8.8", "2001:db8::1"] as const;
const SPECIAL_PURPOSE_ADDRESSES = [
  "224.0.0.1",
  "255.255.255.255",
  "240.0.0.1",
  "0.1.2.3",
  "ff02::1",
] as const;
const MALFORMED_ADDRESSES = [
  "010.0.0.1",
  "10.0.0.256",
  "10.0.0",
  "1.2.3.4.5",
  "gateway.local",
  "10.0.0.1 ",
] as const;
const AMBIGUOUS_ADDRESSES = ["fe80::1%eth0", "::ffff:192.168.1.5"] as const;

const EVERY_TESTED_ADDRESS: readonly string[] = [
  ...WILDCARD_ADDRESSES,
  ...LOOPBACK_ADDRESSES,
  ...LINK_LOCAL_ADDRESSES,
  ...PRIVATE_ADDRESSES.map((entry) => entry.address),
  ...OFF_BY_ONE_PUBLIC_ADDRESSES,
  ...PUBLIC_ADDRESSES,
  ...SPECIAL_PURPOSE_ADDRESSES,
  ...MALFORMED_ADDRESSES,
  ...AMBIGUOUS_ADDRESSES,
  NEUTRAL_ADDRESS,
];

test("a wildcard bind is refused in every spelling", () => {
  for (const address of ["0.0.0.0", "::", "0:0:0:0:0:0:0:0"]) {
    assert.equal(classifyBindAddress(address), "wildcard", address);
    assertDenied(address, "wildcard_forbidden");
  }
  // The empty string never reaches the wildcard rule: it is not an address at
  // all, and the policy says so before it can be mistaken for "any interface".
  assert.equal(classifyBindAddress(""), "malformed");
  assertDenied("", "malformed_address");
});

test("loopback binds only when the caller asks for the diagnostic by name", () => {
  for (const address of LOOPBACK_ADDRESSES) {
    assert.equal(classifyBindAddress(address), "loopback", address);
    assertDenied(address, "loopback_requires_explicit_opt_in");
    assertDenied(address, "loopback_requires_explicit_opt_in", false);

    const decision = decide(address, true);
    assert.equal(decision.allowed, true, address);
    if (!decision.allowed) return;
    assert.equal(decision.addressClass, "loopback", address);
    assert.equal(decision.loopbackDiagnostic, true, address);
    assert.equal(decision.address, address);
    assert.equal(decision.port, NEUTRAL_PORT);
  }
});

test("link-local addresses are refused, and a zone identifier is refused earlier", () => {
  for (const address of LINK_LOCAL_ADDRESSES) {
    assert.equal(classifyBindAddress(address), "link-local", address);
    assertDenied(address, "link_local_forbidden");
    // The opt-in covers loopback only; it must not launder any other class.
    assertDenied(address, "link_local_forbidden", true);
  }
  assert.equal(classifyBindAddress("fe80::1%eth0"), "ambiguous");
  assertDenied("fe80::1%eth0", "ambiguous_address_form");
});

test("private-network addresses bind with the class that justified them", () => {
  for (const entry of PRIVATE_ADDRESSES) {
    const decision = decide(entry.address);
    assert.equal(decision.allowed, true, entry.address);
    if (!decision.allowed) return;
    assert.equal(decision.addressClass, entry.addressClass, entry.address);
    assert.equal(decision.family, entry.family, entry.address);
    assert.equal(decision.loopbackDiagnostic, false, entry.address);
    assert.equal(decision.address, entry.address);
    // A private address needs no opt-in, and asking for one changes nothing.
    assert.deepEqual(decide(entry.address, true), decision);
  }
});

test("addresses one step outside a private range are public", () => {
  for (const address of OFF_BY_ONE_PUBLIC_ADDRESSES) {
    assert.equal(classifyBindAddress(address), "public", address);
    assertDenied(address, "public_address_forbidden");
  }
});

test("public and special-purpose addresses are refused with distinct reasons", () => {
  for (const address of PUBLIC_ADDRESSES) {
    assertDenied(address, "public_address_forbidden");
  }
  for (const address of SPECIAL_PURPOSE_ADDRESSES) {
    assert.equal(classifyBindAddress(address), "special-purpose", address);
    assertDenied(address, "special_purpose_address_forbidden");
  }
});

test("addresses the host and the policy could read differently are refused", () => {
  for (const address of MALFORMED_ADDRESSES) {
    assert.equal(classifyBindAddress(address), "malformed", address);
    assertDenied(address, "malformed_address");
  }
  // An IPv4-mapped literal names one host through two syntaxes, so the string
  // the policy classified is not provably the string the socket resolves.
  assert.equal(classifyBindAddress("::ffff:192.168.1.5"), "ambiguous");
  assertDenied("::ffff:192.168.1.5", "ambiguous_address_form");
});

test("privileged and out-of-range ports are refused on an otherwise allowed address", () => {
  for (const port of [0, 80, 443, MIN_BIND_PORT - 1]) {
    const decision = evaluateBindTarget({ address: NEUTRAL_ADDRESS, port });
    assert.equal(reasonFor(decision), "privileged_port_forbidden", String(port));
    assert.equal(decision.allowed === false && decision.addressClass, "rfc1918");
  }
  for (const port of [-1, MAX_BIND_PORT + 1, 1.5, Number.NaN]) {
    assert.equal(
      reasonFor(evaluateBindTarget({ address: NEUTRAL_ADDRESS, port })),
      "invalid_port",
      String(port),
    );
  }
  for (const port of [MIN_BIND_PORT, 8443, MAX_BIND_PORT]) {
    const decision = evaluateBindTarget({ address: NEUTRAL_ADDRESS, port });
    assert.equal(decision.allowed, true, String(port));
    assert.equal(decision.allowed === true && decision.port, port);
  }
});

test("an address is reported before the port it would have been reached on", () => {
  // Exposure is the address; the port is only the door. A caller that got both
  // wrong must hear about the one that matters.
  assert.equal(
    reasonFor(evaluateBindTarget({ address: "8.8.8.8", port: 80 })),
    "public_address_forbidden",
  );
});

test("an allowed bind is always private, or loopback the caller opted into", () => {
  for (const address of EVERY_TESTED_ADDRESS) {
    for (const allowLoopback of [undefined, false, true]) {
      const decision = decide(address, allowLoopback);
      if (!decision.allowed) continue;
      const isPrivate = PRIVATE_BIND_ADDRESS_CLASSES.includes(decision.addressClass);
      const isOptedInLoopback = decision.addressClass === "loopback" && allowLoopback === true;
      assert.equal(
        isPrivate || isOptedInLoopback,
        true,
        `${address} allowed as ${decision.addressClass} (allowLoopback=${String(allowLoopback)})`,
      );
      assert.equal(decision.loopbackDiagnostic, isOptedInLoopback, address);
    }
  }
});

test("only a lowercase DNS name may be advertised as the pairing host", () => {
  for (const value of ["host.tailnet.ts.net", "ag-host"]) {
    assert.equal(isAdvertisableHostName(value), true, value);
  }
  for (const value of [
    // An address is not a name: whether the host may be reachable there is
    // `evaluateBindTarget`'s decision, not a certificate SAN's.
    "10.0.0.5",
    "::1",
    // Advertised names are compared byte-wise against a SAN.
    "Host.Local",
    "-bad.example",
    `${"a".repeat(64)}.com`,
    "",
  ]) {
    assert.equal(isAdvertisableHostName(value), false, value);
  }
});
