import type { ConnectionState, Provider } from "../model/state.js";
import type { SpeechTranscriptionMode, VoiceCaptureState } from "../model/voice.js";

/**
 * View state of the mobile-controlled Agent Terminal. Types only — the
 * projection that fills them is `controller/presentation/terminal-presenter.ts`;
 * see `ag-loop-view-state.ts` for why the two are separate files here. In this
 * one file the split also closes the 500-line gate: the etalon's presenter was
 * 541 lines, and the seam between "what a screen is handed" and "how it is
 * computed" is the one that was already there.
 */

/** Re-exported so a screen never has to name the Model to describe itself. */
export type { Provider } from "../model/state.js";
export type {
  SpeechTranscriptionMode,
  SpeechUnavailableReason,
  VoiceCaptureFailureCode,
} from "../model/voice.js";

/**
 * The capture state under the name the View uses for it: a screen speaks of the
 * phase it renders, not of the Model state machine behind it.
 */
export type VoiceCapturePhase = VoiceCaptureState;

export type TerminalProviderOption = Readonly<{
  provider: Provider;
  label: string;
  selected: boolean;
  /** A provider is never swapped under a session that already exists. */
  enabled: boolean;
}>;

/** PTY lifecycle intents the screen may emit. */
export type TerminalActionId = "start" | "interrupt" | "close" | "detach";

export type TerminalActionButton = Readonly<{
  id: TerminalActionId;
  label: string;
  enabled: boolean;
  /** Ends the host process, as opposed to merely dropping the stream. */
  destructive: boolean;
  hint: string;
}>;

export type TerminalConnectionViewState = Readonly<{
  state: ConnectionState;
  label: string;
  /** The stream is dialling or retrying; a spinner is warranted. */
  showActivity: boolean;
  reconnecting: boolean;
  /** Output is on screen but no longer confirmed by a live stream. */
  stale: boolean;
}>;

export type TerminalLineRow = Readonly<{ key: string; text: string }>;

export type TerminalComposerViewState = Readonly<{
  draft: string;
  placeholder: string;
  /** The draft may be sent right now. */
  canSend: boolean;
  /** Why sending is impossible; `null` exactly when `canSend` holds. */
  blockedReason: string | null;
  characterCount: number;
  maxLength: number;
  tooLong: boolean;
  editable: boolean;
}>;

/**
 * What the screen tells the operator about where their voice is going, before
 * and while it is recorded. `mode` is `null` only until the device was probed.
 */
export type TerminalVoicePrivacy = Readonly<{
  mode: SpeechTranscriptionMode | null;
  onDevice: boolean;
  badge: string;
  label: string;
  /** The backend would transcribe off-device, so consent is a precondition. */
  consentRequired: boolean;
  consentGranted: boolean;
  /** The consent ask; `null` exactly when no consent is outstanding. */
  consentPrompt: string | null;
}>;

export type TerminalVoiceViewState = Readonly<{
  draft: string;
  /** Live recogniser text. Shown while listening, never sendable. */
  partial: string;
  phase: VoiceCapturePhase;
  listening: boolean;
  /** The recogniser is starting or finishing; a spinner is warranted. */
  busy: boolean;
  statusLabel: string;
  holdHint: string;
  /** A new capture may be started right now. */
  canCapture: boolean;
  /** Why capturing is impossible; `null` exactly when `canCapture` holds. */
  captureBlockedReason: string | null;
  /**
   * There is something to abandon — a capture, a review, or a failure. Offered in
   * every phase but `idle`, because a press-out lost to a gesture cancel or to
   * the app being backgrounded otherwise leaves a capture the operator can
   * neither finish nor discard.
   */
  canDiscard: boolean;
  editable: boolean;
  edited: boolean;
  confidence: number | null;
  lowConfidence: boolean;
  acknowledged: boolean;
  /** An uncertain transcript still needs the operator's second look. */
  acknowledgementRequired: boolean;
  acknowledgementLabel: string;
  /** The warning to show; `null` exactly when no acknowledgement is required. */
  lowConfidenceWarning: string | null;
  /** A transcript is never sent without an explicit operator confirmation. */
  confirmationRequired: boolean;
  confirmationLabel: string;
  canConfirm: boolean;
  /** Why confirming is impossible; `null` exactly when `canConfirm` holds. */
  confirmBlockedReason: string | null;
  characterCount: number;
  maxLength: number;
  tooLong: boolean;
  privacy: TerminalVoicePrivacy;
  /** The last capture failure, worded for the operator. */
  errorMessage: string | null;
}>;

export type TerminalViewState = Readonly<{
  title: string;
  providerLabel: string;
  /** Keeps the mobile terminal visibly distinct from the read-only AG Loop UI. */
  scopeNotice: string;
  providers: readonly TerminalProviderOption[];
  connection: TerminalConnectionViewState;
  sessionLabel: string;
  /** Machine-readable `connection:session` pair, used as an accessibility label. */
  statusLabel: string;
  readOnly: boolean;
  canStart: boolean;
  canSubmit: boolean;
  actions: readonly TerminalActionButton[];
  rows: readonly TerminalLineRow[];
  /** Buffered lines outside the rendering window. */
  hiddenLineCount: number;
  hiddenLineLabel: string;
  /** The host dropped replay history; the transcript above has a gap. */
  historyTruncated: boolean;
  historyTruncatedLabel: string;
  isEmpty: boolean;
  emptyLabel: string;
  composer: TerminalComposerViewState;
  voice: TerminalVoiceViewState;
  errorMessage: string | null;
  /** Branch of the session's isolated worktree; `null` before a session reports one. */
  activeBranch: string | null;
}>;
