/**
 * Platform speech recognition for the native shell — the missing half of
 * `SpeechRecognitionPort` (`mobile-app/src/model/ports.ts`).
 *
 * The MVC core declares the port but may not implement it: a recogniser is only
 * reachable through the `expo` package family, which `mvc-boundaries.test.ts`
 * forbids the core to import by name. So the implementation belongs here, on the
 * native side, and nowhere else.
 *
 * This file imports `expo-speech-recognition` NOWHERE, for the same reason
 * `expo-secure-store-adapter.ts` and `expo-biometric-authenticator.ts` name no
 * module: the composition root owns the real dependency (one place to audit),
 * and this module stays loadable under a plain `node --test` run, where no Expo
 * native module exists. It is therefore tested by construction rather than read
 * as text.
 *
 * WHY `expo-speech-recognition` AND NOT `@react-native-voice/voice`: this shell
 * is Expo SDK 54 with `newArchEnabled: true` (`app.json`). The Expo-module
 * package is built on the Expo Modules API, so it is autolinked and speaks the
 * New Architecture; `@react-native-voice/voice` is a legacy bridge module that
 * reaches the new runtime only through the interop layer. It also exposes the
 * two facts this port is defined in terms of — `supportsOnDeviceRecognition()`
 * and a per-capture `requiresOnDeviceRecognition` flag — which is what makes the
 * "no cloud without consent" rule enforceable here instead of merely asserted.
 */

/**
 * Exactly the `expo-speech-recognition` call surface this adapter uses — no
 * more, so a test double stays small and an unused API cannot creep in
 * unnoticed. Method syntax is deliberate: it makes the real module structurally
 * assignable here without importing its types.
 */
export interface ExpoSpeechPermissionResponse {
  readonly granted: boolean;
  /** `false` only after a refusal the OS will not let the app re-ask for. */
  readonly canAskAgain: boolean;
}

export interface ExpoSpeechStartOptions {
  readonly lang: string;
  readonly interimResults: boolean;
  readonly continuous: boolean;
  /** The privacy switch: `true` forbids the platform from leaving the device. */
  readonly requiresOnDeviceRecognition: boolean;
}

export interface ExpoSpeechResultEvent {
  readonly results: ReadonlyArray<Readonly<{ transcript: string; confidence?: number }>>;
  readonly isFinal: boolean;
}

export interface ExpoSpeechErrorEvent {
  readonly error: string;
  readonly message?: string;
}

export interface ExpoSpeechSubscription {
  remove(): void;
}

/** Payload per event name, the way the module's own emitter is typed. */
export interface ExpoSpeechEventMap {
  result: ExpoSpeechResultEvent;
  error: ExpoSpeechErrorEvent;
  end: undefined;
}

export interface ExpoSpeechRecognitionModule {
  isRecognitionAvailable(): boolean;
  supportsOnDeviceRecognition(): boolean;
  getPermissionsAsync(): Promise<ExpoSpeechPermissionResponse>;
  requestPermissionsAsync(): Promise<ExpoSpeechPermissionResponse>;
  start(options: ExpoSpeechStartOptions): void;
  stop(): void;
  abort(): void;
  addListener<Name extends keyof ExpoSpeechEventMap>(
    eventName: Name,
    listener: (event: ExpoSpeechEventMap[Name]) => void,
  ): ExpoSpeechSubscription;
}

/**
 * Structurally identical to the core's speech vocabulary, restated locally for
 * the same reason `NativeSecureStore` restates `SecureStorePort`: importing it
 * would drag `../core` — and with it the whole `@verqestra/mobile-app`
 * resolution seam — into a file that must stay importable without Metro.
 * `native-runtime.ts` annotates the factory result as `SpeechRecognitionPort`,
 * so the two shapes are checked against each other at compile time in the one
 * place that can see both.
 */
export type NativeSpeechTranscriptionMode = "on-device" | "cloud";

export type NativeSpeechUnavailableReason =
  | "unsupported"
  | "permission-denied"
  | "consent-required"
  | "offline-model-missing";

