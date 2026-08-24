import type {
  SessionAuditSeverity,
  SessionDiffLineKind,
  SessionReviewLinkState,
} from "../model/session-review-read.js";

/**
 * View state of the read-only Session review space. Types only — the projection
 * that fills them is `controller/presentation/session-review-presenter.ts`; see
 * `ag-loop-view-state.ts` for why the two are separate files here.
 */

/** Re-exported so a screen never has to name the Model to describe itself. */
export type {
  SessionAuditSeverity,
  SessionDiffLineKind,
  SessionReviewLinkState,
} from "../model/session-review-read.js";

export type SessionReviewConnectionViewState = Readonly<{
  link: SessionReviewLinkState;
  label: string;
  refreshing: boolean;
  /** The shown snapshot is cached and no longer confirmed by the host. */
  stale: boolean;
  errorMessage: string | null;
  canRetry: boolean;
}>;

export type SessionReviewFingerprintRow = Readonly<{
  label: string;
  value: string;
  /** The value is a hash or other fixed-width identifier. */
  mono: boolean;
}>;

export type SessionDiffLineRow = Readonly<{
  key: string;
  kind: SessionDiffLineKind;
  marker: "+" | "-" | " " | "";
  text: string;
  /** The line was longer than the render width and was cut here, not by the host. */
  clipped: boolean;
}>;

export type SessionDiffHunkRow = Readonly<{
  key: string;
  header: string;
  lines: readonly SessionDiffLineRow[];
}>;

export type SessionDiffFileRow = Readonly<{
  key: string;
  path: string;
  changeLabel: string;
  /** Set exactly when the file has no textual diff to show. */
  binaryLabel: string | null;
  hunks: readonly SessionDiffHunkRow[];
  hiddenHunkLabel: string | null;
}>;

export type SessionReviewDiffViewState = Readonly<{
  files: readonly SessionDiffFileRow[];
  summaryLabel: string;
  isEmpty: boolean;
  emptyLabel: string;
  truncated: boolean;
  /** Names both what is shown and the authoritative totals behind it. */
  truncationLabel: string | null;
  /** Worded as covering the full diff: it never describes the visible text. */
  digestLabel: string | null;
}>;

export type SessionGateRow = Readonly<{
  /** The host's own gate key; `label` is what the row shows. */
  name: string;
  label: string;
  statusLabel: string;
  passed: boolean;
  detailLabel: string | null;
}>;

export type SessionReviewGatesViewState = Readonly<{
  available: boolean;
  /** False whenever evidence is missing, stale or incomplete — never assumed. */
  passed: boolean;
  verdictLabel: string;
  stale: boolean;
  staleLabel: string | null;
  rows: readonly SessionGateRow[];
  /** Required gates with no recorded result at all. */
  missingGateNames: readonly string[];
  recordedAtLabel: string | null;
}>;

export type SessionAuditRow = Readonly<{
  key: string;
  severity: SessionAuditSeverity;
  severityLabel: string;
  locationLabel: string;
  message: string;
}>;

export type SessionReviewAuditViewState = Readonly<{
  available: boolean;
  statusLabel: string;
  stale: boolean;
  rows: readonly SessionAuditRow[];
  /** Findings the host capped away; `totalFindingCount` stays authoritative. */
  hiddenCount: number;
}>;

export type SessionReviewViewState = Readonly<{
  title: string;
  /** Structural, not a flag: this space exposes no merge, retry or edit path. */
  readOnly: true;
  connection: SessionReviewConnectionViewState;
  showLoadingPlaceholder: boolean;
  /** No review exists and none is being read: unselected, offline or unwired. */
  showUnavailablePlaceholder: boolean;
  unavailableLabel: string;
  sessionLabel: string;
  sessionStateLabel: string;
  fingerprint: readonly SessionReviewFingerprintRow[];
  targetCleanLabel: string;
  changedFiles: readonly string[];
  changedFileTotalCount: number;
  changedFileHiddenCount: number;
  diff: SessionReviewDiffViewState;
  gates: SessionReviewGatesViewState;
  audit: SessionReviewAuditViewState;
  observedAtLabel: string | null;
}>;
