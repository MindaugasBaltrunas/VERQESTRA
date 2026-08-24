import type {
  AgLoopDashboardSnapshot,
  AgLoopReadFailureCode,
  AgLoopTaskBucket,
  AgLoopTaskBucketSnapshot,
} from "./ag-loop-read.js";
import type {
  ConnectionsReadFailureCode,
  HostConnectionsSnapshot,
} from "./connections-read.js";
import type {
  ProjectRepositoryStatus,
  ProjectsReadFailureCode,
  ProjectSummary,
} from "./projects-read.js";
import type {
  SessionReviewFailureCode,
  SessionReviewSnapshot,
} from "./session-review-read.js";
import type { AppState, ConnectionState, Provider, TerminalState } from "./state.js";
import type {
  SpeechTranscriptionMode,
  SpeechUnavailableReason,
  VoiceAvailability,
  VoiceCaptureFailureCode,
} from "./voice.js";

/**
 * Everything that can move the Model.
 *
 * SKAIDYMAS (VERQESTRA ≤500 eil. vartas; su nukrypimo antrašte `reducer.ts` buvo 502).
 * Ši sąjunga iškelta pagal projekto taisyklę „tipai keliauja į atskirą `-model` failą":
 * `reducer.ts` ją re-eksportuoja, tad nė vienam iš dvidešimties importuotojų kelias
 * nepasikeitė — pjūvis padarytas ties riba, kuri jau buvo (kas gali įvykti / ką tai keičia),
 * o ne per patį `switch`, kurio išsamumą tikrina tipų sistema.
 */
export type AppEvent =
  | Readonly<{ type: "connection.changed"; state: ConnectionState }>
  | Readonly<{ type: "project.selected"; projectId: string }>
  | Readonly<{ type: "provider.selected"; provider: Provider }>
  | Readonly<{ type: "ag-loop.availability"; availability: AppState["agLoopAvailability"] }>
  | Readonly<{ type: "ag-loop.read-started" }>
  | Readonly<{ type: "ag-loop.read-settled" }>
  | Readonly<{ type: "ag-loop.dashboard"; snapshot: AgLoopDashboardSnapshot }>
  | Readonly<{ type: "ag-loop.tasks"; snapshot: AgLoopTaskBucketSnapshot }>
  | Readonly<{ type: "ag-loop.bucket-selected"; bucket: AgLoopTaskBucket }>
  | Readonly<{ type: "ag-loop.read-failed"; failure: AgLoopReadFailureCode }>
  | Readonly<{ type: "session-review.selected"; sessionId: string }>
  | Readonly<{ type: "session-review.read-started" }>
  | Readonly<{ type: "session-review.read-settled" }>
  | Readonly<{ type: "session-review.snapshot"; snapshot: SessionReviewSnapshot }>
  | Readonly<{ type: "session-review.read-failed"; failure: SessionReviewFailureCode }>
  | Readonly<{ type: "connections.read-started" }>
  | Readonly<{ type: "connections.read-settled" }>
  | Readonly<{ type: "connections.snapshot"; snapshot: HostConnectionsSnapshot }>
  | Readonly<{ type: "connections.read-failed"; failure: ConnectionsReadFailureCode }>
  | Readonly<{
      type: "projects.read-started";
      /**
       * Which of the two project reads started; `list` when omitted. Only a
       * registry read speaks for the registry channel — see the reducer case.
       */
      scope?: "list" | "repository";
    }>
  | Readonly<{ type: "projects.read-settled" }>
  | Readonly<{ type: "projects.list"; projects: readonly ProjectSummary[] }>
  | Readonly<{ type: "projects.read-failed"; failure: ProjectsReadFailureCode }>
  | Readonly<{
      type: "projects.repository-status";
      projectId: string;
      status: ProjectRepositoryStatus;
    }>
  | Readonly<{
      type: "projects.repository-failed";
      projectId: string;
      failure: ProjectsReadFailureCode;
    }>
  | Readonly<{ type: "terminal.state"; state: TerminalState }>
  | Readonly<{ type: "terminal.output"; lines: readonly string[] }>
  | Readonly<{ type: "terminal.output-chunk"; data: string }>
  | Readonly<{ type: "terminal.history-truncated" }>
  | Readonly<{
      type: "voice.availability";
      availability: VoiceAvailability;
      mode: SpeechTranscriptionMode;
      reason: SpeechUnavailableReason | null;
      cloudConsent: boolean;
    }>
  | Readonly<{ type: "voice.cloud-consent"; granted: boolean }>
  | Readonly<{ type: "voice.capture-requested" }>
  | Readonly<{ type: "voice.capture-started"; mode: SpeechTranscriptionMode }>
  | Readonly<{ type: "voice.partial"; text: string; confidence: number | null }>
  | Readonly<{ type: "voice.capture-finalizing" }>
  | Readonly<{
      type: "voice.transcribed";
      text: string;
      mode: SpeechTranscriptionMode;
      confidence: number | null;
    }>
  | Readonly<{ type: "voice.draft-edited"; text: string }>
  | Readonly<{ type: "voice.low-confidence-acknowledged" }>
  | Readonly<{ type: "voice.capture-failed"; failure: VoiceCaptureFailureCode }>
  | Readonly<{ type: "voice.cancelled" }>
  | Readonly<{ type: "error"; message: string | null }>;
