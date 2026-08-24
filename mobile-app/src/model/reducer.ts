import type { AppEvent } from "./app-event.js";
import { clampAgentConnections } from "./connections-read.js";
import { clampProjectList, countDistinctProjects } from "./projects-read.js";
import { linkAfterReadFailed, linkAfterReadStarted } from "./read-channel.js";
import { clampSessionReviewSnapshot } from "./session-review-read.js";
import type { AppState } from "./state.js";
import { clampTranscript } from "./voice.js";
import type { SpeechUnavailableReason, VoiceCaptureFailureCode } from "./voice.js";

/**
 * Re-exported so the twenty modules that already import `AppEvent` from here keep
 * working: the union moved to `app-event.ts` for the 500-line gate, not because
 * anything about the event surface changed.
 */
export type { AppEvent } from "./app-event.js";

const maxTerminalLines = 2_000;

/**
 * Everything one capture attempt owns. Availability, the backend mode and the
 * stored consent are deliberately absent: those describe the device, not the
 * attempt, and must survive a cancelled or failed recording.
 */
const clearedCapture = Object.freeze({
  voicePartial: "",
  voiceDraft: "",
  voiceDraftEdited: false,
  voiceMode: null,
  voiceConfidence: null,
  voiceLowConfidenceAcknowledged: false,
  voiceConfirmationRequired: false,
  voiceError: null,
} satisfies Partial<AppState>);

/** Availability consequences of a failure; the rest only ends the attempt. */
const failureAvailability: Readonly<
  Partial<Record<VoiceCaptureFailureCode, SpeechUnavailableReason>>
> = Object.freeze({
  "unavailable": "unsupported",
  "permission-denied": "permission-denied",
  "consent-required": "consent-required",
});

