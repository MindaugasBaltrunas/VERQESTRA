import type {
  AgLoopAvailability,
  AgLoopDashboardSnapshot,
  AgLoopLinkState,
  AgLoopReadFailureCode,
  AgLoopTaskBucket,
  AgLoopTaskBucketSnapshot,
} from "./ag-loop-read.js";
import type {
  AgentConnection,
  ConnectionsReadFailureCode,
  GitHubConnection,
} from "./connections-read.js";
import type {
  ProjectRepositoryStatus,
  ProjectsReadFailureCode,
  ProjectSummary,
} from "./projects-read.js";
import type { ReadChannelLinkState } from "./read-channel.js";
import type {
  SessionReviewFailureCode,
  SessionReviewLinkState,
  SessionReviewSnapshot,
} from "./session-review-read.js";
import type {
  SpeechTranscriptionMode,
  SpeechUnavailableReason,
  VoiceAvailability,
  VoiceCaptureFailureCode,
  VoiceCaptureState,
} from "./voice.js";

export type ConnectionState = "disconnected" | "connecting" | "live" | "reconnecting" | "offline";
export type Provider = "claude-code" | "codex";
export type TerminalState = "none" | "creating" | "live" | "read-only" | "closing" | "ended" | "failed";

export type AppState = Readonly<{
  connection: ConnectionState;
  selectedProjectId: string | null;
  selectedProvider: Provider | null;
  /** Last known AG Loop UI availability; `not-configured` until the first read. */
  agLoopAvailability: AgLoopAvailability | "not-configured";
  /** Read-only AG Loop channel state; independent of the mobile terminal stream. */
  agLoopLink: AgLoopLinkState;
  /**
   * Number of outstanding AG Loop reads. A counter, not a flag: a dashboard
   * refresh and a bucket selection can overlap, and the first one to settle
   * must not declare the channel idle while the other is still in flight.
   */
  agLoopReadsInFlight: number;
  agLoopDashboard: AgLoopDashboardSnapshot | null;
  agLoopTaskBucket: AgLoopTaskBucketSnapshot | null;
  agLoopSelectedBucket: AgLoopTaskBucket;
  /** Failure code only: the user-facing wording belongs to presentation. */
  agLoopReadError: AgLoopReadFailureCode | null;
  /**
   * Link and failure of the Tasks screen's own bucket channel, tracked apart
   * from `agLoopLink`/`agLoopReadError` above: a dashboard read and a bucket
   * read can succeed or fail independently, and neither screen's badge may
   * speak for a channel its own snapshot did not come from.
   */
  agLoopTasksLink: AgLoopLinkState;
  agLoopTasksReadError: AgLoopReadFailureCode | null;
  /** Session under review; user intent, never overwritten by a response. */
  sessionReviewSessionId: string | null;
  /** Read-only session review channel, independent of the AG Loop channel. */
  sessionReviewLink: SessionReviewLinkState;
  /** Outstanding session review reads. A counter, not a flag, for the same
   * reason as `agLoopReadsInFlight`: an auto-load and a manual refresh overlap. */
  sessionReviewReadsInFlight: number;
  sessionReview: SessionReviewSnapshot | null;
  /** Failure code only: the user-facing wording belongs to presentation. */
  sessionReviewError: SessionReviewFailureCode | null;
  /** Read-only host connections channel, independent of every other channel. */
  connectionsLink: ReadChannelLinkState;
  /** Outstanding connection reads; a counter for the same reason as the AG Loop one. */
  connectionsReadsInFlight: number;
  /** `null` until the host answered: an empty list would claim it reported none. */
  agentConnections: readonly AgentConnection[] | null;
  githubConnection: GitHubConnection | null;
  /** Failure code only: the user-facing wording belongs to presentation. */
  connectionsError: ConnectionsReadFailureCode | null;
  /** Read-only project directory channel, independent of every other channel. */
  projectsLink: ReadChannelLinkState;
  projectsReadsInFlight: number;
  /** `null` until the host answered; `[]` means the registry really is empty. */
  projects: readonly ProjectSummary[] | null;
  /**
   * Distinct projects the host named, which outranks the carried list: the list
   * is capped defensively and must never read as the whole registry.
   */
  projectsTotalCount: number;
  projectsError: ProjectsReadFailureCode | null;
  /** Repository binding of `selectedProjectId`; dropped whenever it changes. */
  projectRepository: ProjectRepositoryStatus | null;
  /** Why the selected project's repository state is missing; a pane state, not a link state. */
  projectRepositoryError: ProjectsReadFailureCode | null;
  terminalState: TerminalState;
  terminalLines: readonly string[];
  terminalHistoryTruncated: boolean;
  /** Where the current press-and-hold capture stands; `idle` between captures. */
  voiceCapture: VoiceCaptureState;
  /** `unknown` until a probe answered: speech is never assumed to work. */
  voiceAvailability: VoiceAvailability;
  /** Why speech is unavailable; non-null only while `voiceAvailability` says so. */
  voiceUnavailableReason: SpeechUnavailableReason | null;
  /**
   * Backend the *next* capture would use — the privacy badge shown before and
   * during recording. Deliberately separate from `voiceMode`, which states how
   * the transcript already on screen was produced: the device can change its
   * mind between two captures, and neither claim may be told in the other's name.
   */
  voiceBackendMode: SpeechTranscriptionMode | null;
  /** Operator consent to cloud transcription, as last read from the keystore. */
  voiceCloudConsent: boolean;
  /** Live, unconfirmed recogniser text. Never a transcript, never sendable. */
  voicePartial: string;
  voiceDraft: string;
  /** The operator edited the transcript, so it is no longer purely recognised. */
  voiceDraftEdited: boolean;
  /** How the transcript on screen was produced; `null` when there is none. */
  voiceMode: SpeechTranscriptionMode | null;
  voiceConfidence: number | null;
  /** The operator took a second, non-voice look at an uncertain transcript. */
  voiceLowConfidenceAcknowledged: boolean;
  voiceConfirmationRequired: boolean;
  /** Failure code only: the user-facing wording belongs to presentation. */
  voiceError: VoiceCaptureFailureCode | null;
  error: string | null;
}>;

