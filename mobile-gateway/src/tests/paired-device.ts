import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import type { DeviceAuthService } from "../application/device-auth-service.js";

function publicKeyText(key: KeyObject): string {
  return key.export({ format: "der", type: "spki" }).toString("base64url");
}

export type PairedTestDevice = Readonly<{
  accessToken: string;
  principalId: string;
  deviceId: string;
}>;

/**
 * Pairs one device against a real `DeviceAuthService`.
 *
 * Tests that exercise a protected route need a genuine token, not a stub: the
 * route's scope check is part of what they assert. The Ed25519 proof is built
 * here so no test has to restate the pairing transcript.
 */
export async function pairTestDevice(
  auth: DeviceAuthService,
  now: Date,
  scopes: string[],
  label = "Test phone",
): Promise<PairedTestDevice> {
  const keys = generateKeyPairSync("ed25519");
  const devicePublicKey = publicKeyText(keys.publicKey);
  const challenge = await auth.createPairingChallenge({
    hostFingerprint: "sha256:44444444444444444444444444444444",
    scopes,
    now,
  });
  const nonce = "paired-device-helper-nonce";
  const paired = await auth.redeemPairingChallenge({
    challengeId: challenge.challengeId,
    oneTimeCode: challenge.oneTimeCode,
    deviceName: label,
    devicePublicKey,
    nonce,
    proof: sign(
      null,
      Buffer.from([
        "ag-pair-v1",
        challenge.challengeId,
        challenge.hostFingerprint,
        devicePublicKey,
        nonce,
      ].join("\n")),
      keys.privateKey,
    ).toString("base64url"),
    now,
  });
  return {
    accessToken: paired.tokens.accessToken,
    principalId: paired.principalId,
    deviceId: paired.deviceId,
  };
}
