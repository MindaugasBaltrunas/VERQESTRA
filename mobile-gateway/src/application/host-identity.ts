import { createHash, createPrivateKey, type KeyObject, X509Certificate } from "node:crypto";
import { isAdvertisableHostName } from "./bind-address-policy.js";

/**
 * Host certificate inspection.
 *
 * Pairing shows the user a host fingerprint and the phone pins it, so the
 * fingerprint must be derived from the certificate the listener will actually
 * present — never from a value someone typed into configuration. Every check
 * here fails closed: a host with no provable identity has no remote listener.
 *
 * This module reads no files and opens no sockets; the certificate material is
 * handed in by a port implementation.
 */

export type HostCertificateErrorCode =
  | "certificate_missing"
  | "certificate_unparsable"
  | "private_key_unusable"
  | "key_certificate_mismatch"
  | "weak_key"
  | "certificate_not_yet_valid"
  | "certificate_expired"
  | "certificate_address_mismatch";

export class HostCertificateError extends Error {
  readonly code: HostCertificateErrorCode;

  constructor(code: HostCertificateErrorCode, message: string) {
    super(message);
    this.name = "HostCertificateError";
    this.code = code;
  }
}

/** Lowercase hex digest, matching the `hostFingerprint` pairing challenges carry. */
export const HOST_FINGERPRINT_PATTERN = /^sha256:[0-9a-f]{64}$/;

export type HostCertificateIdentity = Readonly<{
  hostFingerprint: string;
  subject: string;
  issuer: string;
  selfSigned: boolean;
  keyType: "rsa" | "ec" | "ed25519";
  validFrom: string;
  validTo: string;
  addressCoverage: "ip-san" | "dns-san";
}>;

/** Below this an RSA key is a formality rather than a secret. */
const MIN_RSA_MODULUS_BITS = 2048;

export function inspectHostCertificate(
  input: Readonly<{
    certificatePem: string;
    privateKeyPem: string;
    bindAddress: string;
    advertisedHost?: string;
    now?: Date;
  }>,
): HostCertificateIdentity {
  let certificate: X509Certificate;
  try {
    certificate = new X509Certificate(input.certificatePem);
  } catch {
    throw new HostCertificateError(
      "certificate_unparsable",
      "Host certificate is not a parsable X.509 certificate",
    );
  }

  let key: KeyObject;
  try {
    key = createPrivateKey(input.privateKeyPem);
  } catch {
    throw new HostCertificateError(
      "private_key_unusable",
      "Host private key could not be loaded",
    );
  }

  const keyType = key.asymmetricKeyType;
  if (keyType === "rsa") {
    const modulusLength = key.asymmetricKeyDetails?.modulusLength;
    if (modulusLength === undefined || modulusLength < MIN_RSA_MODULUS_BITS) {
      throw new HostCertificateError(
        "weak_key",
        `Host RSA key is shorter than ${MIN_RSA_MODULUS_BITS} bits`,
      );
    }
  } else if (keyType !== "ec" && keyType !== "ed25519") {
    // Anything else is either unusable for TLS or an algorithm this gateway has
    // no strength policy for; refusing is cheaper than guessing.
    throw new HostCertificateError("weak_key", "Host key algorithm is not accepted for TLS");
  }

  if (!certificate.checkPrivateKey(key)) {
    throw new HostCertificateError(
      "key_certificate_mismatch",
      "Host private key does not belong to the host certificate",
    );
  }

  const now = input.now ?? new Date();
  if (now.getTime() < certificate.validFromDate.getTime()) {
    throw new HostCertificateError(
      "certificate_not_yet_valid",
      "Host certificate is not valid yet",
    );
  }
  if (now.getTime() > certificate.validToDate.getTime()) {
    throw new HostCertificateError("certificate_expired", "Host certificate has expired");
  }

  // The phone verifies the name it dialled, so exactly one of the two coverage
  // forms has to hold: an IP SAN for a bare address, a DNS SAN for an
  // advertised name. A certificate that covers neither cannot be presented.
  let addressCoverage: "ip-san" | "dns-san";
  if (input.advertisedHost === undefined) {
    if (!certificate.checkIP(input.bindAddress)) {
      throw new HostCertificateError(
        "certificate_address_mismatch",
        "Host certificate has no IP SAN for the bind address",
      );
    }
    addressCoverage = "ip-san";
  } else {
    if (!isAdvertisableHostName(input.advertisedHost) || !certificate.checkHost(input.advertisedHost)) {
      throw new HostCertificateError(
        "certificate_address_mismatch",
        "Host certificate has no DNS SAN for the advertised host",
      );
    }
    addressCoverage = "dns-san";
  }

  return Object.freeze({
    // Digest of the DER encoding, not `fingerprint256`: that getter returns the
    // colon-separated uppercase form, which is not what pairing transports.
    hostFingerprint: `sha256:${createHash("sha256").update(certificate.raw).digest("hex")}`,
    subject: certificate.subject,
    issuer: certificate.issuer,
    selfSigned: certificate.subject === certificate.issuer,
    keyType,
    validFrom: certificate.validFromDate.toISOString(),
    validTo: certificate.validToDate.toISOString(),
    addressCoverage,
  });
}
