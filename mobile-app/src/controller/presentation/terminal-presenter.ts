import type { AppState, ConnectionState, Provider, TerminalState } from "../../model/state.js";
import { isLowConfidence } from "../../model/voice.js";
import type {
  SpeechTranscriptionMode,
  SpeechUnavailableReason,
  VoiceCaptureFailureCode,
} from "../../model/voice.js";
import type {
  TerminalActionButton,
  TerminalComposerViewState,
  TerminalConnectionViewState,
  TerminalLineRow,
  TerminalProviderOption,
  TerminalViewState,
  TerminalVoicePrivacy,
  TerminalVoiceViewState,
  VoiceCapturePhase,
} from "../../view/terminal-view-state.js";

/**
 * Presentation for the mobile-controlled Agent Terminal (Claude Code / Codex).
 *
 * Every decision the screen needs is taken here — which provider may be picked,
 * which PTY lifecycle action is available, whether the composer accepts input,
 * how much of the rolling output buffer is rendered, and how a reconnecting or
 * truncated stream is worded — so the native screen stays a pure renderer.
 *
 * The output text is rendered exactly as received: ANSI/OSC sanitisation is a
 * host responsibility (mobile gateway plain-text safety mode), never a mobile
 * one, so this module neither strips nor re-interprets control sequences.
 */

/**
 * Rendering window over the Model's rolling output buffer. The Model keeps the
 * last 2 000 lines; the screen renders at most this many of them, so a long
 * running session cannot grow the rendered list without bound. Whatever the
 * window drops is reported through `hiddenLineCount`, never silently.
 */
export const terminalVisibleLineLimit = 500;

/**
 * Longest input the composer offers to send. `TerminalController` enforces the
 * same bound before the write reaches the gateway; the two are kept in step by
 * `src/tests/terminal-presentation.test.ts`.
 */
export const terminalInputMaxLength = 16_384;

/** Selectable agent providers, in the order the screen lists them. */
export const selectableProviders: readonly Provider[] = Object.freeze(["claude-code", "codex"] as const);

const providerLabels: Readonly<Record<Provider, string>> = Object.freeze({
  "claude-code": "Claude Code",
  "codex": "Codex",
});

const sessionLabels: Readonly<Record<TerminalState, string>> = Object.freeze({
  "none": "No session",
  "creating": "Starting session…",
  "live": "Live",
  "read-only": "Read-only — the writer lease is held elsewhere",
  "closing": "Closing session…",
  "ended": "Session ended",
  "failed": "Session failed",
});

const connectionLabels: Readonly<Record<ConnectionState, string>> = Object.freeze({
  disconnected: "Not connected",
  connecting: "Connecting",
  live: "Live",
  reconnecting: "Reconnecting — output may be delayed",
  offline: "Offline",
});

/**
 * Where the words were transcribed, in the operator's words. The screen renders
 * these strings and knows no backend name of its own, so the privacy claim it
 * shows can only ever be the one the Model holds.
 */
const voicePrivacyBadges: Readonly<Record<SpeechTranscriptionMode, string>> = Object.freeze({
  "on-device": "On-device",
  "cloud": "Cloud",
});

const voicePrivacyLabels: Readonly<Record<SpeechTranscriptionMode, string>> = Object.freeze({
  "on-device": "Transcribed on this device.",
  "cloud": "Transcribed by the OS cloud service.",
});

const voiceUnavailableLabels: Readonly<Record<SpeechUnavailableReason, string>> = Object.freeze({
  "unsupported": "Speech recognition is not available on this device.",
  "permission-denied": "Microphone access is turned off for this app.",
  "consent-required": "Cloud transcription needs your consent.",
  "offline-model-missing": "The on-device speech model is not installed.",
});

const voicePhaseLabels: Readonly<Record<VoiceCapturePhase, string>> = Object.freeze({
  "idle": "Hold the button and speak.",
  "starting": "Starting the recogniser…",
  "listening": "Listening…",
  "finalizing": "Finishing the transcript…",
  "review": "Read the transcript before it is sent.",
  "failed": "The last capture did not produce a command.",
});

