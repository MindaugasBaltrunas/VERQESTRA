import {
  sessionDiffCaps,
  type SessionAuditSeverity,
  type SessionDiffFile,
  type SessionDiffLineKind,
  type SessionGateStatus,
  type SessionReviewFailureCode,
  type SessionReviewLinkState,
  type SessionReviewSnapshot,
} from "../../model/session-review-read.js";
import type { AppState } from "../../model/state.js";
import type {
  SessionDiffFileRow,
  SessionDiffLineRow,
  SessionReviewAuditViewState,
  SessionReviewConnectionViewState,
  SessionReviewDiffViewState,
  SessionReviewFingerprintRow,
  SessionReviewGatesViewState,
  SessionReviewViewState,
} from "../../view/session-review-view-state.js";

/**
 * Presentation for the read-only Session review space.
 *
 * Every decision the screen needs is taken here: which placeholder to show, how
 * a diff line is marked and clipped, what a truncated payload hides, and — most
 * importantly — how missing or stale evidence is worded. The screen slices and
 * parses nothing, so it can never soften a "no evidence" into a "passed".
 *
 * The view state carries no merge, retry or edit affordance, because the space
 * has none: the mobile client reads a session review and nothing else.
 */

const linkLabels: Readonly<Record<SessionReviewLinkState, string>> = Object.freeze({
  connecting: "Connecting",
  connected: "Connected",
  degraded: "Reconnecting — last known state",
  offline: "Offline",
});

const failureMessages: Readonly<Record<SessionReviewFailureCode, string>> = Object.freeze({
  not_found: "This session has no review record on the host.",
  unavailable: "The session review channel is not reachable.",
  unauthorized: "Device pairing is required.",
  invalid_response: "The session review response was rejected.",
  transport_failed: "The session review read failed.",
});

const changeLabels: Readonly<Record<SessionDiffFile["change"], string>> = Object.freeze({
  added: "Added",
  modified: "Modified",
  deleted: "Deleted",
  renamed: "Renamed",
});

/** The marker a diff line carries in the rendered gutter; `meta` lines carry none. */
const lineMarkers: Readonly<Record<SessionDiffLineKind, "+" | "-" | " " | "">> = Object.freeze({
  added: "+",
  removed: "-",
  context: " ",
  meta: "",
});

const gateStatusLabels: Readonly<Record<SessionGateStatus, string>> = Object.freeze({
  passed: "Passed",
  failed: "Failed",
  timed_out: "Timed out",
  errored: "Errored",
});

const severityLabels: Readonly<Record<SessionAuditSeverity, string>> = Object.freeze({
  info: "Info",
  warning: "Warning",
  error: "Error",
});

const emptyDiffLabel = "No changes: this session produced an empty diff.";

