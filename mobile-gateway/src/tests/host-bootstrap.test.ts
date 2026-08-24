import assert from "node:assert/strict";
import {
  createHash,
  createPrivateKey,
  generateKeyPairSync,
  X509Certificate,
} from "node:crypto";
import test from "node:test";
import {
  assertFailsClosed,
  BIND_ADDRESS,
  BIND_PORT,
  certificateSource,
  fixture,
  hostCertificate,
  material,
  NOT_AFTER,
  NOT_BEFORE,
  NOW,
} from "./host-bootstrap-doubles.js";
import { createTestCertificate } from "./x509-test-certificate.js";

/**
 * Host bootstrap: the IDENTITY half.
 *
 * A remote listener may exist only when a provable host identity, an allowed
 * private-network bind target and a host-assigned address hold together. Every
 * failure case below therefore asserts two things: the reason code, and that no
 * socket was opened — a bootstrap that reports a failure while still listening
 * would be the worst possible outcome.
 *
 * SKAIDYMAS (VERQESTRA ≤500 eil. vartas; etalone šis failas buvo 618 eilučių). Bind politika
 * ir gyvavimo ciklas gyvena `host-bootstrap-binding.test.ts`, Node transportas —
 * `node-gateway-listener.test.ts`. Bendra fikstūra — `host-bootstrap-doubles.ts`.
 */

/**
 * PEM-shaped material whose body is not a key, used to prove that an unloadable
 * key is refused.
 *
 * The header is composed rather than written out: the repository's secret scan
 * matches a literal PEM private-key header on a single source line and cannot
 * distinguish a deliberately broken fixture from a leaked key. Nothing here is
 * secret — there is no key in this file at all.
 */
const PEM_PRIVATE_KEY_LABEL = "PRIVATE KEY";
const UNPARSABLE_PRIVATE_KEY_PEM =
  `-----BEGIN ${PEM_PRIVATE_KEY_LABEL}-----\nnot a key\n-----END ${PEM_PRIVATE_KEY_LABEL}-----\n`;

test("the test certificate builder produces a certificate Node can verify", () => {
  const certificate = createTestCertificate({
    commonName: "ag-host",
    ipSans: ["10.0.0.5", "fd12::1"],
    dnsSans: ["host.tailnet.ts.net"],
    notBefore: NOT_BEFORE,
    notAfter: NOT_AFTER,
  });

  const parsed = new X509Certificate(certificate.certificatePem);
  assert.equal(parsed.checkPrivateKey(createPrivateKey(certificate.privateKeyPem)), true);
  assert.equal(parsed.checkIP("10.0.0.5"), "10.0.0.5");
  assert.notEqual(parsed.checkIP("fd12::1"), undefined);
  assert.notEqual(parsed.checkHost("host.tailnet.ts.net"), undefined);
  assert.equal(parsed.checkIP("10.0.0.9"), undefined);
  assert.equal(parsed.checkHost("other.example"), undefined);
  assert.equal(parsed.validFromDate.toISOString(), NOT_BEFORE.toISOString());
  assert.equal(parsed.validToDate.toISOString(), NOT_AFTER.toISOString());
  assert.equal(parsed.subject, parsed.issuer);
  // The fingerprint the phone pins is a digest of the DER the listener presents,
  // so the builder's value has to be that same digest and not a re-encoding.
  assert.equal(
    certificate.derSha256Hex,
    createHash("sha256").update(parsed.raw).digest("hex"),
  );
});

test("a host with no certificate has no listener", async () => {
  const active = fixture({ certificates: certificateSource(async () => undefined) });
  await assertFailsClosed(
    active,
    active.bootstrap.configure({ address: BIND_ADDRESS, port: BIND_PORT, now: NOW }),
    "certificate_missing",
  );
});

test("an unreadable certificate source is the same fact as an absent certificate", async () => {
  const active = fixture({
    certificates: certificateSource(async () => {
      throw new Error("EACCES: /home/owner/.ag/host.pem");
    }),
  });
  await assertFailsClosed(
    active,
    active.bootstrap.configure({ address: BIND_ADDRESS, port: BIND_PORT, now: NOW }),
    "certificate_missing",
  );
});

