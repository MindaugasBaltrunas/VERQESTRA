import { randomUUID } from "node:crypto";
import {
  assertCommandIdempotencyKey,
  CommandIntentError,
  decideCommandIntent,
  type CommandAction,
  type CommandDecisionResult,
} from "../domain/command-intent.js";
import type { AuditAction, AuditEvent, AuditOutcome, AuditPort } from "./ports/audit-port.js";
import type { GitHostWriteContext } from "./ports/git-host-port.js";
import {
  CommandApprovalChallenges,
  DEFAULT_APPROVAL_TTL_MS,
  DEFAULT_MAX_OUTSTANDING_APPROVALS,
} from "./command-approval-challenges.js";
import {
  CommandAuditError,
  commandDigestOf,
  type CommandApprovalDependencies,
  type CommandExecution,
  type CommandOutcome,
  type CommandSubmission,
} from "./command-approval-contract.js";

/**
 * The approval gate every structured control-plane command passes through.
 *
 * `design.md` §11 says a GitHub or control command is answered with a DECISION
 * before it is answered with an effect, that a `confirm`-risk command needs a
 * one-time approval challenge, and that the client cannot supply its own risk.
 * {@link decideCommandIntent} already encodes that policy as a pure rule; what
 * was missing — and what this service is — is the part that makes the rule
 * unavoidable:
 *
 * - **There is no decide-only entry point.** {@link CommandApprovalService.execute}
 *   is the whole API. A decision that is not paired with the effect it
 *   authorises is how an approval gate becomes decorative, so the caller hands
 *   in the mutation and gets back either its result or the reason it did not
 *   run. Nothing else can reach the executor.
 * - **The approval is bound to what the operator saw.** The challenge is issued
 *   against a {@link commandDigestOf} digest of the action, the project and the
 *   payload, and the confirm leg must send that digest back. A challenge is
 *   therefore useless for any command other than the one it was shown for —
 *   the same preview/confirm rule `local-control-contract.md` applies to a
 *   local integration, expressed for a remote command.
 * - **An approved write cannot be forged.** {@link ApprovedCommand} carries a
 *   brand keyed by a symbol this module does not export, so it can only be
 *   produced here, and {@link gitHostWriteContext} is the only way to build the
 *   `approvedCommandId` a {@link GitHostWriteContext} requires. A GitHub
 *   mutation that skipped the gate does not compile. **Tai ir yra priežastis,
 *   kodėl skaidant šį failą (VERQESTRA ≤500 eil. vartas) brand'as NEBUVO
 *   iškeltas** — žr. `command-approval-contract.ts`.
 * - **Every decision is audited, and an unwritable record fails the command.**
 *   The audit event shape carries identifiers and enumerated outcomes only, so
 *   an approval record structurally cannot contain a pull request title, a
 *   terminal transcript or a credential.
 *
 * Replay safety reuses the ledger discipline the rest of the gateway already
 * applies: one terminal outcome per idempotency key, the same key with a
 * different command refused rather than served, and a failed mutation releasing
 * its slot so an operator can retry an effect that did not happen.
 */

// Kvietėjų importų paviršius nepakito: etalone visos šios formos gyveno šiame faile, tad jos
// re-eksportuojamos iš čia. Skaidymas yra vidinis, ne kontrakto pakeitimas.
export {
  CommandAuditError,
  commandDigestOf,
} from "./command-approval-contract.js";
export type {
  CommandApprovalDependencies,
  CommandApprovalProof,
  CommandExecution,
  CommandOutcome,
  CommandPrincipal,
  CommandSubmission,
} from "./command-approval-contract.js";

/**
 * Proof that the gate accepted a command, and the only thing an executor is
 * given. The brand key is a symbol this module keeps to itself: outside this
 * file the property cannot be named, so the value cannot be constructed.
 */
const APPROVED_COMMAND = Symbol("approved-command");

export type ApprovedCommand = Readonly<{
  commandId: string;
  idempotencyKey: string;
  action: CommandAction;
  projectId?: string;
  principalId: string;
  deviceId: string;
  readonly [APPROVED_COMMAND]: true;
}>;

