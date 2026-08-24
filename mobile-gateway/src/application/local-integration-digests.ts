import { createHash } from "node:crypto";
import type { SessionGateEvidence } from "./ports/session-gate-evidence-port.js";

/**
 * The two digests `local-control-contract.md` shows to the operator and
 * re-checks before anything is merged.
 *
 * Both are computed from a CANONICAL form rather than from raw command output,
 * because a digest that changes for a reason the operator cannot see is a digest
 * that blocks correct integrations and teaches everyone to retry until it
 * passes. Line endings are normalised and trailing blank lines dropped for the
 * diff; gate results are ordered by name and stripped of the instant they were
 * recorded at, so re-running the same gates with the same outcome yields the
 * same digest while a changed OUTCOME never does.
 */

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function normalizeDiff(rawDiff: string): string {
  return rawDiff.replace(/\r\n/g, "\n").replace(/\n+$/, "");
}

/** Digest of exactly what the preview displayed: the file list and the diff. */
export function diffDigestOf(changedFiles: readonly string[], rawDiff: string): string {
  return sha256(JSON.stringify({
    changedFiles: [...changedFiles],
    diff: normalizeDiff(rawDiff),
  }));
}

/**
 * Digest of the recorded gate outcomes. Missing evidence hashes an empty record
 * rather than a special value, so "no evidence" is a normal, comparable digest
 * and the pass/fail decision stays with {@link gatesPassedOf}.
 *
 * Only the name and the outcome are hashed. `status`, `durationMs` and
 * `recordedAt` are diagnostics an operator never approved and cannot compare:
 * a digest that moves because a gate took two seconds longer would invalidate
 * an approval for a reason invisible in the preview, which is the failure mode
 * this whole file exists to avoid.
 */
export function gateDigestOf(evidence: SessionGateEvidence | undefined): string {
  const canonical = evidence === undefined
    ? { sessionId: "", commit: "", gates: [] }
    : {
      sessionId: evidence.sessionId,
      commit: evidence.commit,
      gates: [...evidence.gates]
        .map((gate) => ({ name: gate.name, passed: gate.passed }))
        .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0)),
    };
  return sha256(JSON.stringify(canonical));
}

/**
 * Fail-closed gate verdict. Evidence recorded for another commit is evidence
 * about other work, and an empty gate list is not a passing run — both are
 * refusals, not defaults.
 *
 * `requiredGateNames` has no default on purpose. The policy a verifier applies
 * must come from the verifier's own configuration, never from the artefact
 * being verified and never from a default buried here: either would let the
 * answer to "were all required gates run" be supplied by whoever wrote the
 * record. A gate the caller did not require may still appear — a host is free
 * to record more than the minimum — but it has to be green as well, because a
 * recorded failure is a recorded failure.
 */
export function gatesPassedOf(
  evidence: SessionGateEvidence | undefined,
  sourceCommit: string,
  requiredGateNames: readonly string[],
): boolean {
  if (!evidence || evidence.commit !== sourceCommit || evidence.gates.length === 0) {
    return false;
  }
  const recorded = new Set(evidence.gates.map((gate) => gate.name));
  // Two records for one gate name make the evidence ambiguous, and ambiguous
  // evidence is not evidence: there is no way to tell which run is being read.
  if (recorded.size !== evidence.gates.length) {
    return false;
  }
  for (const name of requiredGateNames) {
    if (!recorded.has(name)) {
      return false;
    }
  }
  return evidence.gates.every((gate) => gate.passed);
}
