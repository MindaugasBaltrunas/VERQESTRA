/**
 * Read-only session review contract: git fingerprint, changed files, diff,
 * gate evidence and the optional AG audit of one agent session.
 *
 * The mobile client never inspects a repository itself: the host projects its
 * own integration preview into the reduced DTO declared here, field for field,
 * so the gateway stays a projection and never becomes a translation. What the
 * host also knows and this contract deliberately excludes — the integration id
 * and its expiry, the repository root, the isolated worktree path and every
 * token — is not needed to read a diff, and each of them would widen what a
 * lost device exposes.
 *
 * The port is read-only by construction: it declares no mutating method, so no
 * mobile caller can reach a merge, retry or edit path through this contract.
 */

/**
 * State of the read-only session review channel, kept separate from both the
 * AG Loop UI channel and the mobile terminal stream:
 *
 * - `connecting`   — a read is in flight and no snapshot has been accepted yet;
 * - `connected`    — the last read succeeded;
 * - `degraded`     — the last read failed while a usable snapshot is still on
 *                    screen, read-only and stale;
 * - `offline`      — no snapshot exists, or the host is not reachable at all.
 *
 * A failed read may only keep or lower the reported quality: a channel already
 * known to be offline never looks better because a retry failed as well.
 */
export type SessionReviewLinkState = "connecting" | "connected" | "degraded" | "offline";

export type SessionGitFingerprint = Readonly<{
  sourceBranch: string;
  /** Full 40-hex session HEAD; every piece of evidence is bound to it. */
  sourceCommit: string;
  targetBranch: string;
  targetHead: string;
  targetClean: boolean;
}>;

export type SessionChangedFiles = Readonly<{
  /** Repository-relative paths, capped by the host; `totalCount` stays authoritative. */
  paths: readonly string[];
  totalCount: number;
}>;

export type SessionDiffLineKind = "added" | "removed" | "context" | "meta";

/** Diff line text without its leading `+`/`-`/space marker; the marker is presentation. */
export type SessionDiffLine = Readonly<{ kind: SessionDiffLineKind; text: string }>;

export type SessionDiffHunk = Readonly<{ header: string; lines: readonly SessionDiffLine[] }>;

export type SessionDiffFile = Readonly<{
  path: string;
  change: "added" | "modified" | "deleted" | "renamed";
  /** A binary file carries no textual hunks; empty hunks are not "no change". */
  binary: boolean;
  hunks: readonly SessionDiffHunk[];
  hiddenHunkCount: number;
}>;

export type SessionDiffTruncationReason = "file_limit" | "line_limit" | "byte_limit";

export type SessionDiff = Readonly<{
  files: readonly SessionDiffFile[];
  /** Counters describe the FULL diff and are never reduced by capping. */
  totalFileCount: number;
  addedLineCount: number;
  removedLineCount: number;
  truncated: boolean;
  truncationReason: SessionDiffTruncationReason | null;
  /** `sha256:<hex>` of the FULL diff, never of the capped payload. */
  digest: string;
}>;

export type SessionGateStatus = "passed" | "failed" | "timed_out" | "errored";

export type SessionGateResult = Readonly<{
  name: string;
  passed: boolean;
  status: SessionGateStatus | null;
  durationMs: number | null;
}>;

/**
 * Gate evidence recorded by the host. A report whose `commit` differs from the
 * session HEAD describes other work and proves nothing about this one; a `null`
 * report means no trustworthy evidence exists and reads as "gates did not pass".
 */
export type SessionGateReport = Readonly<{
  commit: string;
  gates: readonly SessionGateResult[];
  recordedAt: string;
  allRequiredPassed: boolean;
  requiredGateNames: readonly string[];
  digest: string;
}>;

export type SessionAuditSeverity = "info" | "warning" | "error";

export type SessionAuditFinding = Readonly<{
  severity: SessionAuditSeverity;
  rule: string;
  path: string | null;
  message: string;
}>;

export type SessionAuditReport = Readonly<{
  status: "clean" | "findings" | "errored";
  findings: readonly SessionAuditFinding[];
  /** Authoritative even when the listed findings were capped. */
  totalFindingCount: number;
  ranAt: string;
  commit: string;
}>;

export type SessionReviewSnapshot = Readonly<{
  sessionId: string;
  sessionEnded: boolean;
  git: SessionGitFingerprint;
  changedFiles: SessionChangedFiles;
  diff: SessionDiff;
  /** `null` means no trustworthy gate evidence — never "passed". */
  gates: SessionGateReport | null;
  /** `null` means the optional AG audit was not run — never "clean". */
  audit: SessionAuditReport | null;
  observedAt: string;
}>;

export type SessionReviewFailureCode =
  | "not_found"
  | "unavailable"
  | "unauthorized"
  | "invalid_response"
  | "transport_failed";

/** Failure contract of {@link SessionReviewReadPort}; adapters map their own errors onto it. */
export class SessionReviewReadError extends Error {
  constructor(readonly code: SessionReviewFailureCode, message: string) {
    super(message);
    this.name = "SessionReviewReadError";
  }
}

