import { SpeechCaptureError } from "../adapters/speech/push-to-talk-recorder.js";
import type { PushToTalkRecorder } from "../adapters/speech/push-to-talk-recorder.js";
import type {
  SpeechCapability,
  SpeechFinalResult,
  SpeechPartialResult,
} from "../model/ports.js";
import type { AppEvent } from "../model/reducer.js";
import { clampTranscript, isLowConfidence } from "../model/voice.js";
import type { SpeechTranscriptionMode, VoiceCaptureFailureCode } from "../model/voice.js";

/**
 * The one way a transcript may leave this controller. Narrower than the terminal
 * controller on purpose: from here, a confirmed transcript can be sent and
 * nothing else — no lifecycle action, no keyboard input, no session control.
 */
export interface VoiceSubmissionTarget {
  submitConfirmedVoice(text: string): Promise<void>;
}

export class VoiceCaptureError extends Error {
  constructor(
    readonly code:
      | "no-transcript"
      | "transcript-changed"
      | "low-confidence-unconfirmed"
      | "submit-in-flight",
    message: string,
  ) {
    super(message);
    this.name = "VoiceCaptureError";
  }
}

/** Every adapter failure, told as something the screen can word for the operator. */
const captureFailures: Readonly<Record<SpeechCaptureError["code"], VoiceCaptureFailureCode>> =
  Object.freeze({
    "unavailable": "unavailable",
    "permission-denied": "permission-denied",
    "consent-required": "consent-required",
    // A hold that is already gone by the time the adapter is asked about it was
    // dropped, not misheard: nothing is wrong with the recogniser.
    "hold-in-progress": "aborted",
    "no-active-capture": "aborted",
    "aborted": "aborted",
    "recognizer-failed": "recognizer-failed",
  });

function failureCode(error: unknown): VoiceCaptureFailureCode {
  return error instanceof SpeechCaptureError ? captureFailures[error.code] : "recognizer-failed";
}

/**
 * The transcript held between the release of the button and the operator's
 * decision. It exists only here, never in the Model: what the screen shows is a
 * draft to read, and what is sent is this record.
 */
type PendingTranscript = Readonly<{
  text: string;
  mode: SpeechTranscriptionMode;
  confidence: number | null;
  acknowledged: boolean;
}>;

/**
 * Drives one push-to-talk capture from press to sent command.
 *
 * The invariant this class exists for: {@link VoiceSubmissionTarget} is reached
 * from {@link confirm} and from nowhere else, and only when a pending transcript
 * exists, the text the operator confirmed is exactly that transcript, an
 * uncertain transcript was acknowledged, and no submission is already in flight.
 * A pending transcript is created solely from the recogniser's final result, so
 * a partial — the text that appears while the operator is still speaking — has
 * no path to the host at all.
 */
export class VoiceCaptureController {
  private pending: PendingTranscript | undefined;
  private startInFlight = false;
  private capturing = false;
  private cancelRequested = false;
  private submitInFlight = false;
  /**
   * Identifies the capture a recogniser answer belongs to. Bumped by every hold
   * and every cancel, because the flags above cannot tell "discarded" from
   * "replaced by a later hold" once a new press has reset them — and a result
   * from either must not become a transcript the operator never asked to keep.
   */
  private captureGeneration = 0;

  constructor(
    private readonly recorder: PushToTalkRecorder,
    private readonly terminal: VoiceSubmissionTarget,
    private readonly dispatch: (event: AppEvent) => void,
    /** BCP-47 tag chosen by the shell; the core has no locale of its own. */
    private readonly locale: string,
  ) {}

