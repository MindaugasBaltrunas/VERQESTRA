import { PushToTalkRecorder, TerminalController, VoiceCaptureController } from "../core";
import type {
  AppEvent,
  CredentialPort,
  GatewayPort,
  SpeechConsentPort,
  SpeechRecognitionPort,
  TerminalStreamControlPort,
  TerminalWriteGatePort,
} from "../core";

/**
 * Composition root input. Concrete ports (HTTP gateway, secure credential
 * storage, WebSocket stream control, biometric write gate) are supplied by the
 * platform adapters; this module never constructs them and holds no transport,
 * storage or UI knowledge of its own.
 */
export interface MobileTerminalPorts {
  /** Absolute terminal stream endpoint; deliberately has no default. */
  readonly streamUrl: string;
  readonly gateway: GatewayPort;
  readonly credentials: CredentialPort;
  readonly stream: TerminalStreamControlPort;
  /**
   * Required: without a confirmation gate the Terminal space would be able to
   * write to the host unattended, so an unwired shell offers no terminal at all
   * rather than an unguarded one.
   */
  readonly writeGate: TerminalWriteGatePort;
  /**
   * Optional, and optional in the opposite direction to `writeGate`: an absent
   * recogniser removes push-to-talk entirely, so it takes an ability away rather
   * than relaxing a guard. There is no unguarded voice path to fall back to.
   */
  readonly speech?: SpeechRecognitionPort;
  /** Consent storage for cloud transcription; without it cloud stays blocked. */
  readonly speechConsent?: SpeechConsentPort;
  readonly speechLocale?: string;
}

export interface MobileAppRuntimeOptions extends MobileTerminalPorts {
  readonly dispatch: (event: AppEvent) => void;
}

export interface MobileAppRuntime {
  readonly controller: TerminalController;
  /** `null` exactly when no recogniser was injected; the screen then offers none. */
  readonly voice: VoiceCaptureController | null;
}

/**
 * PTY geometry for a mobile session. The transcript view wraps text instead of
 * emulating a fixed grid, so there is no measured terminal window to derive
 * columns from; sessions open at the conventional 80x24 and stay there until a
 * layout-aware view has real metrics to feed `TerminalController.resize`.
 */
export const defaultTerminalGeometry = Object.freeze({ cols: 80, rows: 24 });

/**
 * Recognition locale used when the shell names none. A concrete tag, because a
 * recogniser asked for "whatever" tends to pick the platform default and then
 * transcribe a language the operator is not speaking.
 */
export const defaultSpeechLocale = "en-US";

export function createMobileAppRuntime(options: MobileAppRuntimeOptions): MobileAppRuntime {
  const controller = new TerminalController(
    options.gateway,
    options.credentials,
    options.stream,
    options.streamUrl,
    options.dispatch,
    options.writeGate,
  );
  // The voice controller is given the terminal controller as its only submission
  // target, so a confirmed transcript takes exactly the gated path a typed
  // command takes — biometric confirmation included.
  const voice = options.speech === undefined
    ? null
    : new VoiceCaptureController(
      new PushToTalkRecorder(options.speech, options.speechConsent),
      controller,
      options.dispatch,
      options.speechLocale ?? defaultSpeechLocale,
    );
  return { controller, voice };
}
