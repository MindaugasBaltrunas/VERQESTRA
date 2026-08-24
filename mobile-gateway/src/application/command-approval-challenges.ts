import { CommandIntentError, type AnyCommandIntent } from "../domain/command-intent.js";
import type { CommandPrincipal, CommandSubmission } from "./command-approval-contract.js";

/**
 * Vienkartinių patvirtinimo iššūkių registras.
 *
 * Antra `command-approval-service.ts` skaidymo dalis (žr. `command-approval-contract.ts`).
 * Pjūvio prasmė: iššūkio GYVAVIMO CIKLAS — kas jį išdavė, kam jis galioja, kada baigiasi ir
 * kada sudega — yra atskira atsakomybė nuo to, kas nutinka komandai jį pateikus. Registras
 * neturi jokio ryšio su ledger'iu, auditu ar mutacija, ir būtent todėl jo taisykles galima
 * skaityti vienu prisėdimu.
 *
 * Nuosavybė laikoma sandari: `verify` NIEKO nesudegina, o `markUsed` yra vienintelis būdas
 * pažymėti iššūkį panaudotu. Etalone servisas rašydavo `record.used = true` tiesiai į registro
 * įrašą; čia mutacija priklauso tam, kas įrašą valdo, o elgesys nepakito nė vienu atveju —
 * kvietėjas ją vis tiek kviečia `finally` bloke, tad iššūkis sudega ir tada, kai sprendimas
 * buvo atsisakymas.
 */

type ApprovalRecord = {
  commandDigest: string;
  deviceId: string;
  idempotencyKey: string;
  expiresAtMs: number;
  used: boolean;
};

/**
 * Short by design. An approval is a human decision held open in memory, and the
 * longer it stays valid the longer a stolen challenge is worth stealing.
 */
export const DEFAULT_APPROVAL_TTL_MS = 2 * 60 * 1000;
export const DEFAULT_MAX_OUTSTANDING_APPROVALS = 64;

export class CommandApprovalChallenges {
  private readonly approvals = new Map<string, ApprovalRecord>();

  constructor(
    private readonly clock: () => Date,
    private readonly newId: () => string,
    private readonly approvalTtlMs: number,
    private readonly maxOutstanding: number,
  ) {}

  /**
   * Validates the approval proof without spending it, or answers `undefined`
   * when none was sent.
   *
   * Each refusal keeps its own code so a client can tell "you sent back the
   * wrong thing" (`invalid_request`) from "you waited too long" (`conflict`)
   * and from "that approval is already used" (`duplicate_request`) — the same
   * separation the local integration flow draws.
   */
  verify(
    submission: CommandSubmission,
    commandDigest: string,
  ): Readonly<{ challengeId: string }> | undefined {
    const proof = submission.approval;
    if (!proof) return undefined;
    const record = this.approvals.get(proof.approvalChallengeId);
    if (!record) {
      throw new CommandIntentError("invalid_request", "Approval challenge is unknown");
    }
    if (record.used) {
      throw new CommandIntentError("duplicate_request", "Approval challenge was already used");
    }
    if (this.clock().getTime() >= record.expiresAtMs) {
      // Left in place: expiry is swept, not consumed here, so a caller cannot
      // tell an expired challenge from one that never existed by probing twice.
      throw new CommandIntentError("conflict", "Approval challenge expired");
    }
    if (record.deviceId !== submission.principal.deviceId) {
      throw new CommandIntentError("forbidden", "Approval challenge belongs to another device");
    }
    if (record.idempotencyKey !== submission.intent.idempotencyKey) {
      throw new CommandIntentError("invalid_request", "Approval challenge belongs to another request");
    }
    if (proof.commandDigest !== record.commandDigest) {
      throw new CommandIntentError("invalid_request", "Approved command digest differs from the shown one");
    }
    if (commandDigest !== record.commandDigest) {
      throw new CommandIntentError("invalid_request", "Confirmed command differs from the approved one");
    }
    return Object.freeze({ challengeId: proof.approvalChallengeId });
  }

  /**
   * Spends a challenge. Called on USE rather than on success: a challenge that
   * reached the domain has been used up, so a refused confirm cannot be retried
   * against the same approval until the operator approves again.
   */
  markUsed(challengeId: string): void {
    const record = this.approvals.get(challengeId);
    if (record) record.used = true;
  }

  issue(
    intent: AnyCommandIntent,
    principal: CommandPrincipal,
    commandDigest: string,
  ): Readonly<{ challengeId: string; expiresAtMs: number }> {
    const nowMs = this.clock().getTime();
    for (const [challengeId, record] of this.approvals) {
      if (record.used || record.expiresAtMs <= nowMs) {
        this.approvals.delete(challengeId);
      }
    }
    if (this.approvals.size >= this.maxOutstanding) {
      throw new CommandIntentError("conflict", "Too many approvals are outstanding");
    }
    const challengeId = this.newId();
    const expiresAtMs = nowMs + this.approvalTtlMs;
    this.approvals.set(challengeId, {
      commandDigest,
      deviceId: principal.deviceId,
      idempotencyKey: intent.idempotencyKey,
      expiresAtMs,
      used: false,
    });
    return Object.freeze({ challengeId, expiresAtMs });
  }
}
