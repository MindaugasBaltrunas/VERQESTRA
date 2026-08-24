import type { DeviceKeyPort, SecureStorePort } from "../../model/ports.js";

/**
 * A keystore alias is an identifier, not key material, but a malformed one
 * still has to be refused: it would address a slot no key lives in, and every
 * later signature would fail with no way to tell why.
 */
export const deviceKeyAliasPattern = /^[A-Za-z0-9._-]{8,128}$/;

/**
 * Host certificate fingerprint as shown by the local host. Bounds match the
 * gateway's own (`hostFingerprint` is 16..200 characters there); the charset is
 * printable ASCII so a pinned value can never carry whitespace or control bytes
 * that would silently change the signed pairing transcript.
 */
export const hostFingerprintPattern = /^[\x21-\x7e]{16,200}$/;

export class DeviceIdentityError extends Error {
  constructor(readonly code: "invalid_alias" | "invalid_fingerprint", message: string) {
    super(message);
    this.name = "DeviceIdentityError";
  }
}

/**
 * The non-token half of a device's identity: which keystore key this install
 * owns, and which host it is pinned to. Both are validated on the way in and on
 * the way out, so a tampered or partially written keystore reads as "unpaired"
 * instead of as a usable but wrong identity.
 */
export class SecureDeviceIdentity {
  constructor(
    private readonly store: SecureStorePort,
    private readonly keys: DeviceKeyPort,
  ) {}

  async loadAlias(): Promise<string | null> {
    const value = await this.store.readSecret("device.key-alias");
    return value !== null && deviceKeyAliasPattern.test(value) ? value : null;
  }

  async saveAlias(alias: string): Promise<void> {
    if (!deviceKeyAliasPattern.test(alias)) {
      throw new DeviceIdentityError("invalid_alias", "Device key alias is invalid");
    }
    await this.store.writeSecret("device.key-alias", alias);
  }

  async loadHostFingerprint(): Promise<string | null> {
    const value = await this.store.readSecret("device.host-fingerprint");
    return value !== null && hostFingerprintPattern.test(value) ? value : null;
  }

  async saveHostFingerprint(value: string): Promise<void> {
    if (!hostFingerprintPattern.test(value)) {
      throw new DeviceIdentityError("invalid_fingerprint", "Host fingerprint is invalid");
    }
    await this.store.writeSecret("device.host-fingerprint", value);
  }

  /** Drops the alias without touching the key it names. */
  async clearAlias(): Promise<void> {
    await this.store.deleteSecret("device.key-alias");
  }

  /** Drops the host pin. Used to undo a pin this device itself just wrote. */
  async clearHostFingerprint(): Promise<void> {
    await this.store.deleteSecret("device.host-fingerprint");
  }

  /**
   * Destroys the keystore key first, then the metadata: if the process dies
   * mid-way the remaining state points at a key that no longer exists, which
   * reads as unpaired. The reverse order could leave a live, unreferenced key.
   * Idempotent, so revocation handling can call it unconditionally.
   */
  async forget(): Promise<void> {
    const alias = await this.loadAlias();
    if (alias !== null) await this.keys.deleteDeviceKey(alias);
    await this.store.deleteSecret("device.key-alias");
    await this.store.deleteSecret("device.host-fingerprint");
  }
}