const DEFAULT_LEDGER_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_LEDGER_RECORDS = 1024;

type LedgerRecord = {
  commandDigest: string;
  decision: CommandDecisionResult;
  createdAtMs: number;
  /** Present once an executor ran; a replay is answered from it. */
  result?: Promise<unknown>;
};

/**
 * The only construction site of a {@link GitHostWriteContext}.
 *
 * `git-host-port.ts` requires every write to carry the `commandId` of an
 * accepted intent; taking an {@link ApprovedCommand} — a value only this module
 * can produce — is what turns that requirement from a comment into something
 * the compiler enforces.
 */
export function gitHostWriteContext(
  approved: ApprovedCommand,
  expectedRepository: string,
): GitHostWriteContext {
  if (approved.projectId === undefined) {
    throw new CommandIntentError("invalid_request", "A repository write must name its project");
  }
  if (expectedRepository.length === 0) {
    throw new CommandIntentError("invalid_request", "A repository write must name the approved repository");
  }
  return Object.freeze({
    projectId: approved.projectId,
    expectedRepository,
    idempotencyKey: approved.idempotencyKey,
    approvedCommandId: approved.commandId,
  });
}

export class CommandApprovalService {
  private readonly ledger = new Map<string, LedgerRecord>();
  private readonly challenges: CommandApprovalChallenges;

  private readonly audit: AuditPort;
  private readonly clock: () => Date;
  private readonly newId: () => string;
  private readonly ledgerTtlMs: number;
  private readonly maxLedgerRecords: number;

  constructor(dependencies: CommandApprovalDependencies) {
    this.audit = dependencies.audit;
    this.clock = dependencies.clock ?? (() => new Date());
    this.newId = dependencies.newId ?? (() => randomUUID());
    const approvalTtlMs = dependencies.approvalTtlMs ?? DEFAULT_APPROVAL_TTL_MS;
    const maxOutstandingApprovals = dependencies.maxOutstandingApprovals
      ?? DEFAULT_MAX_OUTSTANDING_APPROVALS;
    this.ledgerTtlMs = dependencies.ledgerTtlMs ?? DEFAULT_LEDGER_TTL_MS;
    this.maxLedgerRecords = dependencies.maxLedgerRecords ?? DEFAULT_MAX_LEDGER_RECORDS;
    for (
      const bound of [
        approvalTtlMs,
        maxOutstandingApprovals,
        this.ledgerTtlMs,
        this.maxLedgerRecords,
      ]
    ) {
      if (!Number.isSafeInteger(bound) || bound <= 0) {
        throw new Error("Command approval bounds are invalid");
      }
    }
    this.challenges = new CommandApprovalChallenges(
      this.clock,
      this.newId,
      approvalTtlMs,
      maxOutstandingApprovals,
    );
  }

