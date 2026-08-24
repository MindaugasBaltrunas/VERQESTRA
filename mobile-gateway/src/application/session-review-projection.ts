import { redactSensitiveText } from "./ag-loop-read-redaction.js";
import { isCommitOid, isSafeBranchName } from "./git-ref-shapes.js";
import { diffDigestOf, gateDigestOf, gatesPassedOf } from "./local-integration-digests.js";
import { assertRepositoryRelativePath } from "./repository-relative-path.js";
import { REQUIRED_GATE_NAMES } from "./session-gate-policy.js";
import { capDiffFiles, parseUnifiedDiff } from "./session-review-diff-parse.js";
import { decodePathToken, refuse } from "./session-review-diff-text.js";
import {
  SESSION_REVIEW_CAPS,
  type SessionAuditFinding,
  type SessionAuditSeverity,
  type SessionDiff,
  type SessionDiffTruncationReason,
  type SessionGateResult,
  type SessionReviewSnapshot,
} from "./session-review-contract.js";
import type { SessionGateEvidence } from "./ports/session-gate-evidence-port.js";

/**
 * The read-only session review projection: observed facts in, one bounded
 * {@link SessionReviewSnapshot} out.
 *
 * **It is a pure function rather than a service with ports, on purpose.** The
 * obvious implementation would have called `LocalIntegrationService.preview()`,
 * which already reads every Git fact this snapshot shows — but that call has
 * side effects a read must never have: it consumes one of a bounded number of
 * preview slots, and it records `review_ready` on the worktree through a
 * registry transition. A phone polling a screen would then be able to exhaust
 * the operator's approval slots and move worktree state without asking for
 * anything. This module holds no port, opens no file and runs no command, so
 * "a review read cannot mutate the host" is a property of its shape.
 *
 * **The redaction here is a type, not a filter.** {@link SessionReviewFacts}
 * structurally has no `repositoryRoot`, no worktree path, no token, no
 * `integrationId` and no `expiresAt` — the fields the mobile contract
 * deliberately excludes are ones this function is never handed, so it cannot
 * forward them by mistake.
 *
 * **What it does carry is repository content, verbatim.** `SessionDiffLine.text`
 * is the literal changed line, including any secret that was committed into the
 * repository — no redaction can be applied to it without lying about what the
 * operator is approving. That is why the route carrying this projection may live
 * only on the local plane (loopback or unix socket, OS-owner check and
 * `x-ag-local-proof`); exposing it on the remote, phone-paired surface is a
 * separate human decision, not a routing detail. This task does not change
 * `local-control-contract.md`, and nothing here may be read as permission to.
 *
 * **The fact producer has obligations this module cannot enforce.** The diff
 * must be read with `--no-ext-diff --no-textconv` and without `--binary`,
 * `--output=`, `-O` or `--no-prefix`: an external diff driver or a textconv
 * filter is repository-controlled code execution, and the remaining flags change
 * the very shape parsed by `session-review-diff-parse`. `sessionEnded` must
 * likewise be computed fail-closed — `session !== undefined &&
 * isTerminalSessionState(session.state)` — because reporting a session as ended
 * while its agent is still writing tells the operator a diff is final when it is
 * not.
 *
 * SKAIDYMAS: teksto dekodavimas ir parseris gyvena `session-review-diff-text.ts` ir
 * `session-review-diff-parse.ts` (žr. ten dėl priežasčių). `parseUnifiedDiff`
 * re-eksportuojamas iš čia, nes etalone jis buvo šio modulio eksportas ir testai jį importuoja
 * šiuo keliu.
 */

export { parseUnifiedDiff } from "./session-review-diff-parse.js";

export type SessionAuditFindingFacts = Readonly<{
  severity: SessionAuditSeverity;
  rule: string;
  path?: string | null;
  message: string;
}>;

export type SessionAuditFacts = Readonly<{
  status: "clean" | "findings" | "errored";
  findings: readonly SessionAuditFindingFacts[];
  ranAt: string;
  commit: string;
}>;

export type SessionReviewFacts = Readonly<{
  sessionId: string;
  sessionEnded: boolean;
  sourceBranch: string;
  sourceCommit: string;
  targetBranch: string;
  targetHead: string;
  targetClean: boolean;
  /** The FULL list of repository-relative paths, as `repositoryRelativePaths` returns it. */
  changedFiles: readonly string[];
  /** Unified diff text; `git diff --unified=0 <range>`, the same flags `observe()` uses. */
  rawDiff: string;
  /**
   * Digest of the FULL diff. Required when `rawDiffTruncationReason` is set;
   * otherwise computed from `rawDiff` here.
   */
  diffDigest?: string;
  /** The producer knows `rawDiff` ITSELF is already cut short, usually at a byte limit. */
  rawDiffTruncationReason?: SessionDiffTruncationReason;
  evidence?: SessionGateEvidence;
  requiredGateNames?: readonly string[];
  audit?: SessionAuditFacts;
  observedAt: Date;
}>;

