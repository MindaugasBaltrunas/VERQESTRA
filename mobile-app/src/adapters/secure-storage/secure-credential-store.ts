import type {
  CredentialPort,
  DeviceCredential,
  SecureStorePort,
} from "../../model/ports.js";
import {
  deviceCredentialKeys,
  exactKeys,
  isRecord,
  isValidDeviceCredential,
  utf8ByteLength,
} from "../shared/gateway-format.js";

/**
 * iOS and Android secure-store items are size limited. A blob larger than this
 * is refused loudly rather than written and silently truncated, because a
 * truncated credential reads back as "not paired" with no explanation.
 */
export const maxCredentialBytes = 2048;

export class SecureStorageError extends Error {
  constructor(
    readonly code: "invalid_credential" | "storage_limit",
    message: string,
  ) {
    super(message);
    this.name = "SecureStorageError";
  }
}

/**
 * NUKRYPIMAS (tvarka, ne priimamų blob'ų aibė): etalonas pirma SUKONSTRUODAVO `candidate` su
 * `String(...)` konversijomis ir `value.generation as number`, ir tik paskui tikrindavo, ar
 * laukai apskritai yra tų tipų. Tai reiškė, kad `as` gyvavo tarp dviejų eilučių, kuriose jis
 * dar nebuvo įrodytas. Čia tikrinama pirma, o objektas statomas iš jau susiaurintų reikšmių —
 * jokių konversijų ir jokio `as`. Atmetamų blob'ų aibė identiška: kiekvienas laukas, kurio
 * `typeof` netiko, ir anksčiau baigdavosi `undefined`.
 */
function parseStoredCredential(raw: string): DeviceCredential | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isRecord(value) || !exactKeys(value, deviceCredentialKeys)) return undefined;
  const deviceId = value["deviceId"];
  const generation = value["generation"];
  const accessToken = value["accessToken"];
  const accessExpiresAt = value["accessExpiresAt"];
  const refreshToken = value["refreshToken"];
  const refreshExpiresAt = value["refreshExpiresAt"];
  if (
    typeof deviceId !== "string" ||
    typeof generation !== "number" ||
    typeof accessToken !== "string" ||
    typeof accessExpiresAt !== "string" ||
    typeof refreshToken !== "string" ||
    typeof refreshExpiresAt !== "string"
  ) {
    return undefined;
  }
  const candidate: DeviceCredential = {
    deviceId,
    generation,
    accessToken,
    accessExpiresAt,
    refreshToken,
    refreshExpiresAt,
  };
  return isValidDeviceCredential(candidate) ? Object.freeze(candidate) : undefined;
}

/**
 * `CredentialPort` backed by the OS keystore. The device credential is read per
 * request and never cached in a field: an instance of this class holds no token,
 * so nothing that inspects, serialises or reports it can leak one.
 */
export class SecureCredentialStore implements CredentialPort {
  constructor(private readonly store: SecureStorePort) {}

  async loadDeviceCredential(): Promise<DeviceCredential | null> {
    const raw = await this.store.readSecret("device.credential");
    if (raw === null) return null;
    // A malformed blob is reported as "not paired" but is deliberately NOT
    // deleted: a destructive side effect on a read would turn one bad decode
    // into permanent data loss, and the caller's recovery path is re-pairing,
    // which overwrites the slot anyway.
    return parseStoredCredential(raw) ?? null;
  }

  async storeDeviceCredential(value: DeviceCredential): Promise<void> {
    if (!isValidDeviceCredential(value)) {
      // Message carries no field value: a rotated token must never reach an
      // error string that could be logged or shown.
      throw new SecureStorageError("invalid_credential", "Device credential is invalid");
    }
    // Explicit literal rather than a spread, so an extra property on the input
    // (a private key, a one-time code) can never reach the keystore.
    const serialized = JSON.stringify({
      deviceId: value.deviceId,
      generation: value.generation,
      accessToken: value.accessToken,
      accessExpiresAt: value.accessExpiresAt,
      refreshToken: value.refreshToken,
      refreshExpiresAt: value.refreshExpiresAt,
    });
    if (utf8ByteLength(serialized) > maxCredentialBytes) {
      throw new SecureStorageError("storage_limit", "Device credential is too large to store");
    }
    await this.store.writeSecret("device.credential", serialized);
  }

  async clearDeviceCredential(): Promise<void> {
    // Only the tokens. The keystore key and the pinned host survive, because
    // this runs on every refresh 401 and destroying the hardware identity on a
    // transient authentication failure would force a physical re-pairing.
    await this.store.deleteSecret("device.credential");
  }
}