export interface NativeSpeechCapability {
  readonly available: boolean;
  readonly mode: NativeSpeechTranscriptionMode;
  readonly reason: NativeSpeechUnavailableReason | null;
  readonly onDeviceSupported: boolean;
}

export interface NativeSpeechPartialResult {
  readonly text: string;
  readonly confidence: number | null;
}

export interface NativeSpeechFinalResult {
  readonly text: string;
  readonly mode: NativeSpeechTranscriptionMode;
  readonly confidence: number | null;
}

export interface NativeSpeechCaptureHandle {
  stop(): Promise<NativeSpeechFinalResult>;
  cancel(): Promise<void>;
}

export interface NativeSpeechRecognizer {
  probe(): Promise<NativeSpeechCapability>;
  startCapture(input: Readonly<{
    allowCloud: boolean;
    locale: string;
    onPartial(result: NativeSpeechPartialResult): void;
  }>): Promise<NativeSpeechCaptureHandle>;
}

export type NativeSpeechErrorCode =
  | "unavailable"
  | "permission-denied"
  | "aborted"
  | "recognizer-failed";

/**
 * A refusal the caller can act on, carrying a `code` rather than a message to
 * match on. `PushToTalkRecorder` reads exactly this field
 * (`push-to-talk-recorder.ts#rejectionCode`) and promotes `permission-denied`
 * to its own typed failure; everything else it treats as a recogniser fault. So
 * a denied microphone arrives at the screen as "permission denied" instead of
 * the silent empty transcript a swallowing adapter would produce.
 *
 * The message never carries recognised text: a transcript in an error string
 * could be logged or sent to a crash reporter, which is exactly the path the
 * consent rules exist to close.
 */
export class NativeSpeechRecognitionError extends Error {
  constructor(readonly code: NativeSpeechErrorCode, message: string) {
    super(message);
    this.name = "NativeSpeechRecognitionError";
  }
}

/**
 * Web Speech API error strings, which this module re-emits, mapped onto the
 * codes above. Only what the caller can act on differently is distinguished:
 * a refused microphone is `permission-denied`, an aborted session is `aborted`,
 * and everything else is a recogniser fault.
 *
 * The map is deliberately not exhaustive: an unknown string falls through to
 * `recognizer-failed` below, so a failure mode shipped by a future version fails
 * the capture instead of arriving unclassified.
 */
const errorCodes: ReadonlyMap<string, NativeSpeechErrorCode> = new Map([
  ["not-allowed", "permission-denied" as const],
  ["service-not-allowed", "permission-denied" as const],
  ["aborted", "aborted" as const],
]);

/**
 * Silence is not a fault. The platform reports "heard nothing" as an error
 * event, but the core already has a path for an empty transcript — it produces
 * no pending text and nothing to confirm (`voice-capture-controller.ts`) — and
 * routing it through a failure instead would make the screen explain a
 * recogniser problem that did not happen.
 */
const silenceErrors: ReadonlySet<string> = new Set(["no-speech", "no-match"]);

