/**
 * Recorded quality-gate outcomes for one session's work.
 *
 * `local-control-contract.md` refuses an integration whose "required gates" did
 * not pass, so this port answers a question about EVIDENCE: what did the host
 * record for a commit. The gateway now also produces that record — `design.md`
 * §7 makes it the component that runs the five gates — and that is precisely
 * why reading and writing are two ports rather than one interface with two
 * methods. The verifier of the evidence must not be able to author it, and
 * `LocalIntegrationService` is constructed with the read port only, so "the
 * integration flow cannot write its own passing gates" is a fact about types
 * rather than a rule someone has to remember.
 *
 * Absence is meaningful. `undefined` means no trustworthy evidence exists, and
 * every caller must treat that as "gates did not pass" — a missing record is the
 * same risk as a failed one, and failing closed is the only safe direction when
 * the alternative is merging unreviewed work.
 */

export type GateResult = Readonly<{
  name: string;
  passed: boolean;
  /** Diagnostic only; deliberately outside `gateDigestOf`. */
  status?: "passed" | "failed" | "timed_out" | "errored";
  /** Diagnostic only; deliberately outside `gateDigestOf`. */
  durationMs?: number;
}>;

export type SessionGateEvidence = Readonly<{
  sessionId: string;
  /** Commit the gates were evaluated against; evidence for another commit is stale. */
  commit: string;
  gates: readonly GateResult[];
  recordedAt: string;
}>;

export interface SessionGateEvidencePort {
  /** Evidence for `sessionId`, or `undefined` when none can be trusted. */
  evidenceFor(sessionId: string): Promise<SessionGateEvidence | undefined>;
}

export interface SessionGateEvidenceWritePort {
  /** Replaces the session's evidence with one complete record, atomically. */
  record(evidence: SessionGateEvidence): Promise<void>;
}