  /**
   * Re-reads what the device can do. It never rejects: availability is a screen
   * state, not a command result, and a shell that fires this on mount must not
   * have to handle a rejection to stay silent about it.
   */
  async refreshAvailability(): Promise<void> {
    let capability: SpeechCapability;
    let cloudConsent: boolean;
    try {
      capability = await this.recorder.probe();
      cloudConsent = await this.recorder.cloudConsentGranted();
    } catch {
      this.dispatch({
        type: "voice.availability",
        availability: "unavailable",
        mode: "cloud",
        reason: "unsupported",
        cloudConsent: false,
      });
      return;
    }
    this.dispatch({
      type: "voice.availability",
      availability: capability.available ? "available" : "unavailable",
      mode: capability.mode,
      reason: capability.available ? null : capability.reason,
      // The stored grant itself, never one inferred from availability: a device
      // that transcribes on-device is available for reasons that say nothing
      // about cloud consent, and reporting a grant nobody gave would put a
      // consent the operator can neither see nor withdraw on the screen.
      cloudConsent,
    });
  }

  async setCloudConsent(granted: boolean): Promise<void> {
    if (granted) {
      await this.recorder.grantCloudConsent();
    } else {
      await this.recorder.revokeCloudConsent();
    }
    // What the store now holds, not what was asked for: a build without consent
    // storage records nothing, and the screen must say so instead of showing a
    // grant that would be refused at the next hold.
    this.dispatch({
      type: "voice.cloud-consent",
      granted: await this.recorder.cloudConsentGranted(),
    });
    // The device is asked again rather than assumed: consent is one condition of
    // availability, and granting it does not make a recogniser appear.
    await this.refreshAvailability();
  }

  /** Press-in. Never rejects: a failed start is a screen state, not an exception. */
  async holdStarted(): Promise<void> {
    if (this.capturing || this.startInFlight) return;
    if (this.pending !== undefined) {
      // A transcript is already waiting to be read. Recording over it would
      // discard a command the operator has not decided about yet.
      this.dispatch({ type: "error", message: "Confirm or discard the transcript first." });
      return;
    }
    // Claimed synchronously, before the first `await`: two press events in the
    // same tick must not both reach the recogniser.
    this.startInFlight = true;
    this.cancelRequested = false;
    // A new hold outdates every answer still owed for an older one.
    const generation = ++this.captureGeneration;
    this.dispatch({ type: "voice.capture-requested" });
    try {
      await this.recorder.beginHold({
        locale: this.locale,
        onPartial: (result) => this.onPartial(result),
      });
    } catch (error) {
      // A recogniser that is still holding a capture this controller no longer
      // knows about is not a failure to report — but the Model was already moved
      // to `starting`, so it has to be released back to idle either way, or the
      // screen keeps a capture that will never start and refuses every new hold.
      this.dispatch(error instanceof SpeechCaptureError && error.code === "hold-in-progress"
        ? { type: "voice.cancelled" }
        : { type: "voice.capture-failed", failure: failureCode(error) });
      return;
    } finally {
      this.startInFlight = false;
    }
    if (this.cancelRequested || generation !== this.captureGeneration) {
      // The button was released, or the screen left, while the recogniser was
      // starting. No `voice.capture-started` is dispatched: the screen must never
      // show that it is listening after the operator stopped asking it to.
      await this.recorder.cancelHold();
      this.dispatch({ type: "voice.cancelled" });
      return;
    }
    this.capturing = true;
    this.dispatch({
      type: "voice.capture-started",
      // Fail closed on the privacy badge: an adapter that did not say which
      // backend it opened is reported as the less private one.
      mode: this.recorder.activeMode ?? "cloud",
    });
  }

