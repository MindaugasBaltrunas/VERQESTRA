import type {
  SpeechCapability,
  SpeechCaptureHandle,
  SpeechConsentPort,
  SpeechFinalResult,
  SpeechPartialResult,
  SpeechRecognitionPort,
} from "../../model/ports.js";
import type { SpeechTranscriptionMode, SpeechUnavailableReason } from "../../model/voice.js";
import { isRecord } from "../shared/gateway-format.js";

export class SpeechCaptureError extends Error {
  constructor(
    readonly code:
      | "unavailable"
      | "permission-denied"
      | "consent-required"
      | "hold-in-progress"
      | "no-active-capture"
      | "aborted"
      | "recognizer-failed",
    message: string,
  ) {
    super(message);
    this.name = "SpeechCaptureError";
  }
}

/** Speech is refused for a reason the operator can act on, or generically. */
const unavailableCodes: Readonly<Record<SpeechUnavailableReason, SpeechCaptureError["code"]>> =
  Object.freeze({
    "unsupported": "unavailable",
    "permission-denied": "permission-denied",
    "consent-required": "consent-required",
    "offline-model-missing": "unavailable",
  });

/**
 * A rejection's own code, when it carries one. The recogniser port is platform
 * code, so its errors are inspected, never trusted: anything that is not an
 * explicit permission refusal is treated as a recogniser fault.
 */
function rejectionCode(error: unknown): string | undefined {
  if (error instanceof SpeechCaptureError) return error.code;
  if (!isRecord(error)) return undefined;
  const candidate = error["code"];
  return typeof candidate === "string" ? candidate : undefined;
}

/**
 * Press-and-hold capture policy on top of a platform recogniser.
 *
 * It owns the privacy rules — cloud transcription only with recorded consent,
 * one hold at a time, fail closed on every unknown — and nothing else. There is
 * deliberately no `dispatch`, no `GatewayPort` and no `TerminalController` here:
 * recognised text leaves this class only as the value {@link endHold} returns,
 * so no code path exists along which a transcript could reach the host without
 * a caller first taking it and asking the operator. Auto-submit is not forbidden
 * by convention; it is unbuildable from this surface.
 *
 * No audio is exposed, held or buffered: partial results are forwarded to the
 * caller's callback as they arrive and are never accumulated here.
 */
export class PushToTalkRecorder {
  private handle: SpeechCaptureHandle | undefined;
  private mode: SpeechTranscriptionMode | undefined;
  private startInFlight = false;
  private cancelRequested = false;

  constructor(
    private readonly speech: SpeechRecognitionPort,
    /**
     * Optional, because a build without consent storage must still be able to
     * transcribe on-device. Its absence only ever removes an ability — cloud
     * transcription stays blocked — and never relaxes a check.
     */
    private readonly consent?: SpeechConsentPort,
  ) {}

  /** Backend of the capture in progress; `undefined` when nothing is being held. */
  get activeMode(): SpeechTranscriptionMode | undefined {
    return this.mode;
  }

  async probe(): Promise<SpeechCapability> {
    return (await this.evaluate()).capability;
  }

  /**
   * The consent as it is stored right now. Exposed because availability does not
   * imply it: an on-device recogniser is available for reasons that say nothing
   * about cloud transcription, so a caller that wants to state the grant must be
   * able to read the grant rather than infer one from a reason code.
   */
  async cloudConsentGranted(): Promise<boolean> {
    return this.readCloudConsent();
  }

  async grantCloudConsent(): Promise<void> {
    // Without a consent store there is nowhere to record a grant, so cloud
    // transcription stays blocked rather than being enabled for one app run.
    await this.consent?.writeCloudConsent(true);
  }

  async revokeCloudConsent(): Promise<void> {
    await this.consent?.writeCloudConsent(false);
  }

  async beginHold(input: Readonly<{
    locale: string;
    onPartial(result: SpeechPartialResult): void;
  }>): Promise<void> {
    if (this.handle !== undefined || this.startInFlight) {
      // The port is not called at all: a second press must not be able to open a
      // second microphone session behind the first one's back.
      throw new SpeechCaptureError("hold-in-progress", "A push-to-talk hold is already in progress");
    }
    // Held for the whole of `beginHold`, not only for the port call: between the
    // capture being opened and it being stored, neither `handle` nor an
    // openCapture-scoped flag would refuse a second press, and the capture this
    // one overwrote would stay live with nobody holding its handle.
    this.startInFlight = true;
    this.cancelRequested = false;
    try {
      const opened = await this.openCapture(input);
      if (this.cancelRequested) {
        // The operator let go before the recogniser answered. The capture that
        // arrived late is discarded here and handed to nobody, so a hold shorter
        // than the start-up cannot leave a live microphone behind.
        await this.discard(opened.handle);
        return;
      }
      this.handle = opened.handle;
      this.mode = opened.mode;
    } finally {
      this.startInFlight = false;
    }
  }