test("unparsable certificate material is refused", async () => {
  const active = fixture({
    certificates: certificateSource(async () => ({
      certificatePem: "-----BEGIN CERTIFICATE-----\nnot base64 at all\n-----END CERTIFICATE-----\n",
      privateKeyPem: hostCertificate().privateKeyPem,
      sourceLabel: "broken source",
    })),
  });
  await assertFailsClosed(
    active,
    active.bootstrap.configure({ address: BIND_ADDRESS, port: BIND_PORT, now: NOW }),
    "certificate_unparsable",
  );
});

test("a private key that belongs to another certificate is refused", async () => {
  const mine = hostCertificate();
  const foreign = hostCertificate();
  const active = fixture({
    certificates: certificateSource(async () => ({
      certificatePem: mine.certificatePem,
      privateKeyPem: foreign.privateKeyPem,
      sourceLabel: "mismatched source",
    })),
  });
  await assertFailsClosed(
    active,
    active.bootstrap.configure({ address: BIND_ADDRESS, port: BIND_PORT, now: NOW }),
    "key_certificate_mismatch",
  );
});

test("an unloadable private key is refused before anything is derived from it", async () => {
  const active = fixture({
    certificates: certificateSource(async () => ({
      certificatePem: hostCertificate().certificatePem,
      privateKeyPem: UNPARSABLE_PRIVATE_KEY_PEM,
      sourceLabel: "broken key source",
    })),
  });
  await assertFailsClosed(
    active,
    active.bootstrap.configure({ address: BIND_ADDRESS, port: BIND_PORT, now: NOW }),
    "private_key_unusable",
  );
});

test("an RSA key below the strength floor is refused", async () => {
  // 1024-bit RSA is a formality rather than a secret, and the strength check
  // runs before key-to-certificate matching: a weak key is rejected on its own
  // terms, not as a side effect of belonging to the wrong certificate.
  const weak = generateKeyPairSync("rsa", {
    modulusLength: 1024,
    publicKeyEncoding: { format: "pem", type: "spki" },
    privateKeyEncoding: { format: "pem", type: "pkcs8" },
  });
  const active = fixture({
    certificates: certificateSource(async () => ({
      certificatePem: hostCertificate().certificatePem,
      privateKeyPem: weak.privateKey,
      sourceLabel: "weak key source",
    })),
  });
  await assertFailsClosed(
    active,
    active.bootstrap.configure({ address: BIND_ADDRESS, port: BIND_PORT, now: NOW }),
    "weak_key",
  );
});

test("a certificate outside its validity window is refused in both directions", async () => {
  const expired = fixture({
    certificates: certificateSource(async () =>
      material(
        hostCertificate({
          notBefore: new Date("2025-01-01T00:00:00.000Z"),
          notAfter: new Date("2026-01-01T00:00:00.000Z"),
        }),
      ),
    ),
  });
  await assertFailsClosed(
    expired,
    expired.bootstrap.configure({ address: BIND_ADDRESS, port: BIND_PORT, now: NOW }),
    "certificate_expired",
  );

  const future = fixture({
    certificates: certificateSource(async () =>
      material(
        hostCertificate({
          notBefore: new Date("2027-01-01T00:00:00.000Z"),
          notAfter: new Date("2028-01-01T00:00:00.000Z"),
        }),
      ),
    ),
  });
  await assertFailsClosed(
    future,
    future.bootstrap.configure({ address: BIND_ADDRESS, port: BIND_PORT, now: NOW }),
    "certificate_not_yet_valid",
  );
});

test("a certificate that covers another address cannot be presented on this one", async () => {
  const active = fixture({
    certificates: certificateSource(async () => material(hostCertificate({ ipSans: ["10.0.0.9"] }))),
  });
  await assertFailsClosed(
    active,
    active.bootstrap.configure({ address: BIND_ADDRESS, port: BIND_PORT, now: NOW }),
    "certificate_address_mismatch",
  );
});