function countLabel(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function isReading(state: AppState): boolean {
  return state.sessionReviewReadsInFlight > 0;
}

function presentConnection(state: AppState): SessionReviewConnectionViewState {
  // Nothing has ever been attempted or answered, so an offline badge would blame
  // the network for a channel that was simply never wired up. A read in flight or
  // a recorded failure both mean the channel is configured.
  const unconfigured = state.sessionReview === null &&
    state.sessionReviewError === null &&
    state.sessionReviewReadsInFlight === 0 &&
    state.sessionReviewLink !== "connecting";
  return Object.freeze({
    link: state.sessionReviewLink,
    label: unconfigured ? "Not configured" : linkLabels[state.sessionReviewLink],
    refreshing: isReading(state),
    // Staleness is "a snapshot is on screen that the last read did not confirm".
    stale: state.sessionReview !== null && state.sessionReviewError !== null,
    errorMessage: state.sessionReviewError === null
      ? null
      : failureMessages[state.sessionReviewError],
    canRetry: !unconfigured && !isReading(state),
  });
}

function fingerprintRows(
  snapshot: SessionReviewSnapshot | null,
): readonly SessionReviewFingerprintRow[] {
  // Without a snapshot there is nothing to report; an invented row would look
  // like a fingerprint the host actually sent.
  if (snapshot === null) return Object.freeze([]);
  const git = snapshot.git;
  return Object.freeze([
    Object.freeze({ label: "Source branch", value: git.sourceBranch, mono: false }),
    Object.freeze({ label: "Source commit", value: git.sourceCommit, mono: true }),
    Object.freeze({ label: "Target branch", value: git.targetBranch, mono: false }),
    Object.freeze({ label: "Target head", value: git.targetHead, mono: true }),
  ]);
}

function diffLineRows(
  lines: readonly Readonly<{ kind: SessionDiffLineKind; text: string }>[],
  keyPrefix: string,
): readonly SessionDiffLineRow[] {
  return Object.freeze(lines.map((line, index) => {
    // The screen renders whatever it is handed, so the untruncated text must not
    // reach it: a single pathological line would otherwise stall the list.
    const clipped = line.text.length > sessionDiffCaps.maxDiffLineLength;
    return Object.freeze({
      key: `${keyPrefix}:${index}`,
      kind: line.kind,
      marker: lineMarkers[line.kind],
      text: clipped ? line.text.slice(0, sessionDiffCaps.maxDiffLineLength) : line.text,
      clipped,
    });
  }));
}

function diffFileRows(files: readonly SessionDiffFile[]): readonly SessionDiffFileRow[] {
  return Object.freeze(files.map((file, fileIndex) => Object.freeze({
    // Paths can repeat across a rename pair, so the position is the only identity
    // guaranteed to be unique within the rendered list.
    key: `${fileIndex}:${file.path}`,
    path: file.path,
    changeLabel: changeLabels[file.change],
    binaryLabel: file.binary ? "Binary file — no textual diff" : null,
    hunks: Object.freeze(file.hunks.map((hunk, hunkIndex) => Object.freeze({
      key: `${fileIndex}:${hunkIndex}`,
      header: hunk.header,
      lines: diffLineRows(hunk.lines, `${fileIndex}:${hunkIndex}`),
    }))),
    hiddenHunkLabel: file.hiddenHunkCount > 0
      ? `${countLabel(file.hiddenHunkCount, "hunk")} not shown`
      : null,
  })));
}

function shownChangedLines(files: readonly SessionDiffFileRow[]): number {
  return files.reduce((fileTotal, file) => fileTotal + file.hunks.reduce(
    (hunkTotal, hunk) => hunkTotal + hunk.lines.filter(
      (line) => line.kind === "added" || line.kind === "removed").length,
    0,
  ), 0);
}

function presentDiff(snapshot: SessionReviewSnapshot | null): SessionReviewDiffViewState {
  if (snapshot === null) {
    return Object.freeze({
      files: Object.freeze([]),
      summaryLabel: "No diff has been read yet.",
      // "Unknown" is not "empty": only a snapshot can prove a diff is empty.
      isEmpty: false,
      emptyLabel: emptyDiffLabel,
      truncated: false,
      truncationLabel: null,
      digestLabel: null,
    });
  }
  const diff = snapshot.diff;
  const files = diffFileRows(diff.files);
  const totalChangedLines = diff.addedLineCount + diff.removedLineCount;
  return Object.freeze({
    files,
    summaryLabel: `${countLabel(diff.totalFileCount, "file")} changed · ` +
      `+${diff.addedLineCount} / -${diff.removedLineCount}`,
    isEmpty: diff.totalFileCount === 0,
    emptyLabel: emptyDiffLabel,
    truncated: diff.truncated,
    truncationLabel: diff.truncated
      ? `Showing ${shownChangedLines(files)} of ${totalChangedLines} diff lines · ` +
        `${files.length} of ${diff.totalFileCount} files (capped by the host)`
      : null,
    // The digest covers the whole diff the host produced; presenting it as a
    // digest of the visible text would let a truncated payload look verified.
    digestLabel: `Full-diff digest ${diff.digest}`,
  });
}

function presentGates(snapshot: SessionReviewSnapshot | null): SessionReviewGatesViewState {
  if (snapshot === null || snapshot.gates === null) {
    // No trustworthy evidence is not a pass, and it is not a failure either: it
    // is the absence of proof, and it is worded as such.
    return Object.freeze({
      available: false,
      passed: false,
      verdictLabel: "No gate evidence recorded",
      stale: false,
      staleLabel: null,
      rows: Object.freeze([]),
      missingGateNames: Object.freeze([]),
      recordedAtLabel: null,
    });
  }
  const report = snapshot.gates;
  const stale = report.commit !== snapshot.git.sourceCommit;
  const missingGateNames = Object.freeze(report.requiredGateNames.filter(
    (name) => !report.gates.some((gate) => gate.name === name)));
  // The host's own verdict is necessary but not sufficient: evidence recorded for
  // another commit, or missing a required gate, proves nothing about this one.
  const passed = report.allRequiredPassed && !stale && missingGateNames.length === 0;
  return Object.freeze({
    available: true,
    passed,
    verdictLabel: passed ? "All required gates passed" : "Gates did not pass",
    stale,
    staleLabel: stale ? "Evidence was recorded for another commit." : null,
    rows: Object.freeze(report.gates.map((gate) => Object.freeze({
      name: gate.name,
      label: gate.name,
      statusLabel: gate.status === null
        ? (gate.passed ? "Passed" : "Failed")
        : gateStatusLabels[gate.status],
      passed: gate.passed,
      detailLabel: gate.durationMs === null ? null : `${gate.durationMs} ms`,
    }))),
    missingGateNames,
    recordedAtLabel: report.recordedAt,
  });
}

function presentAudit(snapshot: SessionReviewSnapshot | null): SessionReviewAuditViewState {
  if (snapshot === null || snapshot.audit === null) {
    // An audit that was never run is not a clean audit.
    return Object.freeze({
      available: false,
      statusLabel: "AG audit not run",
      stale: false,
      rows: Object.freeze([]),
      hiddenCount: 0,
    });
  }
  const audit = snapshot.audit;
  return Object.freeze({
    available: true,
    statusLabel: audit.status === "clean"
      ? "AG audit clean"
      : audit.status === "errored"
        ? "AG audit errored"
        : countLabel(audit.totalFindingCount, "finding"),
    stale: audit.commit !== snapshot.git.sourceCommit,
    rows: Object.freeze(audit.findings.map((finding, index) => Object.freeze({
      key: `${index}:${finding.rule}`,
      severity: finding.severity,
      severityLabel: severityLabels[finding.severity],
      locationLabel: finding.path ?? "Whole repository",
      message: finding.message,
    }))),
    hiddenCount: Math.max(0, audit.totalFindingCount - audit.findings.length),
  });
}

export function presentSessionReview(state: AppState): SessionReviewViewState {
  const snapshot = state.sessionReview;
  const showLoadingPlaceholder = snapshot === null && state.sessionReviewLink === "connecting";
  const paths = snapshot?.changedFiles.paths ?? Object.freeze([]);
  const changedFileTotalCount = snapshot?.changedFiles.totalCount ?? 0;
  return Object.freeze({
    title: "Session review — read-only",
    readOnly: true,
    connection: presentConnection(state),
    showLoadingPlaceholder,
    showUnavailablePlaceholder: snapshot === null && !showLoadingPlaceholder,
    unavailableLabel: state.sessionReviewSessionId === null
      ? "No session selected."
      : "No session review has been received yet.",
    sessionLabel: snapshot?.sessionId ?? state.sessionReviewSessionId ?? "No session selected",
    sessionStateLabel: snapshot === null
      ? "No session review"
      : snapshot.sessionEnded ? "Session ended" : "Session still running",
    fingerprint: fingerprintRows(snapshot),
    targetCleanLabel: snapshot === null
      ? "Target state unknown"
      : snapshot.git.targetClean
        ? "Target branch is clean"
        : "Target branch has uncommitted changes",
    changedFiles: paths,
    changedFileTotalCount,
    // The host's total outranks the carried list, so a capped list never reads
    // as if it were the whole change set.
    changedFileHiddenCount: Math.max(0, changedFileTotalCount - paths.length),
    diff: presentDiff(snapshot),
    gates: presentGates(snapshot),
    audit: presentAudit(snapshot),
    observedAtLabel: snapshot?.observedAt ?? null,
  });
}