  /**
   * Ends the hold and yields the recogniser's own final result. A partial is
   * never promoted to a final, and nothing is retained afterwards: this class
   * holds no transcript once the caller has one.
   */
  async endHold(): Promise<SpeechFinalResult> {
    const handle = this.handle;
    if (handle === undefined) {
      throw new SpeechCaptureError("no-active-capture", "No push-to-talk capture is active");
    }
    const opened = this.mode;
    try {
      const final = await handle.stop();
      // An explicit literal, never a spread: whatever else a platform result
      // carries — audio, a file path, a request id — stops here.
      return Object.freeze({
        text: final.text,
        // Fail closed on the privacy claim: only a capture this adapter opened
        // on-device, and whose result agrees, is declared on-device. A cloud
        // capture — or a result that says anything else — is reported as cloud,
        // so no transcript can be labelled more private than it was produced.
        mode: opened === "on-device" && final.mode === "on-device" ? "on-device" : "cloud",
        confidence: final.confidence,
      });
    } finally {
      // Cleared even when `stop()` throws: a capture that failed to finalise must
      // not stay endable, or the next press would be refused as "in progress".
      this.clearCapture();
    }
  }

  /** Idempotent and total: cancelling twice, or with nothing held, is not an error. */
  async cancelHold(): Promise<void> {
    this.cancelRequested = true;
    const handle = this.handle;
    this.clearCapture();
    if (handle === undefined) return;
    await this.discard(handle);
  }

  private async discard(handle: SpeechCaptureHandle): Promise<void> {
    try {
      await handle.cancel();
    } catch {
      // A recogniser that cannot cancel must not turn a release into a failure
      // the screen has to explain: the capture is already gone on this side.
    }
  }

  /**
   * Checks the policy and opens exactly one capture. It rejects rather than
   * returning a refusal, so no caller can reach a handle without having passed
   * the policy. The in-flight flag it runs under is owned by {@link beginHold},
   * which holds it until the capture is stored — releasing it here would reopen
   * the window in which a second press finds neither a flag nor a handle.
   */
  private async openCapture(input: Readonly<{
    locale: string;
    onPartial(result: SpeechPartialResult): void;
  }>): Promise<Readonly<{ handle: SpeechCaptureHandle; mode: SpeechTranscriptionMode }>> {
    const { capability, cloudConsent } = await this.evaluate();
    if (!capability.available) {
      // Refused before the microphone is touched: an unavailable recogniser and
      // a missing consent are both answered without starting a capture.
      throw new SpeechCaptureError(
        capability.reason === null ? "unavailable" : unavailableCodes[capability.reason],
        "Speech capture is unavailable",
      );
    }
    let handle: SpeechCaptureHandle;
    try {
      handle = await this.speech.startCapture({
        // Cloud is permitted only for a capture this device has declared it
        // will run in the cloud, and only with a recorded grant. Consent alone
        // must not license an off-device capture the operator was told — by the
        // very badge this mode drives — would happen on the phone.
        allowCloud: cloudConsent && capability.mode === "cloud",
        locale: input.locale,
        onPartial: input.onPartial,
      });
    } catch (error) {
      throw new SpeechCaptureError(
        rejectionCode(error) === "permission-denied" ? "permission-denied" : "recognizer-failed",
        "Speech capture could not be started",
      );
    }
    return Object.freeze({ handle, mode: capability.mode });
  }

  /**
   * Capability as this adapter reports it, with the stored consent that produced
   * it. Cloud transcription without a recorded grant is reported unavailable even
   * when the platform says it would work — the operator's consent is a condition
   * of availability here, not an extra step someone could forget to check.
   */
  private async evaluate(): Promise<Readonly<{
    capability: SpeechCapability;
    cloudConsent: boolean;
  }>> {
    const cloudConsent = await this.readCloudConsent();
    let reported: SpeechCapability;
    try {
      reported = await this.speech.probe();
    } catch {
      // A probe that throws says nothing, and nothing is not permission.
      return Object.freeze({
        capability: Object.freeze({
          available: false,
          mode: "cloud" as const,
          reason: "unsupported" as const,
          onDeviceSupported: false,
        }),
        cloudConsent,
      });
    }
    if (reported.mode === "cloud" && !cloudConsent) {
      return Object.freeze({
        capability: Object.freeze({
          available: false,
          mode: "cloud" as const,
          reason: "consent-required" as const,
          onDeviceSupported: reported.onDeviceSupported,
        }),
        cloudConsent,
      });
    }
    return Object.freeze({
      capability: Object.freeze({
        available: reported.available,
        mode: reported.mode,
        reason: reported.available ? null : reported.reason,
        onDeviceSupported: reported.onDeviceSupported,
      }),
      cloudConsent,
    });
  }

  private async readCloudConsent(): Promise<boolean> {
    if (this.consent === undefined) return false;
    try {
      // Read per call, never cached: a consent revoked in settings takes effect on
      // the next hold, not on the next app start.
      return (await this.consent.readCloudConsent()) === true;
    } catch {
      return false;
    }
  }

  private clearCapture(): void {
    this.handle = undefined;
    this.mode = undefined;
  }
}