/**
 * A session id as this projection is willing to echo it back.
 *
 * The value reaches the snapshot verbatim, and the route that will carry this
 * projection takes it from a URL path segment — so an unbounded or control-laden
 * string would travel from the request straight into the response.
 */
const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

/**
 * An ISO-8601 instant. Recorded timestamps are shown next to a pass/fail verdict,
 * and a value that is not an instant cannot be compared with anything — so the
 * record carrying it is not evidence a reader can act on.
 */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

function isInstant(value: string): boolean {
  return ISO_INSTANT.test(value) && Number.isFinite(Date.parse(value));
}

const AUDIT_FAILURE = "Session audit facts are not a recognised shape";

const AUDIT_SEVERITIES: ReadonlySet<string> = new Set<SessionAuditSeverity>([
  "info",
  "warning",
  "error",
]);
const AUDIT_STATUSES: ReadonlySet<string> = new Set(["clean", "findings", "errored"]);
const TRUNCATION_REASONS: ReadonlySet<string> = new Set<SessionDiffTruncationReason>([
  "file_limit",
  "line_limit",
  "byte_limit",
]);

/**
 * The changed-file list as the snapshot carries it: git's C-style quoting undone.
 *
 * `repositoryRelativePaths` deliberately leaves the quoting in place, because its
 * output is hashed into `diffDigestOf` and decoding it there would move
 * `diffDigest` and break the preview/confirm comparison the integration flow
 * rests on. The digest below is still taken from the undecoded list for exactly
 * that reason — but what the DTO carries has to be decoded, or one non-ASCII name
 * would appear twice in the same snapshot in two spellings: quoted in
 * `changedFiles.paths` and decoded in `diff.files[].path`.
 */
function decodedChangedFiles(changedFiles: readonly string[]): readonly string[] {
  return Object.freeze(changedFiles.map((candidate) => {
    const decoded = decodePathToken(candidate);
    assertRepositoryRelativePath(decoded);
    return decoded;
  }));
}

function assertFacts(facts: SessionReviewFacts): void {
  if (!SAFE_SESSION_ID.test(facts.sessionId)) {
    refuse("Session review facts name an unusable session");
  }
  if (!Number.isFinite(facts.observedAt.getTime())) {
    refuse("Session review facts carry an unusable observation instant");
  }
  for (const branch of [facts.sourceBranch, facts.targetBranch]) {
    if (!isSafeBranchName(branch)) {
      refuse("Session review facts name an unusable branch");
    }
  }
  for (const commit of [facts.sourceCommit, facts.targetHead]) {
    if (!isCommitOid(commit)) {
      refuse("Session review facts name an unusable commit");
    }
  }
  if (facts.requiredGateNames !== undefined) {
    // The same rule `LocalIntegrationService` applies to its own configuration:
    // an empty list makes every record complete, a duplicate hides a typo.
    if (
      facts.requiredGateNames.length === 0 ||
      new Set(facts.requiredGateNames).size !== facts.requiredGateNames.length
    ) {
      refuse("Session review required gate names are invalid");
    }
  }
  if (facts.rawDiffTruncationReason !== undefined) {
    if (!TRUNCATION_REASONS.has(facts.rawDiffTruncationReason)) {
      refuse("Session review facts name an unknown truncation reason");
    }
    // The digest must cover the FULL diff. Hashing a stream the producer already
    // cut short would compare equal to nothing the operator can approve.
    if (facts.diffDigest === undefined) {
      refuse("Session review facts report a truncated diff without a digest of the full diff");
    }
  }
}

function projectGates(
  facts: SessionReviewFacts,
  requiredGateNames: readonly string[],
): SessionReviewSnapshot["gates"] {
  const evidence = facts.evidence;
  // Every one of these is "no trustworthy evidence", never "gates did not pass
  // for a reason worth showing". The empty gate list is included on purpose:
  // `gatesPassedOf` and `recordReviewReady` both already read it as no evidence
  // at all, so reporting a report here would contradict the host's own semantics.
  if (
    evidence === undefined ||
    evidence.sessionId !== facts.sessionId ||
    evidence.commit !== facts.sourceCommit ||
    evidence.gates.length === 0 ||
    // A record whose instant cannot be read is a record whose age cannot be
    // judged, and gate evidence is only worth as much as the moment it was taken.
    !isInstant(evidence.recordedAt)
  ) {
    return null;
  }
  const gates: readonly SessionGateResult[] = Object.freeze(evidence.gates.map((gate) =>
    Object.freeze({
      name: gate.name,
      passed: gate.passed,
      status: gate.status ?? null,
      durationMs:
        typeof gate.durationMs === "number" &&
          Number.isSafeInteger(gate.durationMs) &&
          gate.durationMs >= 0
          ? gate.durationMs
          : null,
    })
  ));
  return Object.freeze({
    commit: evidence.commit,
    gates,
    recordedAt: evidence.recordedAt,
    // The verdict comes from the shared fail-closed rule, never from
    // `gates.every(...)`: a missing required gate and duplicated evidence both
    // pass that test while proving nothing.
    allRequiredPassed: gatesPassedOf(evidence, facts.sourceCommit, requiredGateNames),
    requiredGateNames: Object.freeze([...requiredGateNames]),
    digest: gateDigestOf(evidence),
  });
}