  /**
   * Decide `submission` and, only when the decision is `accepted`, run `mutate`.
   *
   * The order below is the security property, not an implementation detail:
   *
   * 1. the ledger is consulted FIRST, so a replay is answered from the first
   *    outcome without spending a fresh approval;
   * 2. the approval challenge is validated, and then burned whatever happens
   *    next — a challenge that took part in a decision is spent even if the
   *    decision was a refusal or the intent turned out to be malformed;
   * 3. the domain decides, with the verified challenge as an input it cannot be
   *    told to skip;
   * 4. the decision is audited BEFORE the mutation runs, so an unwritable audit
   *    record prevents the effect rather than merely failing to describe it.
   */
  async execute<T>(
    submission: CommandSubmission,
    mutate: (approved: ApprovedCommand) => Promise<T>,
  ): Promise<CommandExecution<T>> {
    const { intent, principal } = submission;
    const correlationId = submission.correlationId ?? this.newId();
    const commandDigest = commandDigestOf(intent);

    const replay = await this.replayOf<T>(submission, commandDigest, correlationId);
    if (replay) return replay;

    let decision: CommandDecisionResult;
    let issued: Readonly<{ challengeId: string; expiresAtMs: number }> | undefined;
    try {
      const verified = this.challenges.verify(submission, commandDigest);
      try {
        decision = decideCommandIntent(intent, {
          deviceId: principal.deviceId,
          isOwner: principal.isOwner,
          scopes: principal.scopes,
          ...(verified ? { verifiedApprovalChallengeId: verified.challengeId } : {}),
          issueApprovalChallenge: () => {
            issued = this.challenges.issue(intent, principal, commandDigest);
            return issued.challengeId;
          },
        });
      } finally {
        // Spent on use, not on success: a challenge that reached the domain has
        // been used up, so a refused confirm cannot be retried against the same
        // approval until the operator approves again.
        if (verified) this.challenges.markUsed(verified.challengeId);
      }
    } catch (error) {
      if (error instanceof CommandIntentError) {
        await this.record(submission, "command.submit", "denied", correlationId, error.code);
      }
      throw error;
    }

    if (decision.decision === "confirmation_required") {
      const outcome = Object.freeze({
        commandId: decision.commandId,
        decision: decision.decision,
        risk: decision.risk,
        correlationId,
        ...(decision.approvalChallengeId
          ? { approvalChallengeId: decision.approvalChallengeId }
          : {}),
        commandDigest,
        ...(issued ? { approvalExpiresAt: new Date(issued.expiresAtMs).toISOString() } : {}),
      });
      await this.record(submission, "command.approval.challenge", "allowed", correlationId);
      return Object.freeze({ outcome, executed: false });
    }

    if (decision.decision !== "accepted") {
      const outcome = this.outcomeOf(decision, correlationId);
      // A refusal changes nothing, so it is audited FIRST — the record must not
      // depend on the ledger having room. The ledger entry then makes the
      // refusal durable: the same key cannot be re-decided into an acceptance.
      await this.record(
        submission,
        "command.submit",
        "denied",
        correlationId,
        decision.reasonCode,
      );
      this.remember(intent.idempotencyKey, commandDigest, decision);
      return Object.freeze({ outcome, executed: false });
    }

    const outcome = this.outcomeOf(decision, correlationId);
    // The key is claimed, and the decision recorded, before anything can
    // happen: a full ledger or an unwritable audit record must stop the
    // mutation, not describe it after the fact.
    const record = this.remember(intent.idempotencyKey, commandDigest, decision);
    try {
      await this.record(submission, "command.submit", "allowed", correlationId);
    } catch (error) {
      this.ledger.delete(intent.idempotencyKey);
      throw error;
    }

    const approved: ApprovedCommand = Object.freeze({
      commandId: intent.commandId,
      idempotencyKey: intent.idempotencyKey,
      action: intent.action,
      ...(intent.projectId === undefined ? {} : { projectId: intent.projectId }),
      principalId: intent.principalId,
      deviceId: intent.deviceId,
      [APPROVED_COMMAND]: true as const,
    });

    const running = mutate(approved);
    record.result = running;
    let result: T;
    try {
      result = await running;
    } catch (error) {
      // The effect did not happen, so the key must not stay claimed: an
      // operator has to be able to retry a mutation that failed.
      if (this.ledger.get(intent.idempotencyKey)?.result === running) {
        this.ledger.delete(intent.idempotencyKey);
      }
      await this.record(submission, "command.execute", "failed", correlationId, "internal_error");
      throw error;
    }
    // The effect HAS happened by now, so the ledger entry stays even if this
    // record cannot be written: a retry must replay the first result rather
    // than mutate again, and the caller still learns the audit failed.
    await this.record(submission, "command.execute", "allowed", correlationId);
    return Object.freeze({ outcome, executed: true, result });
  }

