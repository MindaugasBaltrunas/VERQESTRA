import type {
  AnyCommandIntent,
  CommandDecision,
  CommandIntentErrorCode,
  CommandRisk,
} from "../domain/command-intent.js";
import type { DeviceScope } from "../domain/device-auth.js";
import type { AuditPort } from "./ports/audit-port.js";
import { createHash } from "node:crypto";

/**
 * Kontraktas ir GRYNOJI approval gate'o dalis.
 *
 * SKAIDYMAS (VERQESTRA ≤500 eil. vartas; etalone visa tai buvo viename 596 eilučių faile).
 * Pjūvis pagal prasmę, ne pagal eilučių skaičių, ir SĄMONINGAI ne per `ApprovedCommand`:
 * to tipo brand'as yra simbolis, kurio `command-approval-service.ts` neeksportuoja, ir būtent
 * tai daro „patvirtinto rašymo neįmanoma suklastoti" kompiliatoriaus tikrinamu faktu. Iškėlus
 * simbolį į atskirą modulį jis taptų pasiekiamas visam paketui — skaidymas būtų sulaužęs
 * saugumo savybę, kurią etalonas aiškiai vardija. Todėl brand'as, `gitHostWriteContext` ir
 * pats servisas lieka viename faile, o čia gyvena tai, kas neturi paslapčių: viešos formos
 * ir digest'as.
 */

/** Authenticated caller a command is decided for. */
export type CommandPrincipal = Readonly<{
  principalId: string;
  deviceId: string;
  /** True when the caller is the paired owner principal. */
  isOwner: boolean;
  scopes: readonly DeviceScope[];
}>;

/** What a client returns to convert a `confirmation_required` decision. */
export type CommandApprovalProof = Readonly<{
  approvalChallengeId: string;
  /** The digest the operator was shown; re-checked against the intent. */
  commandDigest: string;
}>;

export type CommandSubmission = Readonly<{
  intent: AnyCommandIntent;
  principal: CommandPrincipal;
  /** Present only on the confirm leg of a `confirm`-risk command. */
  approval?: CommandApprovalProof;
  /** Correlates the decision with the caller's error envelope; minted when absent. */
  correlationId?: string;
}>;

/** Decision-first answer of `design.md` §11, plus the approval material. */
export type CommandOutcome = Readonly<{
  commandId: string;
  decision: CommandDecision;
  risk: CommandRisk;
  correlationId: string;
  /** Why the command was refused; absent when it was accepted. */
  reasonCode?: CommandIntentErrorCode;
  /** One-time challenge to return, present only on `confirmation_required`. */
  approvalChallengeId?: string;
  /** Digest of exactly what is being approved, present with the challenge. */
  commandDigest?: string;
  /** ISO-8601 instant the challenge stops being usable. */
  approvalExpiresAt?: string;
}>;

/**
 * Either the mutation ran and `result` holds its value — including on a replay,
 * where the FIRST run's value is returned and nothing runs again — or it did
 * not, and `outcome` says why.
 */
export type CommandExecution<T> =
  | Readonly<{ outcome: CommandOutcome; executed: true; result: T }>
  | Readonly<{ outcome: CommandOutcome; executed: false }>;

/** An audit record could not be written for a command that requires one. */
export class CommandAuditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommandAuditError";
  }
}

export type CommandApprovalDependencies = Readonly<{
  audit: AuditPort;
  clock?: () => Date;
  /** Mints challenge, event and correlation identifiers. */
  newId?: () => string;
  approvalTtlMs?: number;
  maxOutstandingApprovals?: number;
  ledgerTtlMs?: number;
  maxLedgerRecords?: number;
}>;

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

/**
 * Key-order-independent JSON of a closed command payload.
 *
 * The digest must answer "is this the same command" and nothing else, so two
 * payloads that differ only in property order have to hash alike — otherwise a
 * client that serialises its object differently on the confirm leg would lose a
 * valid approval for a reason invisible to the operator.
 */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== "object") return value;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return Object.fromEntries(entries.map(([key, entry]) => [key, canonical(entry)]));
}

/**
 * Digest of what the operator approves: the action, the project it targets and
 * the payload.
 *
 * The device, the command id and the idempotency key are deliberately NOT part
 * of it. Those bind the approval to a caller and a mutation identity, which the
 * challenge record already does; folding them in would make the digest change
 * for reasons the approval prompt never displayed.
 */
export function commandDigestOf(intent: AnyCommandIntent): string {
  return sha256(JSON.stringify({
    action: intent.action,
    projectId: intent.projectId ?? null,
    payload: canonical(intent.payload),
  }));
}