export const initialAppState: AppState = Object.freeze({
  connection: "disconnected",
  selectedProjectId: null,
  selectedProvider: null,
  agLoopAvailability: "not-configured",
  agLoopLink: "offline",
  agLoopReadsInFlight: 0,
  agLoopDashboard: null,
  agLoopTaskBucket: null,
  agLoopSelectedBucket: "queue",
  agLoopReadError: null,
  agLoopTasksLink: "offline",
  agLoopTasksReadError: null,
  sessionReviewSessionId: null,
  sessionReviewLink: "offline",
  sessionReviewReadsInFlight: 0,
  sessionReview: null,
  sessionReviewError: null,
  connectionsLink: "offline",
  connectionsReadsInFlight: 0,
  agentConnections: null,
  githubConnection: null,
  connectionsError: null,
  projectsLink: "offline",
  projectsReadsInFlight: 0,
  projects: null,
  projectsTotalCount: 0,
  projectsError: null,
  projectRepository: null,
  projectRepositoryError: null,
  terminalState: "none",
  terminalLines: Object.freeze([]),
  terminalHistoryTruncated: false,
  voiceCapture: "idle",
  voiceAvailability: "unknown",
  voiceUnavailableReason: null,
  voiceBackendMode: null,
  voiceCloudConsent: false,
  voicePartial: "",
  voiceDraft: "",
  voiceDraftEdited: false,
  voiceMode: null,
  voiceConfidence: null,
  voiceLowConfidenceAcknowledged: false,
  voiceConfirmationRequired: false,
  voiceError: null,
  error: null,
});
