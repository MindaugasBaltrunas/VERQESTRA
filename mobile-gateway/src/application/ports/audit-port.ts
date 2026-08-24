/**
 * Append-only audit boundary for the remote gateway.
 *
 * `threat-model.md` lists "audit integrity" as a protected asset and requires an
 * append-only event carrying principal, device, request and result identity for
 * every repudiable action. It equally requires that credentials and terminal
 * content never reach a log.
 *
 * Both requirements are enforced by the SHAPE of {@link AuditEvent}: it is a
 * closed record of identifiers and enumerated outcomes with no free-form
 * payload, message or detail field. There is no place to put terminal input,
 * transcript text, an access token or a host path, so redaction is a type-level
 * guarantee rather than a reviewer's discipline.
 */

export type AuditOutcome = "allowed" | "denied" | "failed";

/**
 * Repudiable gateway actions. Enumerated so an audit consumer can rely on a
 * stable vocabulary and so a new mutation route cannot silently log under an
 * ad-hoc name.
 */
export type AuditAction =
  | "auth.pairing.redeem"
  | "auth.refresh"
  | "terminal.session.create"
  | "terminal.input"
  | "terminal.resize"
  | "terminal.signal"
  | "terminal.close"
  // A name of its own rather than a `terminal.signal` variant: extending write
  // access to a host PTY is a separately deniable act, and an operator reading
  // the record must be able to see it as one.
  | "terminal.lease.renew"
  // Structured control-plane commands (`design.md` §11). Three actions rather
  // than one because the approval path has three distinct, separately
  // repudiable moments: the host asked for an approval, the host decided, and
  // the approved mutation ran. Collapsing them would make "the operator was
  // asked" and "the operator's command was refused" indistinguishable in the
  // record, which is exactly what an approval audit exists to separate.
  | "command.approval.challenge"
  | "command.submit"
  | "command.execute"
  // Local host actions (`local-control-contract.md`). They are the most
  // consequential operations the gateway performs — issuing a pairing secret,
  // killing a session, changing the target branch, cutting a device off — and
  // they share this record shape precisely so none of them can log a one-time
  // code, a diff or an operator's reason text.
  | "local.pairing.challenge"
  | "local.terminal.force_close"
  | "local.gates.run"
  | "local.integration.preview"
  | "local.integration.confirm"
  | "local.device.revoke";

export type AuditEvent = Readonly<{
  eventId: string;
  /** ISO-8601 UTC instant. */
  occurredAt: string;
  action: AuditAction;
  outcome: AuditOutcome;
  /** Correlates the record with the error envelope returned to the caller. */
  correlationId: string;
  principalId?: string;
  deviceId?: string;
  projectId?: string;
  sessionId?: string;
  /** Client-supplied mutation identity, never the `Idempotency-Key` secret itself. */
  requestId?: string;
  /** Machine-readable denial/failure cause, drawn from the gateway error codes. */
  reasonCode?: string;
}>;

export interface AuditPort {
  record(event: AuditEvent): Promise<void>;
}