const voiceFailureLabels: Readonly<Record<VoiceCaptureFailureCode, string>> = Object.freeze({
  "unavailable": "Speech recognition is not available on this device.",
  "permission-denied": "Microphone access is turned off for this app.",
  "consent-required": "Cloud transcription needs your consent.",
  "no-speech": "Nothing was recognised. Hold the button and speak again.",
  "aborted": "The recording was discarded.",
  "recognizer-failed": "The recogniser failed. Try again.",
});

/**
 * View-owned input that is not Model state: the composer draft lives in the
 * shell until the operator sends it, so an in-progress command is never part
 * of the shared application state. `activeBranch` is likewise not Model state
 * — it comes straight off the `TerminalController`'s current session — so an
 * operator can never mistake a stale worktree name for a live one.
 */
export type TerminalPresentationInput = Readonly<{
  composerDraft?: string;
  activeBranch?: string | null;
}>;

function presentScopeNotice(activeBranch: string | null): string {
  return activeBranch === null
    ? "Isolated worktree — separate from the AG Loop terminal."
    : `Isolated worktree on branch "${activeBranch}" — separate from the AG Loop terminal.`;
}

function providerOptions(state: AppState): readonly TerminalProviderOption[] {
  // A session is bound to the provider it was created with, so the choice is
  // frozen for as long as one exists on the host.
  const enabled = state.terminalState === "none" || state.terminalState === "ended";
  return Object.freeze(selectableProviders.map((provider) => Object.freeze({
    provider,
    label: providerLabels[provider],
    selected: provider === state.selectedProvider,
    enabled,
  })));
}

function presentConnection(state: AppState, hasRows: boolean): TerminalConnectionViewState {
  const hasSession = state.terminalState !== "none";
  return Object.freeze({
    state: state.connection,
    // An explicit detach leaves the host session running; saying "not connected"
    // there would read as if the terminal had been lost.
    label: state.connection === "disconnected" && hasSession
      ? "Detached — the session keeps running"
      : connectionLabels[state.connection],
    showActivity: state.connection === "connecting" || state.connection === "reconnecting",
    reconnecting: state.connection === "reconnecting",
    stale: hasRows && hasSession && state.connection !== "live",
  });
}

function canStartSession(state: AppState): boolean {
  // The stream only exists once a session does, so a live stream cannot be a
  // precondition for starting one; an exhausted stream (`offline`) still is.
  return Boolean(state.selectedProjectId) &&
    state.selectedProvider !== null &&
    state.connection !== "offline" &&
    (state.terminalState === "none" || state.terminalState === "ended");
}

function lifecycleActions(state: AppState): readonly TerminalActionButton[] {
  const terminal = state.terminalState;
  return Object.freeze([
    Object.freeze({
      id: "start" as const,
      label: "Start session",
      enabled: canStartSession(state),
      destructive: false,
      hint: "Runs the agent in an isolated worktree.",
    }),
    Object.freeze({
      id: "interrupt" as const,
      label: "Interrupt",
      enabled: terminal === "live",
      destructive: false,
      hint: "Sends an interrupt to the running agent.",
    }),
    Object.freeze({
      id: "close" as const,
      label: "Close session",
      // `ended` and `closing` have nothing left to close; every other live
      // session state does, `failed` included — that is how it is cleaned up.
      enabled: terminal === "creating" || terminal === "live" ||
        terminal === "read-only" || terminal === "failed",
      destructive: true,
      hint: "Terminates the agent process on the host.",
    }),
    Object.freeze({
      id: "detach" as const,
      label: "Detach stream",
      enabled: state.connection === "connecting" || state.connection === "live" ||
        state.connection === "reconnecting",
      destructive: false,
      hint: "Stops streaming output; the session keeps running.",
    }),
  ]);
}

