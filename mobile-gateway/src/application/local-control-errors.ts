/**
 * Error vocabulary of the local control surface.
 *
 * It is a separate list from `GATEWAY_ERROR_CODES` on purpose. That one is the
 * versioned `ErrorEnvelope` enum of the remote OpenAPI document, asserted
 * against the contract file by `api-contract-conformance.test.ts`; adding a code
 * to it is a published API change for every paired phone. The local surface is
 * excluded from that document entirely, so its vocabulary must be able to move
 * without touching the published one, and it must not be able to grow the remote
 * enum by accident.
 *
 * The two lists overlap in spelling where they mean the same thing, which is
 * what lets a transport map either straight through without a translation table.
 * The invariant is "the two lists agree wherever they overlap" — a shared
 * spelling carries a shared status and a shared `recoverable` verdict, asserted
 * code by code in `local-control-isolation.test.ts`. It is deliberately NOT
 * "the local list is a subset of the remote one": that this list happens to
 * carry no local-only code today is a fact about today, not a rule. Adding one
 * is a one-line edit of `LOCAL_ONLY_CODES` in that test, never a reason to grow
 * the published remote enum.
 */

export const LOCAL_CONTROL_ERROR_CODES = Object.freeze([
  "unauthenticated",
  "forbidden",
  "invalid_request",
  "not_found",
  "conflict",
  "duplicate_request",
  "session_not_live",
  "rate_limited",
  "internal_error",
] as const);

export type LocalControlErrorCode = (typeof LOCAL_CONTROL_ERROR_CODES)[number];

export class LocalControlError extends Error {
  constructor(readonly code: LocalControlErrorCode, message: string) {
    super(message);
    this.name = "LocalControlError";
  }
}
