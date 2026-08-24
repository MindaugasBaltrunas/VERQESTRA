/**
 * The host side of the read-only session review DTO, mirrored by hand from the
 * mobile client's contract:
 *
 * ```text
 * mobile-app/src/model/session-review-read.ts
 * ```
 *
 * The direction of this system is one-way: the mobile app reaches the gateway
 * over HTTP and nothing else, so the gateway must not — and cannot — import the
 * app's model. Sharing the declaration would create a package edge pointing from
 * the host to the client, which is exactly the edge the two-package split
 * exists to forbid. The cost of mirroring is that this file changes only
 * together with that contract; a field added there without a change here would
 * simply never be projected.
 *
 * What is mirrored is the WIRE shape alone. The client-side link state, its read
 * port, its failure class and its defensive `clampSessionReviewSnapshot` are the
 * consumer's own concerns and have no meaning on the host.
 */

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

export type SessionDiffFileChange = "added" | "modified" | "deleted" | "renamed";

export type SessionDiffFile = Readonly<{
  path: string;
  change: SessionDiffFileChange;
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

/**
 * What the host is willing to PRODUCE. The first five bounds are the client's
 * own defensive caps, held identical on purpose: when both sides agree, the
 * client's clamp becomes a no-op that verifies rather than a second policy that
 * silently reshapes what the operator sees.
 *
 * The last three exist only here, because they answer a question the client
 * cannot: how much text one bounded diff may weigh. `maxHunkLinesTotal` bounds
 * the number of LINES, not bytes, and a repository is free to hold a minified
 * bundle or a base64 blob on a single line — two thousand of those exhaust a
 * phone's memory while every line cap is respected. `threat-model.md` requires
 * a bounded response, so the host bounds the bytes as well.
 *
 * None of the three touches `digest`: it is computed from the FULL diff before
 * any cap runs, so clipping the carried text can never make an approval compare
 * equal to a different change.
 */
export const SESSION_REVIEW_CAPS = Object.freeze({
  maxFiles: 50,
  maxHunkLinesPerFile: 200,
  maxHunkLinesTotal: 2_000,
  maxChangedFilePaths: 200,
  maxAuditFindings: 100,
  /**
   * Transport bound on ONE carried diff line. The client's own
   * `maxDiffLineLength: 500` is presentation — how wide a line is shown — and
   * stays the client's business; this is how much is ever sent.
   */
  maxDiffLineChars: 2_000,
  /** Total budget for carried diff text, in characters, across every hunk. */
  maxCarriedDiffChars: 262_144,
  maxAuditRuleChars: 120,
  maxAuditMessageChars: 500,
} as const);
