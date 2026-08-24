import type {
  DeviceCryptoPort,
  DeviceKeyPort,
  DeviceProofPort,
} from "../../model/ports.js";
import type { SecureDeviceIdentity } from "../secure-storage/secure-device-identity.js";
import { NONCE_PATTERN, PROOF_PATTERN } from "../shared/gateway-format.js";

/** Random bytes per nonce. 32 bytes is 43 unpadded base64url characters. */
export const nonceByteLength = 32;

export class DeviceProofError extends Error {
  constructor(
    readonly code: "not_paired" | "weak_nonce" | "invalid_signature",
    message: string,
  ) {
    super(message);
    this.name = "DeviceProofError";
  }
}

/**
 * Builds the canonical refresh transcript and has the keystore sign it. The
 * refresh token itself never enters the transcript — only its SHA-256 — and the
 * private key never enters this process at all: `DeviceKeyPort` signs by alias.
 *
 * `ag-refresh-v1` is a cryptographic domain separator and is carried over
 * UNCHANGED: the verifying side is `mobile-gateway/src/application/device-auth-service.ts`,
 * which spells it the same way. Renaming it here alone would make every refresh
 * fail verification with no diagnosable reason, so the two move together or not
 * at all.
 */
export class DeviceProofSigner implements DeviceProofPort {
  constructor(
    private readonly identity: SecureDeviceIdentity,
    private readonly keys: DeviceKeyPort,
    private readonly crypto: DeviceCryptoPort,
  ) {}

  async createRefreshProof(input: Readonly<{
    deviceId: string;
    generation: number;
    refreshToken: string;
  }>): Promise<Readonly<{ nonce: string; proof: string }>> {
    const alias = await this.identity.loadAlias();
    if (alias === null) {
      throw new DeviceProofError("not_paired", "This device has no signing key");
    }
    const nonce = await this.crypto.randomBase64Url(nonceByteLength);
    // A randomness adapter that degrades has to fail here, at the source,
    // rather than at the HTTP boundary after a signature already exists.
    if (!NONCE_PATTERN.test(nonce)) {
      throw new DeviceProofError("weak_nonce", "Device nonce source is invalid");
    }
    const digest = await this.crypto.sha256Base64Url(input.refreshToken);
    const transcript = [
      "ag-refresh-v1",
      input.deviceId,
      digest,
      nonce,
      String(input.generation),
    ].join("\n");
    const proof = await this.keys.signTranscript({ alias, transcript });
    if (!PROOF_PATTERN.test(proof)) {
      throw new DeviceProofError("invalid_signature", "Device signature is invalid");
    }
    return Object.freeze({ nonce, proof });
  }
}