/** Read-only by construction: no mutating method, so no caller can reach merge/retry/edit. */
export interface SessionReviewReadPort {
  readSessionReview(input: Readonly<{
    projectId: string;
    sessionId: string;
  }>): Promise<SessionReviewSnapshot>;
}

/**
 * Defensive bounds on an accepted review payload, in the same spirit as the
 * terminal buffer limit: the host caps its own projection, and a host that does
 * not — because it is old, buggy or hostile — must still not be able to grow
 * mobile memory without bound.
 */
export const sessionDiffCaps = Object.freeze({
  maxFiles: 50,
  maxHunkLinesPerFile: 200,
  maxHunkLinesTotal: 2_000,
  maxChangedFilePaths: 200,
  maxAuditFindings: 100,
  /** Presentation-only: the width beyond which a single diff line is clipped. */
  maxDiffLineLength: 500,
} as const);

type ClampedFile = Readonly<{ file: SessionDiffFile; clipped: boolean; used: number }>;

/**
 * Applies {@link sessionDiffCaps} to one file, spending at most `totalRemaining`
 * lines of the shared budget. Hunks that get no budget at all are dropped and
 * counted in `hiddenHunkCount`; a hunk that gets part of its budget stays
 * visible with its remaining lines cut off.
 */
function clampDiffFile(file: SessionDiffFile, totalRemaining: number): ClampedFile {
  let fileRemaining = sessionDiffCaps.maxHunkLinesPerFile;
  let remaining = totalRemaining;
  let hiddenHunks = 0;
  let clipped = false;
  const hunks: SessionDiffHunk[] = [];

  for (const hunk of file.hunks) {
    const allowance = Math.min(fileRemaining, remaining);
    if (allowance <= 0) {
      hiddenHunks += 1;
      clipped = true;
      continue;
    }
    const kept = Math.min(hunk.lines.length, allowance);
    hunks.push(kept === hunk.lines.length
      ? hunk
      : Object.freeze({ header: hunk.header, lines: Object.freeze(hunk.lines.slice(0, kept)) }));
    clipped = clipped || kept < hunk.lines.length;
    fileRemaining -= kept;
    remaining -= kept;
  }

  return Object.freeze({
    file: clipped
      ? Object.freeze({
        ...file,
        hunks: Object.freeze(hunks),
        hiddenHunkCount: file.hiddenHunkCount + hiddenHunks,
      })
      : file,
    clipped,
    used: totalRemaining - remaining,
  });
}

/**
 * Pure, defensive bound on an accepted snapshot. It only ever removes payload:
 * no counter (`totalFileCount`, `addedLineCount`, `removedLineCount`,
 * `changedFiles.totalCount`, `totalFindingCount`) and no `digest` is touched, so
 * what the screen reports as the authoritative size of the work stays the host's
 * own number even when far less of it is carried.
 */
export function clampSessionReviewSnapshot(snapshot: SessionReviewSnapshot): SessionReviewSnapshot {
  const keptFiles = snapshot.diff.files.slice(0, sessionDiffCaps.maxFiles);
  const filesDropped = keptFiles.length < snapshot.diff.files.length;
  let remaining = sessionDiffCaps.maxHunkLinesTotal;
  let linesDropped = false;
  const files = keptFiles.map((file) => {
    const clamped = clampDiffFile(file, remaining);
    remaining -= clamped.used;
    linesDropped = linesDropped || clamped.clipped;
    return clamped.file;
  });

  // `truncated` describes the diff itself. A host that already reported the
  // truncation keeps its own, more precise reason: it knows why it stopped
  // producing the diff, while this function only knows why it stopped carrying it.
  const reason: SessionDiffTruncationReason = snapshot.diff.truncated &&
    snapshot.diff.truncationReason !== null
    ? snapshot.diff.truncationReason
    : filesDropped ? "file_limit" : "line_limit";
  const diff = filesDropped || linesDropped
    ? Object.freeze({
      ...snapshot.diff,
      files: Object.freeze(files),
      truncated: true,
      truncationReason: reason,
    })
    : snapshot.diff;

  const paths = snapshot.changedFiles.paths.length > sessionDiffCaps.maxChangedFilePaths
    ? Object.freeze(snapshot.changedFiles.paths.slice(0, sessionDiffCaps.maxChangedFilePaths))
    : snapshot.changedFiles.paths;
  const changedFiles = paths === snapshot.changedFiles.paths
    ? snapshot.changedFiles
    : Object.freeze({ ...snapshot.changedFiles, paths });

  const audit = snapshot.audit !== null &&
    snapshot.audit.findings.length > sessionDiffCaps.maxAuditFindings
    ? Object.freeze({
      ...snapshot.audit,
      findings: Object.freeze(snapshot.audit.findings.slice(0, sessionDiffCaps.maxAuditFindings)),
    })
    : snapshot.audit;

  if (diff === snapshot.diff && changedFiles === snapshot.changedFiles && audit === snapshot.audit) {
    return snapshot;
  }
  return Object.freeze({ ...snapshot, changedFiles, diff, audit });
}