function visibleRows(lines: readonly string[]): readonly TerminalLineRow[] {
  const offset = Math.max(0, lines.length - terminalVisibleLineLimit);
  // The Model's buffer carries no absolute line numbers, so its index is the
  // only identity available: stable for as long as the buffer is not trimmed,
  // and unique within the window, which is what list virtualisation needs.
  return Object.freeze(lines.slice(offset).map((text, index) =>
    Object.freeze({ key: String(offset + index), text })));
}

/**
 * Why the session or the stream refuses input, independent of what is being
 * sent. The composer and the voice controls share it verbatim: they are blocked
 * by the same fact and must never word it differently.
 */
function sessionBlockedReason(state: AppState): string | null {
  switch (state.terminalState) {
    case "none":
    case "ended":
      return "Start a session to send input.";
    case "failed":
      return "The session failed. Close it and start a new one.";
    case "creating":
      return "The session is still starting.";
    case "closing":
      return "The session is closing.";
    case "read-only":
      return "Read-only: the writer lease is held by another device.";
    case "live":
      break;
  }
  // Input travels over HTTP, but sending blind into a stream that is not live
  // is how an operator repeats a command they never saw echoed.
  if (state.connection !== "live") return "Waiting for the terminal stream to reconnect.";
  return null;
}

function composerBlockedReason(state: AppState, draft: string): string | null {
  const session = sessionBlockedReason(state);
  if (session !== null) return session;
  if (draft.trim().length === 0) return "Type a command to send.";
  if (draft.length > terminalInputMaxLength) {
    return `Input is longer than ${terminalInputMaxLength} characters.`;
  }
  return null;
}

function voicePrivacy(state: AppState): TerminalVoicePrivacy {
  // What the transcript on screen actually was outranks what the next capture
  // would be: a badge above recognised text must describe that text.
  const mode = state.voiceMode ?? state.voiceBackendMode;
  const consentRequired = state.voiceBackendMode === "cloud";
  return Object.freeze({
    mode,
    onDevice: mode === "on-device",
    badge: mode === null ? "Unknown" : voicePrivacyBadges[mode],
    label: mode === null
      ? "The speech backend for this device is not known yet."
      : voicePrivacyLabels[mode],
    consentRequired,
    consentGranted: state.voiceCloudConsent,
    consentPrompt: consentRequired && !state.voiceCloudConsent
      ? "Allow cloud transcription on this device"
      : null,
  });
}

function voiceCaptureBlockedReason(state: AppState): string | null {
  // The session reason comes first: without a live session there is nothing to
  // dictate to, whatever the microphone could do.
  const session = sessionBlockedReason(state);
  if (session !== null) return session;
  if (state.voiceAvailability === "unavailable") {
    return state.voiceUnavailableReason === null
      ? voiceUnavailableLabels["unsupported"]
      : voiceUnavailableLabels[state.voiceUnavailableReason];
  }
  if (state.voiceAvailability === "unknown") return "Checking speech availability…";
  if (state.voiceCapture !== "idle" && state.voiceCapture !== "failed") {
    return "Finish or discard the current transcript.";
  }
  return null;
}

function voiceConfirmBlockedReason(
  state: AppState,
  lowConfidence: boolean,
  tooLong: boolean,
): string | null {
  if (!state.voiceConfirmationRequired) return "There is no transcript to send.";
  const session = sessionBlockedReason(state);
  if (session !== null) return session;
  if (state.voiceDraft.trim().length === 0) return "The transcript is empty.";
  if (tooLong) return `Input is longer than ${terminalInputMaxLength} characters.`;
  if (lowConfidence && !state.voiceLowConfidenceAcknowledged) {
    return "Confirm you have read the uncertain transcript.";
  }
  return null;
}

