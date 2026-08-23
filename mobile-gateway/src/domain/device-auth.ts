export const DEVICE_SCOPES = [
  "ag:read",
  "terminal:write",
  "github:read",
  "github:write",
] as const;

export type DeviceScope = (typeof DEVICE_SCOPES)[number];

export type PairingChallengeRecord = {
  challengeId: string;
  codeHash: string;
  hostFingerprint: string;
  scopes: DeviceScope[];
  createdAt: string;
  expiresAt: string;
  consumedAt?: string;
};

export type PairedDeviceRecord = {
  deviceId: string;
  principalId: string;
  deviceName: string;
  publicKey: string;
  scopes: DeviceScope[];
  generation: number;
  status: "active" | "revoked";
  pairedAt: string;
  revokedAt?: string;
};

export type RefreshTokenRecord = {
  tokenHash: string;
  deviceId: string;
  familyId: string;
  deviceGeneration: number;
  status: "active" | "rotated" | "revoked";
  issuedAt: string;
  expiresAt: string;
  rotatedAt?: string;
  revokedAt?: string;
};

export type DeviceAuthState = {
  version: 1;
  issuer: string;
  audience: string;
  accessSigningKey: string;
  challenges: Record<string, PairingChallengeRecord>;
  devices: Record<string, PairedDeviceRecord>;
  refreshTokens: Record<string, RefreshTokenRecord>;
};

export type AccessTokenClaims = {
  iss: string;
  aud: string;
  sub: string;
  deviceId: string;
  scopes: DeviceScope[];
  generation: number;
  iat: number;
  exp: number;
  jti: string;
};

export class DeviceAuthError extends Error {
  constructor(
    readonly code:
      | "invalid_pairing"
      | "pairing_expired"
      | "pairing_consumed"
      | "invalid_device_proof"
      | "invalid_refresh_token"
      | "refresh_token_expired"
      | "refresh_token_reuse"
      | "device_revoked"
      | "invalid_access_token"
      | "access_token_expired"
      | "insufficient_scope",
    message: string,
  ) {
    super(message);
    this.name = "DeviceAuthError";
  }
}

export function assertDeviceScopes(scopes: unknown): asserts scopes is DeviceScope[] {
  if (!Array.isArray(scopes) || !scopes.every((scope) => typeof scope === "string")) {
    throw new Error("Scopes must be an array of strings");
  }
  const unique = new Set(scopes);
  if (
    scopes.length === 0 ||
    unique.size !== scopes.length ||
    scopes.some((scope) => !DEVICE_SCOPES.includes(scope as DeviceScope))
  ) {
    throw new Error("Scopes must be a non-empty, unique subset of the device scope allowlist");
  }
}

export function assertAccessScope(claims: AccessTokenClaims, required: DeviceScope): void {
  if (!claims.scopes.includes(required)) {
    throw new DeviceAuthError("insufficient_scope", `Device does not have required scope: ${required}`);
  }
}
