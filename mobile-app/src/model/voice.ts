/**
 * Push-to-talk vocabulary shared by the Model, the presenter and the speech
 * adapter. It is deliberately a leaf module — it imports nothing at all — so the
 * words in which the privacy and confirmation story is told cannot drift between
 * the layers that tell it.
 */

/** Where the words were turned into text; the operator is always told which. */
export type SpeechTranscriptionMode = "on-device" | "cloud";

export type SpeechUnavailableReason =
  | "unsupported"
  | "permission-denied"
  | "consent-required"
  | "offline-model-missing";

/** `unknown` until the device has actually been probed; never assumed available. */
export type VoiceAvailability = "unknown" | "available" | "unavailable";

export type VoiceCaptureState =
  | "idle"
  | "starting"
  | "listening"
  | "finalizing"
  | "review"
  | "failed";

export type VoiceCaptureFailureCode =
  | "unavailable"
  | "permission-denied"
  | "consent-required"
  | "no-speech"
  | "aborted"
  | "recognizer-failed";

/**
 * Longest transcript the Model keeps. Identical to the terminal input bound, so
 * a transcript can never grow into something the composer and the controller
 * would both refuse only after the operator confirmed it.
 */
export const voiceTranscriptMaxLength = 16_384;

/** Below this the transcript is treated as uncertain and needs a second look. */
export const voiceLowConfidenceThreshold = 0.7;

/**
 * Fail closed: a recogniser that reports no confidence — or a value that is not
 * a number at all — has not told us the transcript is good, so it is treated
 * exactly like one it is unsure about.
 */
export function isLowConfidence(confidence: number | null): boolean {
  if (confidence === null || !Number.isFinite(confidence)) return true;
  return confidence < voiceLowConfidenceThreshold;
}

/** Truncates rather than rejects: a long transcript stays editable and visible. */
export function clampTranscript(text: string): string {
  return text.length > voiceTranscriptMaxLength ? text.slice(0, voiceTranscriptMaxLength) : text;
}
