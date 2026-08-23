import { newLeaseId } from "../shared/ids.js";

export type TerminalControlLease = Readonly<{
  leaseId: string;
  sessionId: string;
  projectId: string;
  provider: "claude-code" | "codex";
  ownerDeviceId: string;
  generation: number;
  grantedAt: string;
  expiresAt: string;
}>;

export class StaleTerminalLeaseError extends Error {
  readonly code = "stale_terminal_lease";
}

export function createTerminalControlLease(input: {
  sessionId: string;
  projectId: string;
  provider: TerminalControlLease["provider"];
  ownerDeviceId: string;
  generation?: number;
  now?: Date;
  ttlMs: number;
}): TerminalControlLease {
  if (!Number.isSafeInteger(input.ttlMs) || input.ttlMs <= 0) {
    throw new Error("ttlMs must be a positive safe integer");
  }
  const now = input.now ?? new Date();
  return Object.freeze({
    leaseId: newLeaseId(),
    sessionId: input.sessionId,
    projectId: input.projectId,
    provider: input.provider,
    ownerDeviceId: input.ownerDeviceId,
    generation: input.generation ?? 1,
    grantedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + input.ttlMs).toISOString(),
  });
}

export function assertTerminalLease(
  lease: TerminalControlLease,
  fence: {
    leaseId: string;
    generation: number;
    ownerDeviceId: string;
    sessionId: string;
    now?: Date;
  },
): void {
  const now = fence.now ?? new Date();
  if (
    fence.leaseId !== lease.leaseId ||
    fence.generation !== lease.generation ||
    fence.ownerDeviceId !== lease.ownerDeviceId ||
    fence.sessionId !== lease.sessionId ||
    now.getTime() >= Date.parse(lease.expiresAt)
  ) {
    throw new StaleTerminalLeaseError("Terminal lease is stale, expired, or owned by another device");
  }
}

/**
 * Extends a live lease by a fresh TTL, and changes nothing else.
 *
 * `generation` does NOT move and `leaseId` is NOT rotated. The generation is a
 * revocation counter, and {@link revokeTerminalLease} stays its only writer, so
 * "the generation changed" keeps meaning exactly one thing: the right was taken
 * away. If a renewal bumped it, every request already in flight from the phone
 * would come back `stale_terminal_lease` the moment the lease was extended —
 * renewing would be its own failure mode — and a revocation would become
 * indistinguishable from an extension in the registry and in the audit record.
 * Rotating `leaseId` buys nothing either: the fence is not a secret. Authority
 * is proven by the access token and the `ownerDeviceId` in its claims; the fence
 * only ties a request to one particular lease.
 *
 * `grantedAt` is left alone because it records when the right was GRANTED, and
 * an extension grants no new right.
 *
 * The staleness check is {@link assertTerminalLease} itself rather than a
 * separate "already expired" predicate: "an expired lease cannot be renewed"
 * then comes from the same `>= expiresAt` comparison every other action uses,
 * and the two can never drift apart.
 */
export function renewTerminalControlLease(
  lease: TerminalControlLease,
  fence: {
    leaseId: string;
    generation: number;
    ownerDeviceId: string;
    sessionId: string;
    now?: Date;
  },
  ttlMs: number,
): TerminalControlLease {
  assertTerminalLease(lease, fence);
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
    throw new Error("ttlMs must be a positive safe integer");
  }
  const now = fence.now ?? new Date();
  return Object.freeze({
    ...lease,
    expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
  });
}

export function revokeTerminalLease(lease: TerminalControlLease, now = new Date()): TerminalControlLease {
  return Object.freeze({
    ...lease,
    generation: lease.generation + 1,
    expiresAt: now.toISOString(),
  });
}