/** Fail closed on the confidence claim: anything that is not a real number is "unknown". */
function toConfidence(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * The best transcript of an event. The platform orders alternatives by
 * likelihood, so the first is the one it stands behind; the rest are dropped
 * here rather than being carried around as text nobody chose.
 */
function toText(event: ExpoSpeechResultEvent): NativeSpeechPartialResult {
  const best = event.results[0];
  return best === undefined
    ? { text: "", confidence: null }
    : { text: best.transcript, confidence: toConfidence(best.confidence) };
}

/** How a capture ended; a value rather than a rejection, so nothing goes unhandled. */
type CaptureOutcome =
  | Readonly<{ kind: "final"; result: NativeSpeechFinalResult }>
  | Readonly<{ kind: "failed"; error: NativeSpeechRecognitionError }>;

export interface NativeSpeechRecognizerOptions {
  readonly module: ExpoSpeechRecognitionModule;
}

/**
 * `SpeechRecognitionPort` over `expo-speech-recognition`.
 *
 * The privacy rule the port states is enforced by construction rather than by
 * convention: `allowCloud === false` becomes `requiresOnDeviceRecognition:
 * true`, and a device that cannot recognise on-device is refused outright. There
 * is no branch on which this adapter starts a cloud capture the caller did not
 * permit — a fallback would send audio the operator never consented to.
 *
 * No audio is buffered, retained or exposed: partial results are forwarded to
 * the caller's callback as they arrive, and the final one is handed over once.
 */
export function createNativeSpeechRecognizer(
  options: NativeSpeechRecognizerOptions,
): NativeSpeechRecognizer {
  const speech = options.module;

  /** `mode` reports the backend, so an unknown device is reported as the less private one. */
  function unavailable(
    reason: NativeSpeechUnavailableReason,
    onDeviceSupported: boolean,
  ): NativeSpeechCapability {
    return {
      available: false,
      mode: onDeviceSupported ? "on-device" : "cloud",
      reason,
      onDeviceSupported,
    };
  }

  async function probe(): Promise<NativeSpeechCapability> {
    let onDeviceSupported = false;
    try {
      if (speech.isRecognitionAvailable() !== true) return unavailable("unsupported", false);
      onDeviceSupported = speech.supportsOnDeviceRecognition() === true;
      // `getPermissionsAsync`, never `requestPermissionsAsync`: a probe is a
      // capability question, and asking it must not put an OS dialog in front of
      // an operator who only opened the terminal.
      const permission = await speech.getPermissionsAsync();
      if (permission.granted !== true && permission.canAskAgain !== true) {
        // Refused for good: the capture path could not recover from this by
        // prompting, so the recogniser is genuinely unavailable.
        return unavailable("permission-denied", onDeviceSupported);
      }
      // A permission that has not been asked for yet is NOT reported as denied:
      // the core refuses to start a capture on an unavailable recogniser, so
      // saying "denied" here would make the first grant unreachable.
      return {
        available: true,
        mode: onDeviceSupported ? "on-device" : "cloud",
        reason: null,
        onDeviceSupported,
      };
    } catch {
      // A platform that threw has said nothing, and nothing is not a capability.
      return unavailable("unsupported", onDeviceSupported);
    }
  }

  async function requirePermission(): Promise<void> {
    let permission: ExpoSpeechPermissionResponse;
    try {
      permission = await speech.requestPermissionsAsync();
    } catch (cause) {
      throw new NativeSpeechRecognitionError(
        "recognizer-failed",
        `the microphone permission could not be requested: ${String(cause)}`,
      );
    }
    if (permission.granted !== true) {
      // Checked positively: a malformed response from a module version this
      // shape does not match denies the capture instead of opening a microphone.
      throw new NativeSpeechRecognitionError(
        "permission-denied",
        "the operator has not granted microphone access",
      );
    }
  }

  function openCapture(input: Readonly<{
    allowCloud: boolean;
    locale: string;
    onPartial(result: NativeSpeechPartialResult): void;
  }>): NativeSpeechCaptureHandle {
    // Decided once, here, and used for both the platform flag and the reported
    // mode, so the badge the operator reads and the backend the audio went to
    // can never be derived from two different answers.
    const mode: NativeSpeechTranscriptionMode = input.allowCloud ? "cloud" : "on-device";
    const subscriptions: ExpoSpeechSubscription[] = [];
    let lastFinal: NativeSpeechPartialResult | undefined;
    let settled = false;
    let stopRequested = false;
    let resolveOutcome: (outcome: CaptureOutcome) => void = () => undefined;
    const outcome = new Promise<CaptureOutcome>((resolve) => {
      resolveOutcome = resolve;
    });

    function cleanup(): void {
      for (const subscription of subscriptions) {
        try {
          subscription.remove();
        } catch {
          // A listener that cannot be removed must not turn a finished capture
          // into a failure; the session is over on this side either way.
        }
      }
      subscriptions.length = 0;
    }

    /** First settlement wins, so a late `end` cannot overwrite an error. */
    function settle(value: CaptureOutcome): void {
      if (settled) return;
      settled = true;
      cleanup();
      resolveOutcome(value);
    }

    function finish(result: NativeSpeechPartialResult | undefined): void {
      settle({
        kind: "final",
        result: { text: result?.text ?? "", mode, confidence: result?.confidence ?? null },
      });
    }

    subscriptions.push(speech.addListener("result", (event) => {
      const heard = toText(event);
      if (event.isFinal) {
        // Held, not settled: the platform emits the final result and then `end`,
        // and settling here would drop a correction that arrives between them.
        lastFinal = heard;
        return;
      }
      input.onPartial(heard);
    }));

    subscriptions.push(speech.addListener("error", (event) => {
      if (silenceErrors.has(event.error)) {
        finish(undefined);
        return;
      }
      settle({
        kind: "failed",
        error: new NativeSpeechRecognitionError(
          errorCodes.get(event.error) ?? "recognizer-failed",
          `the recogniser failed: ${event.error}`,
        ),
      });
    }));

    // A partial is never promoted to a final: a session that ended without one
    // yields an empty transcript, which the core turns into "nothing to send".
    subscriptions.push(speech.addListener("end", () => finish(lastFinal)));

    return {
      async stop(): Promise<NativeSpeechFinalResult> {
        if (!stopRequested) {
          stopRequested = true;
          try {
            speech.stop();
          } catch (cause) {
            settle({
              kind: "failed",
              error: new NativeSpeechRecognitionError(
                "recognizer-failed",
                `the capture could not be finalised: ${String(cause)}`,
              ),
            });
          }
        }
        // Idempotent by awaiting the same settlement: a second release finalises
        // nothing twice and gets the same answer as the first.
        const settlement = await outcome;
        if (settlement.kind === "failed") throw settlement.error;
        return settlement.result;
      },

      async cancel(): Promise<void> {
        try {
          speech.abort();
        } catch {
          // Cancelling is not a failure: the capture is discarded on this side
          // whatever the platform says about it.
        }
        // Settles a `stop()` that is still waiting — leaving the terminal cancels
        // a capture whose finalisation is in flight, and a promise nobody ever
        // resolves would leave the screen finalising forever. The rejection is
        // discarded by the controller, which has already moved on.
        settle({
          kind: "failed",
          error: new NativeSpeechRecognitionError("aborted", "the capture was discarded"),
        });
      },
    };
  }

  return {
    probe,

    async startCapture(input): Promise<NativeSpeechCaptureHandle> {
      if (speech.isRecognitionAvailable() !== true) {
        throw new NativeSpeechRecognitionError(
          "unavailable",
          "this device has no speech recogniser",
        );
      }
      // Refused before the microphone is touched: a device that cannot recognise
      // on-device has nothing to fall back to when the cloud is forbidden, and
      // falling back to it anyway is precisely what the port rules out.
      if (!input.allowCloud && speech.supportsOnDeviceRecognition() !== true) {
        throw new NativeSpeechRecognitionError(
          "unavailable",
          "on-device recognition was required but this device supports none",
        );
      }
      await requirePermission();

      const handle = openCapture(input);
      try {
        speech.start({
          lang: input.locale,
          interimResults: true,
          // A hold lasts as long as the operator holds it. Without this the
          // platform ends the capture at the first pause, and a press-and-hold
          // gesture would finalise while the operator is still speaking.
          continuous: true,
          requiresOnDeviceRecognition: !input.allowCloud,
        });
      } catch (cause) {
        // The listeners are already attached, so they are taken down before the
        // rejection leaves: a failed start must not leave a live subscription.
        await handle.cancel();
        throw new NativeSpeechRecognitionError(
          "recognizer-failed",
          `the recogniser could not be started: ${String(cause)}`,
        );
      }
      return handle;
    },
  };
}