  /**
   * The first outcome for this idempotency key, when there is one.
   *
   * A key seen with a DIFFERENT command is refused rather than answered: it is
   * either a client bug or an attempt to claim another command's ledger entry,
   * and serving it would hand back an outcome that describes something else.
   */
  private async replayOf<T>(
    submission: CommandSubmission,
    commandDigest: string,
    correlationId: string,
  ): Promise<CommandExecution<T> | undefined> {
    const { intent, principal } = submission;
    // Structural checks first, so a malformed or foreign key never reads or
    // writes another device's ledger entry. The domain re-asserts both.
    if (intent.deviceId !== principal.deviceId) {
      const error = new CommandIntentError(
        "forbidden",
        "Command intent was submitted for another device",
      );
      await this.record(submission, "command.submit", "denied", correlationId, error.code);
      throw error;
    }
    try {
      assertCommandIdempotencyKey(intent.idempotencyKey, principal.deviceId);
    } catch (error) {
      if (error instanceof CommandIntentError) {
        await this.record(submission, "command.submit", "denied", correlationId, error.code);
      }
      throw error;
    }

    const existing = this.ledger.get(intent.idempotencyKey);
    if (!existing) return undefined;
    if (existing.commandDigest !== commandDigest) {
      const error = new CommandIntentError(
        "duplicate_request",
        "Idempotency key was reused for another command",
      );
      await this.record(submission, "command.submit", "denied", correlationId, error.code);
      throw error;
    }
    const decision = decideCommandIntent(intent, {
      deviceId: principal.deviceId,
      isOwner: principal.isOwner,
      scopes: principal.scopes,
      ledgerDecision: existing.decision,
      issueApprovalChallenge: () => {
        throw new CommandIntentError("conflict", "A replayed command never issues an approval");
      },
    });
    const outcome = this.outcomeOf(decision, correlationId);
    // `denied` describes THIS submission, which changed nothing. The first
    // attempt has its own `command.execute` record; a replay that answered
    // `allowed` would read as a second effect in the audit trail.
    await this.record(
      submission,
      "command.submit",
      "denied",
      correlationId,
      decision.reasonCode,
    );
    if (existing.result === undefined) {
      return Object.freeze({ outcome, executed: false });
    }
    return Object.freeze({
      outcome,
      executed: true,
      result: await (existing.result as Promise<T>),
    });
  }

  private remember(
    idempotencyKey: string,
    commandDigest: string,
    decision: CommandDecisionResult,
  ): LedgerRecord {
    const nowMs = this.clock().getTime();
    for (const [key, record] of this.ledger) {
      if (nowMs - record.createdAtMs >= this.ledgerTtlMs) {
        this.ledger.delete(key);
      }
    }
    if (this.ledger.size >= this.maxLedgerRecords) {
      throw new CommandIntentError("conflict", "Command ledger is full");
    }
    const record: LedgerRecord = { commandDigest, decision, createdAtMs: nowMs };
    this.ledger.set(idempotencyKey, record);
    return record;
  }

  private outcomeOf(decision: CommandDecisionResult, correlationId: string): CommandOutcome {
    return Object.freeze({
      commandId: decision.commandId,
      decision: decision.decision,
      risk: decision.risk,
      correlationId,
      ...(decision.reasonCode ? { reasonCode: decision.reasonCode } : {}),
    });
  }

  /**
   * Writes one audit record, and fails the command when it cannot.
   *
   * Only identifiers reach the event. `commandId` is the client's own
   * correlation value and stands in for `requestId`; the idempotency key, the
   * approval challenge and the payload never appear, so no title, branch name
   * or transcript can ride along in an approval record.
   */
  private async record(
    submission: CommandSubmission,
    action: AuditAction,
    outcome: AuditOutcome,
    correlationId: string,
    reasonCode?: string,
  ): Promise<void> {
    const { intent } = submission;
    const event: AuditEvent = {
      eventId: this.newId(),
      occurredAt: this.clock().toISOString(),
      action,
      outcome,
      correlationId,
      principalId: intent.principalId,
      deviceId: intent.deviceId,
      ...(intent.projectId ? { projectId: intent.projectId } : {}),
      requestId: intent.commandId,
      ...(reasonCode ? { reasonCode } : {}),
    };
    try {
      await this.audit.record(event);
    } catch {
      throw new CommandAuditError("Command audit record could not be written");
    }
  }
}