function projectAudit(facts: SessionReviewFacts): SessionReviewSnapshot["audit"] {
  const audit = facts.audit;
  // Findings recorded against another commit describe other work, and a run
  // whose instant cannot be read cannot be placed against the session at all.
  if (audit === undefined || audit.commit !== facts.sourceCommit || !isInstant(audit.ranAt)) {
    return null;
  }
  if (!AUDIT_STATUSES.has(audit.status)) refuse(AUDIT_FAILURE);
  // Validated across the whole list rather than the carried slice: a finding the
  // cap happens to drop is still evidence the producer is not what it claims.
  for (const finding of audit.findings) {
    if (!AUDIT_SEVERITIES.has(finding.severity)) refuse(AUDIT_FAILURE);
    if (finding.path !== undefined && finding.path !== null) {
      assertRepositoryRelativePath(finding.path);
    }
  }
  const findings: readonly SessionAuditFinding[] = Object.freeze(
    audit.findings.slice(0, SESSION_REVIEW_CAPS.maxAuditFindings).map((finding) =>
      Object.freeze({
        severity: finding.severity,
        // The AG audit writes absolute host paths into its own messages, so the
        // type-level guarantee above does not reach this far: `repositoryRoot`
        // would travel inside `message` if it were forwarded verbatim.
        rule: redactSensitiveText(finding.rule, SESSION_REVIEW_CAPS.maxAuditRuleChars),
        path: finding.path ?? null,
        message: redactSensitiveText(finding.message, SESSION_REVIEW_CAPS.maxAuditMessageChars),
      })
    ),
  );
  return Object.freeze({
    // "Clean" with findings is a contradiction the reader would have to resolve;
    // the findings are the evidence, so they win.
    status: audit.status === "clean" && audit.findings.length > 0 ? "findings" : audit.status,
    findings,
    totalFindingCount: audit.findings.length,
    ranAt: audit.ranAt,
    commit: audit.commit,
  });
}

/** Pure, read-only projection: no ports, no I/O, no side effects. */
export function projectSessionReview(facts: SessionReviewFacts): SessionReviewSnapshot {
  assertFacts(facts);
  const changedFilePaths = decodedChangedFiles(facts.changedFiles);
  const requiredGateNames = facts.requiredGateNames ?? REQUIRED_GATE_NAMES;
  const parsed = parseUnifiedDiff(facts.rawDiff);
  // Files changed but no record to show them: the two facts contradict each
  // other, and the readable outcome — an empty diff next to a list of changed
  // names — is the one that would quietly understate the work.
  if (
    changedFilePaths.length > 0 &&
    parsed.files.length === 0 &&
    facts.rawDiffTruncationReason === undefined
  ) {
    refuse("Session review facts list changed files but carry no diff for them");
  }
  const capped = capDiffFiles(parsed.files);

  // `hiddenHunkCount` is only ever raised by one of the two clippers, so it needs
  // no term of its own here.
  const truncated = capped.filesDropped ||
    capped.linesClipped ||
    capped.bytesClipped ||
    facts.rawDiffTruncationReason !== undefined;
  // The producer's own reason wins: it knows why it stopped READING, while the
  // caps only know why they stopped carrying.
  const truncationReason: SessionDiffTruncationReason | null = !truncated
    ? null
    : facts.rawDiffTruncationReason ??
      (capped.filesDropped ? "file_limit" : capped.bytesClipped ? "byte_limit" : "line_limit");

  const diff: SessionDiff = Object.freeze({
    files: capped.files,
    // Counters and digest describe the FULL diff; capping never rewrites them.
    totalFileCount: parsed.files.length,
    addedLineCount: parsed.addedLineCount,
    removedLineCount: parsed.removedLineCount,
    truncated,
    truncationReason,
    digest: facts.diffDigest ?? diffDigestOf(facts.changedFiles, facts.rawDiff),
  });

  return Object.freeze({
    sessionId: facts.sessionId,
    sessionEnded: facts.sessionEnded,
    git: Object.freeze({
      sourceBranch: facts.sourceBranch,
      sourceCommit: facts.sourceCommit,
      targetBranch: facts.targetBranch,
      targetHead: facts.targetHead,
      targetClean: facts.targetClean,
    }),
    changedFiles: Object.freeze({
      // Decoding preserves the host's sorted order; this cap only shortens the
      // list, and a shorter list of names is not a statement about the diff, so
      // it never sets `truncated`.
      paths: Object.freeze(changedFilePaths.slice(0, SESSION_REVIEW_CAPS.maxChangedFilePaths)),
      totalCount: changedFilePaths.length,
    }),
    diff,
    gates: projectGates(facts, requiredGateNames),
    audit: projectAudit(facts),
    observedAt: facts.observedAt.toISOString(),
  });
}