  /** Press-out. Never rejects, for the same reason {@link holdStarted} does not. */
  async holdEnded(): Promise<void> {
    if (!this.capturing && !this.startInFlight) return;
    if (!this.capturing) {
      // Released before the recogniser was even listening. There is nothing to
      // finalise, so the hold is abandoned instead of producing a transcript.
      this.cancelRequested = true;
      this.dispatch({ type: "voice.cancelled" });
      return;
    }
    this.capturing = false;
    const generation = this.captureGeneration;
    this.dispatch({ type: "voice.capture-finalizing" });
    let final: SpeechFinalResult;
    try {
      final = await this.recorder.endHold();
    } catch (error) {
      if (generation !== this.captureGeneration) return;
      this.pending = undefined;
      this.dispatch({ type: "voice.capture-failed", failure: failureCode(error) });
      return;
    }
    if (generation !== this.captureGeneration) {
      // The capture was discarded — or replaced by a later hold — while the
      // recogniser was finalising. The Model already dropped it, so keeping the
      // result here would strand a transcript the screen offers no way to send
      // or discard, and every later hold would be refused because of it.
      return;
    }
    const text = clampTranscript(final.text);
    this.dispatch({ type: "voice.transcribed", text, mode: final.mode, confidence: final.confidence });
    // Silence produces no pending transcript at all, so `confirm` has nothing to
    // send and the review panel has nothing to offer.
    this.pending = text.trim().length === 0
      ? undefined
      : Object.freeze({
        text,
        mode: final.mode,
        confidence: final.confidence,
        acknowledged: !isLowConfidence(final.confidence),
      });
  }

  edit(text: string): void {
    const current = this.pending;
    if (current === undefined) return;
    // Editing the transcript is itself the second, deliberate look an uncertain
    // recognition asks for, so it counts as the acknowledgement.
    this.pending = Object.freeze({ ...current, text: clampTranscript(text), acknowledged: true });
    this.dispatch({ type: "voice.draft-edited", text });
  }

  acknowledgeLowConfidence(): void {
    const current = this.pending;
    if (current === undefined) return;
    this.pending = Object.freeze({ ...current, acknowledged: true });
    this.dispatch({ type: "voice.low-confidence-acknowledged" });
  }

  /**
   * Sends the reviewed transcript. `text` is what the screen displayed: it is
   * compared, not sent, so a transcript that changed between the render and the
   * tap is refused instead of being delivered unseen.
   */
  async confirm(text: string): Promise<void> {
    const current = this.pending;
    if (current === undefined) {
      throw new VoiceCaptureError("no-transcript", "There is no reviewed transcript to send");
    }
    if (text !== current.text) {
      this.dispatch({ type: "error", message: "The transcript changed. Review it again." });
      throw new VoiceCaptureError("transcript-changed", "The transcript changed after it was shown");
    }
    if (!current.acknowledged) {
      throw new VoiceCaptureError(
        "low-confidence-unconfirmed",
        "The uncertain transcript was not acknowledged",
      );
    }
    if (this.submitInFlight) {
      throw new VoiceCaptureError("submit-in-flight", "A transcript is already being sent");
    }
    // Claimed synchronously: a double tap must not deliver the command twice.
    this.submitInFlight = true;
    try {
      await this.terminal.submitConfirmedVoice(current.text);
    } catch (error) {
      // The transcript deliberately survives a delivery failure — clearing it
      // would make the operator re-dictate a command they already reviewed — so
      // no capture failure and no cancellation is dispatched here.
      this.dispatch({ type: "error", message: "Voice command was not delivered." });
      throw error;
    } finally {
      this.submitInFlight = false;
    }
    this.pending = undefined;
    this.dispatch({ type: "voice.cancelled" });
  }

  /** Discard, and the way out of every capture. Synchronous by design. */
  cancel(): void {
    this.cancelRequested = true;
    this.capturing = false;
    this.pending = undefined;
    // Retires the capture in flight as well: a recogniser answering after this
    // point is answering a question the operator withdrew.
    this.captureGeneration += 1;
    // Not awaited: leaving the terminal is a synchronous intent, and the recorder
    // never rejects, so there is nothing for the screen to wait for.
    void this.recorder.cancelHold();
    this.dispatch({ type: "voice.cancelled" });
  }

  private onPartial(result: SpeechPartialResult): void {
    // A partial that arrives before the hold was confirmed, or after it ended, is
    // dropped: only a live capture may put recogniser text on the screen.
    if (!this.capturing) return;
    this.dispatch({ type: "voice.partial", text: result.text, confidence: result.confidence });
  }
}
