import type { SpeechConsentPort, SecureStorePort } from "../../model/ports.js";

/**
 * The only value that reads back as consent. A marker rather than a boolean
 * encoding, so a truncated, empty or legacy blob can never be mistaken for a
 * grant the operator never gave.
 */
const grantedValue = "granted";

/**
 * `SpeechConsentPort` backed by the OS keystore.
 *
 * Consent is read per request and never cached in a field: a grant withdrawn on
 * one screen takes effect on the very next capture, and an instance of this
 * class carries no consent state that could outlive the stored one.
 */
export class SecureCloudConsentStore implements SpeechConsentPort {
  constructor(private readonly store: SecureStorePort) {}

  async readCloudConsent(): Promise<boolean> {
    try {
      return (await this.store.readSecret("speech.cloud-consent")) === grantedValue;
    } catch {
      // A keystore that cannot be read has not recorded a grant. Failing closed
      // here costs one extra tap; failing open would send audio off-device.
      return false;
    }
  }

  async writeCloudConsent(granted: boolean): Promise<void> {
    if (!granted) {
      // Revocation deletes the slot instead of storing a "denied" marker: absence
      // and refusal must be indistinguishable, so no future reader can treat a
      // half-written value as anything but "no consent".
      await this.store.deleteSecret("speech.cloud-consent");
      return;
    }
    await this.store.writeSecret("speech.cloud-consent", grantedValue);
  }
}