export function reduceAppState(state: AppState, event: AppEvent): AppState {
  switch (event.type) {
    case "connection.changed":
      return Object.freeze({ ...state, connection: event.state });
    case "project.selected":
      // Re-selecting the open project is a no-op, as on every other selection
      // event: the Projects list hands the same id back whenever its open row is
      // tapped, and resetting under it would blank the repository pane the
      // operator is reading and drop the transcript of a still-running session —
      // leaving the terminal offering a second `start` for a live one.
      if (event.projectId === state.selectedProjectId) return state;
      // One project's repository state, session and transcript must never render
      // under another project's header, so they are dropped with the selection.
      return Object.freeze({
        ...state,
        selectedProjectId: event.projectId,
        projectRepository: null,
        projectRepositoryError: null,
        terminalState: "none",
        terminalLines: Object.freeze([]),
        terminalHistoryTruncated: false,
      });
    case "provider.selected":
      return Object.freeze({ ...state, selectedProvider: event.provider });
    case "ag-loop.availability":
      return Object.freeze({ ...state, agLoopAvailability: event.availability });
    case "ag-loop.read-started":
      // A refresh over a healthy link must not flash `connecting` back at the
      // user; only a link without a usable snapshot reports that it is dialling.
      // The previous failure stays visible until the retry actually settles.
      return Object.freeze({
        ...state,
        agLoopReadsInFlight: state.agLoopReadsInFlight + 1,
        agLoopLink: state.agLoopDashboard === null || state.agLoopLink === "offline"
          ? "connecting"
          : state.agLoopLink,
      });
    case "ag-loop.read-settled":
      // Never below zero: an unmatched settle must not make a later read look
      // permanently in flight.
      return Object.freeze({
        ...state,
        agLoopReadsInFlight: Math.max(0, state.agLoopReadsInFlight - 1),
      });
    case "ag-loop.dashboard":
      // The gateway snapshot is the single source of AG Loop availability: an
      // AG Loop UI that answers `offline` is offline, not merely degraded.
      return Object.freeze({
        ...state,
        agLoopDashboard: event.snapshot,
        agLoopAvailability: event.snapshot.availability,
        agLoopLink: event.snapshot.availability === "online" ? "connected" : "offline",
        agLoopReadError: null,
      });
    case "ag-loop.tasks":
      // The selected bucket is user intent and is never overwritten by a
      // response: a late snapshot for a bucket the user already left is dropped
      // here, so no rows can ever be shown under another bucket's label.
      if (event.snapshot.bucket !== state.agLoopSelectedBucket) return state;
      return Object.freeze({ ...state, agLoopTaskBucket: event.snapshot });
    case "ag-loop.bucket-selected":
      if (event.bucket === state.agLoopSelectedBucket) return state;
      // Dropping the previous rows keeps a bucket's contents from being shown
      // under another bucket's label while its own read is still in flight.
      return Object.freeze({
        ...state,
        agLoopSelectedBucket: event.bucket,
        agLoopTaskBucket: null,
      });
    case "ag-loop.read-failed": {
      // A failure may only keep or lower the reported link quality. An AG Loop
      // UI known to be offline — because it said so, or because the read failed
      // as `unavailable` — stays offline; `degraded` is reserved for a link that
      // merely lost its last read while AG Loop itself still looked healthy.
      const availability = event.failure === "unavailable" ? "offline" : state.agLoopAvailability;
      return Object.freeze({
        ...state,
        agLoopReadError: event.failure,
        agLoopLink: state.agLoopDashboard === null || availability === "offline" ? "offline" : "degraded",
        agLoopAvailability: availability,
      });
    }
    case "session-review.selected":
      if (event.sessionId === state.sessionReviewSessionId) return state;
      // One session's diff must never render under another session's header, so
      // the previous review and its failure are dropped with the selection.
      return Object.freeze({
        ...state,
        sessionReviewSessionId: event.sessionId,
        sessionReview: null,
        sessionReviewError: null,
      });
    case "session-review.read-started":
      // As on the AG Loop channel: a refresh over a healthy link must not flash
      // `connecting`, and the previous failure stays visible until the retry
      // actually settles.
      return Object.freeze({
        ...state,
        sessionReviewReadsInFlight: state.sessionReviewReadsInFlight + 1,
        sessionReviewLink: state.sessionReview === null || state.sessionReviewLink === "offline"
          ? "connecting"
          : state.sessionReviewLink,
      });
    case "session-review.read-settled":
      return Object.freeze({
        ...state,
        sessionReviewReadsInFlight: Math.max(0, state.sessionReviewReadsInFlight - 1),
      });
    case "session-review.snapshot":
      // A late answer for a session the user already left is dropped here, so no
      // diff can ever be shown under another session's identity.
      if (event.snapshot.sessionId !== state.sessionReviewSessionId) return state;
      return Object.freeze({
        ...state,
        sessionReview: clampSessionReviewSnapshot(event.snapshot),
        sessionReviewLink: "connected",
        sessionReviewError: null,
      });
    case "session-review.read-failed":
      // A failure may only keep or lower the reported link quality. Without a
      // usable snapshot, and for a host that has no such review or cannot be
      // reached at all, the channel is offline; `degraded` is reserved for a
      // link that merely lost its last read while a snapshot is still readable.
      return Object.freeze({
        ...state,
        sessionReviewError: event.failure,
        sessionReviewLink: state.sessionReview === null ||
          state.sessionReviewLink === "offline" ||
          event.failure === "unavailable" ||
          event.failure === "not_found"
          ? "offline"
          : "degraded",
      });
    case "connections.read-started":
      return Object.freeze({
        ...state,
        connectionsReadsInFlight: state.connectionsReadsInFlight + 1,
        connectionsLink: linkAfterReadStarted({
          current: state.connectionsLink,
          hasSnapshot: state.agentConnections !== null || state.githubConnection !== null,
        }),
      });
    case "connections.read-settled":
      // Never below zero: an unmatched settle must not make a later read look
      // permanently in flight.
      return Object.freeze({
        ...state,
        connectionsReadsInFlight: Math.max(0, state.connectionsReadsInFlight - 1),
      });
    case "connections.snapshot":
      // A host that answered without a provider surface reports `null`, and that
      // is written through: replacing it with the previous answer would keep a
      // provider state on screen that nothing confirms any more.
      return Object.freeze({
        ...state,
        agentConnections: event.snapshot.agents === null
          ? null
          : clampAgentConnections(event.snapshot.agents),
        githubConnection: event.snapshot.github,
        connectionsLink: "connected",
        connectionsError: null,
      });
    case "connections.read-failed":
      return Object.freeze({
        ...state,
        connectionsError: event.failure,
        connectionsLink: linkAfterReadFailed({
          current: state.connectionsLink,
          hasSnapshot: state.agentConnections !== null || state.githubConnection !== null,
          unreachable: event.failure === "unavailable",
        }),
      });
    case "projects.read-started":
      return Object.freeze({
        ...state,
        projectsReadsInFlight: state.projectsReadsInFlight + 1,
        // Only a registry read may move the registry link. A repository read
        // resolves into the repository pane and never dispatches a list result
        // or a channel failure, so letting it dial the channel would leave the
        // badge — and the list placeholder that follows it — reporting
        // `connecting` for good after the read settled.
        projectsLink: event.scope === "repository"
          ? state.projectsLink
          : linkAfterReadStarted({
            current: state.projectsLink,
            hasSnapshot: state.projects !== null,
          }),
      });
    case "projects.read-settled":
      return Object.freeze({
        ...state,
        projectsReadsInFlight: Math.max(0, state.projectsReadsInFlight - 1),
      });
    case "projects.list":
      return Object.freeze({
        ...state,
        projects: clampProjectList(event.projects),
        projectsTotalCount: countDistinctProjects(event.projects),
        projectsLink: "connected",
        projectsError: null,
      });
    case "projects.read-failed":
      return Object.freeze({
        ...state,
        projectsError: event.failure,
        projectsLink: linkAfterReadFailed({
          current: state.projectsLink,
          hasSnapshot: state.projects !== null,
          unreachable: event.failure === "unavailable",
        }),
      });
    case "projects.repository-status":
      // A late answer for a project the operator already left is dropped here,
      // so no branch can ever be shown under another project's identity.
      if (event.projectId !== state.selectedProjectId) return state;
      return Object.freeze({
        ...state,
        projectRepository: event.status,
        projectRepositoryError: null,
      });
    case "projects.repository-failed": {
      if (event.projectId !== state.selectedProjectId) return state;
      // Two different failures: one says the binding is gone, the other says
      // this read did not reach it. Only the first may erase a branch the host
      // did report; the second leaves it on screen, marked stale by presentation.
      const disproved = event.failure === "not_found" || event.failure === "repository_not_bound";
      return Object.freeze({
        ...state,
        projectRepository: disproved ? null : state.projectRepository,
        projectRepositoryError: event.failure,
      });
    }
    case "terminal.state":
      return Object.freeze({ ...state, terminalState: event.state });
    case "terminal.output":
      return Object.freeze({
        ...state,
        terminalLines: Object.freeze([...state.terminalLines, ...event.lines].slice(-maxTerminalLines)),
      });
    case "terminal.output-chunk": {
      if (event.data.length === 0) return state;
      const normalized = event.data.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      const chunks = normalized.split("\n");
      const lines = [...state.terminalLines];
      const first = chunks.shift() ?? "";
      // NUKRYPIMAS (forma, ne elgesys): etalonas šakojosi pagal `lines.length === 0`, o paskui
      // skaitė `lines[lines.length - 1]` template'e — su `noUncheckedIndexedAccess` į buferį
      // nutekėtų „undefined…". Tuščias masyvas ir yra vienintelis atvejis, kai to indekso nėra,
      // tad sąlyga imama iš paties indekso: šakos tos pačios, invariantą tikrina tipų sistema.
      const lastIndex = lines.length - 1;
      const last = lines[lastIndex];
      if (last === undefined) {
        lines.push(first);
      } else {
        lines[lastIndex] = `${last}${first}`;
      }
      lines.push(...chunks);
      return Object.freeze({
        ...state,
        terminalLines: Object.freeze(lines.slice(-maxTerminalLines)),
      });
    }
    case "terminal.history-truncated":
      return Object.freeze({ ...state, terminalHistoryTruncated: true });
    case "voice.availability":
      // Device facts only: a probe that lands while a transcript is being
      // reviewed must not disturb the transcript or the capture in progress.
      return Object.freeze({
        ...state,
        voiceAvailability: event.availability,
        voiceBackendMode: event.mode,
        voiceCloudConsent: event.cloudConsent,
        voiceUnavailableReason: event.availability === "unavailable" ? event.reason : null,
      });
    case "voice.cloud-consent": {
      // Consent is the only thing this event knows, but on a cloud-only device it
      // is also what makes speech usable at all, so the two are kept in step here
      // rather than waiting for the next probe to contradict the screen.
      const blockedByConsent = !event.granted && state.voiceBackendMode === "cloud";
      const unblocked = event.granted && state.voiceUnavailableReason === "consent-required";
      return Object.freeze({
        ...state,
        voiceCloudConsent: event.granted,
        voiceAvailability: blockedByConsent
          ? "unavailable"
          : unblocked
            ? "available"
            : state.voiceAvailability,
        voiceUnavailableReason: blockedByConsent
          ? "consent-required"
          : unblocked
            ? null
            : state.voiceUnavailableReason,
      });
    }
    case "voice.capture-requested":
      // Unconditional: a new hold always starts from an empty transcript, so no
      // part of a previous recording can be sent under a new one's confirmation.
      return Object.freeze({ ...state, ...clearedCapture, voiceCapture: "starting" });
    case "voice.capture-started":
      // A start that answers a hold nobody is waiting for — a cancelled one, or a
      // late one — must not put the screen back into recording.
      if (state.voiceCapture !== "starting") return state;
      return Object.freeze({ ...state, voiceCapture: "listening", voiceBackendMode: event.mode });
    case "voice.partial":
      if (state.voiceCapture !== "listening") return state;
      // Partials are shown, never drafted: `voiceDraft` and the confirmation flag
      // stay untouched, so nothing the recogniser is still guessing at can be sent.
      return Object.freeze({
        ...state,
        voicePartial: clampTranscript(event.text),
        voiceConfidence: event.confidence,
      });
    case "voice.capture-finalizing":
      if (state.voiceCapture !== "listening") return state;
      return Object.freeze({ ...state, voiceCapture: "finalizing" });
    case "voice.transcribed": {
      // A final that arrives after the capture was cancelled or already failed is
      // dropped: a late result must never resurrect the review panel.
      if (state.voiceCapture !== "finalizing" && state.voiceCapture !== "listening") return state;
      const text = clampTranscript(event.text);
      const hasText = text.trim().length > 0;
      return Object.freeze({
        ...state,
        voicePartial: "",
        voiceMode: event.mode,
        voiceConfidence: event.confidence,
        voiceDraftEdited: false,
        voiceLowConfidenceAcknowledged: false,
        voiceDraft: hasText ? text : "",
        voiceCapture: hasText ? "review" : "failed",
        voiceConfirmationRequired: hasText,
        voiceError: hasText ? null : "no-speech",
      });
    }
    case "voice.draft-edited": {
      if (state.voiceCapture !== "review") return state;
      const voiceDraft = clampTranscript(event.text);
      return Object.freeze({
        ...state,
        voiceDraft,
        voiceDraftEdited: true,
        // Editing the transcript *is* the second, non-voice look the uncertain
        // transcript asks for; demanding a separate tick after it would be noise.
        voiceLowConfidenceAcknowledged: true,
        voiceConfirmationRequired: voiceDraft.trim().length > 0,
      });
    }
    case "voice.low-confidence-acknowledged":
      if (state.voiceCapture !== "review") return state;
      return Object.freeze({ ...state, voiceLowConfidenceAcknowledged: true });
    case "voice.capture-failed": {
      const unavailableReason = failureAvailability[event.failure];
      return Object.freeze({
        ...state,
        ...clearedCapture,
        voiceCapture: "failed",
        voiceError: event.failure,
        // Only failures that describe the device change what the device can do:
        // silence, a cancel or a recogniser fault say nothing about availability.
        voiceAvailability: unavailableReason === undefined ? state.voiceAvailability : "unavailable",
        voiceUnavailableReason: unavailableReason ?? state.voiceUnavailableReason,
      });
    }
    case "voice.cancelled":
      // One event for two endings — a transcript that was sent and one that was
      // discarded — because the Model's job is identical in both: leave no
      // transcript behind. What the device can do is untouched, so the operator
      // can hold the button again immediately.
      return Object.freeze({ ...state, ...clearedCapture, voiceCapture: "idle" });
    case "error":
      return Object.freeze({ ...state, error: event.message });
  }
}