function presentVoice(state: AppState, canSubmit: boolean): TerminalVoiceViewState {
  const phase = state.voiceCapture;
  const draft = state.voiceDraft;
  const tooLong = draft.length > terminalInputMaxLength;
  // Only a transcript under review can be uncertain: a confidence left over from
  // a partial must not put a warning on an empty or already sent panel.
  const lowConfidence = isLowConfidence(state.voiceConfidence) && phase === "review";
  const acknowledged = state.voiceLowConfidenceAcknowledged;
  const acknowledgementRequired = lowConfidence && !acknowledged;
  const captureBlockedReason = voiceCaptureBlockedReason(state);
  const confirmBlockedReason = voiceConfirmBlockedReason(state, lowConfidence, tooLong);
  return Object.freeze({
    draft,
    partial: state.voicePartial,
    phase,
    listening: phase === "listening",
    busy: phase === "starting" || phase === "finalizing",
    statusLabel: voicePhaseLabels[phase],
    holdHint: "Hold to talk. Release to read the transcript before it is sent.",
    canCapture: state.voiceAvailability === "available" && canSubmit &&
      (phase === "idle" || phase === "failed"),
    captureBlockedReason,
    canDiscard: phase !== "idle",
    editable: phase === "review",
    edited: state.voiceDraftEdited,
    confidence: state.voiceConfidence,
    lowConfidence,
    acknowledged,
    acknowledgementRequired,
    acknowledgementLabel: "I have read this transcript",
    lowConfidenceWarning: acknowledgementRequired
      ? "The recogniser is unsure about this transcript. Read it before sending."
      : null,
    confirmationRequired: state.voiceConfirmationRequired,
    confirmationLabel: "Send this transcript to the agent?",
    canConfirm: state.voiceConfirmationRequired && canSubmit && draft.trim().length > 0 &&
      !tooLong && (!lowConfidence || acknowledged),
    confirmBlockedReason,
    characterCount: draft.length,
    maxLength: terminalInputMaxLength,
    tooLong,
    privacy: voicePrivacy(state),
    errorMessage: state.voiceError === null ? null : voiceFailureLabels[state.voiceError],
  });
}

function presentComposer(state: AppState, draft: string, canSubmit: boolean): TerminalComposerViewState {
  const blockedReason = composerBlockedReason(state, draft);
  return Object.freeze({
    draft,
    placeholder: canSubmit ? "Type a command for the agent" : "Input is unavailable",
    canSend: blockedReason === null,
    blockedReason,
    characterCount: draft.length,
    maxLength: terminalInputMaxLength,
    tooLong: draft.length > terminalInputMaxLength,
    editable: canSubmit,
  });
}

export function presentTerminal(
  state: AppState,
  input: TerminalPresentationInput = {},
): TerminalViewState {
  const draft = input.composerDraft ?? "";
  const activeBranch = input.activeBranch ?? null;
  const rows = visibleRows(state.terminalLines);
  const hiddenLineCount = state.terminalLines.length - rows.length;
  const canSubmit = state.connection === "live" && state.terminalState === "live";
  return Object.freeze({
    title: "Mobile Terminal",
    providerLabel: state.selectedProvider === null
      ? "No provider selected"
      : providerLabels[state.selectedProvider],
    scopeNotice: presentScopeNotice(activeBranch),
    activeBranch,
    providers: providerOptions(state),
    connection: presentConnection(state, rows.length > 0),
    sessionLabel: sessionLabels[state.terminalState],
    statusLabel: `${state.connection}:${state.terminalState}`,
    readOnly: state.terminalState === "read-only",
    canStart: canStartSession(state),
    canSubmit,
    actions: lifecycleActions(state),
    rows,
    hiddenLineCount,
    hiddenLineLabel: `${hiddenLineCount} earlier lines are outside the view`,
    historyTruncated: state.terminalHistoryTruncated,
    historyTruncatedLabel: "Earlier output was dropped by the host replay buffer.",
    isEmpty: rows.length === 0,
    emptyLabel: state.terminalState === "none"
      ? "Start a session to see agent output."
      : "Waiting for output…",
    composer: presentComposer(state, draft, canSubmit),
    voice: presentVoice(state, canSubmit),
    errorMessage: state.error,
  });
}
