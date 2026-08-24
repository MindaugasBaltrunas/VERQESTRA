/**
 * Read-only AG Loop UI contract.
 *
 * The mobile client never talks to the AG Loop web UI itself: the host gateway
 * projects the upstream payload into the reduced, redacted DTO declared here
 * (`api-contract.yaml` -> `AgLoopDashboard`, `AgLoopTaskBucket`). Only the
 * allowlisted fields below exist on the mobile side, so upstream mutation
 * metadata (`root`, `loop_controls`, `route`, `endpoint`, `method`, `command`,
 * `actions`), absolute host paths and the local UI token have nowhere to land.
 *
 * The port is read-only by construction: it declares no mutating method, so no
 * mobile caller can reach an AG Loop write path through this contract.
 */

export type AgLoopTaskBucket =
  | "queue"
  | "active"
  | "delegated"
  | "done"
  | "error"
  | "failed"
  | "human-review";

/** Presentation order of the AG Loop buckets, from newest work to archived. */
export const agLoopTaskBuckets: readonly AgLoopTaskBucket[] = Object.freeze([
  "queue",
  "active",
  "delegated",
  "human-review",
  "error",
  "failed",
  "done",
] as const);

/** Availability of the AG Loop UI as reported by the host gateway. */
export type AgLoopAvailability = "online" | "offline";

export type AgLoopCurrentTask = Readonly<{
  id: string | null;
  state: "none" | "active" | "stale";
}>;

export type AgLoopRuntimeComponent = Readonly<{
  name: string;
  status: "running" | "stopped" | "unknown";
}>;

export type AgLoopDashboardSnapshot = Readonly<{
  availability: AgLoopAvailability;
  currentTask: AgLoopCurrentTask;
  queueCounts: Readonly<Record<string, number>>;
  runtime: readonly AgLoopRuntimeComponent[];
  reviewCount: number;
  updatedAt: string;
}>;

export type AgLoopTaskBucketSnapshot = Readonly<{
  bucket: AgLoopTaskBucket;
  /** Task file names only, capped by the gateway; `totalCount` stays authoritative. */
  tasks: readonly string[];
  totalCount: number;
}>;

export type AgLoopReadFailureCode =
  | "unavailable"
  | "unauthorized"
  | "invalid_response"
  | "transport_failed";

/** Failure contract of {@link AgLoopUiReadPort}; adapters map their own errors onto it. */
export class AgLoopReadError extends Error {
  constructor(readonly code: AgLoopReadFailureCode, message: string) {
    super(message);
    this.name = "AgLoopReadError";
  }
}

export interface AgLoopUiReadPort {
  readDashboard(input: Readonly<{ projectId: string }>): Promise<AgLoopDashboardSnapshot>;
  readTaskBucket(input: Readonly<{
    projectId: string;
    bucket: AgLoopTaskBucket;
  }>): Promise<AgLoopTaskBucketSnapshot>;
}

/**
 * State of the read-only AG Loop channel, kept separate from the mobile
 * terminal session state:
 *
 * - `connecting`   — a read is in flight and no snapshot has been accepted yet;
 * - `connected`    — the last read succeeded and the AG Loop UI reports `online`;
 * - `degraded`     — the last read failed while AG Loop itself is not known to be
 *                    offline, so a cached snapshot is still shown, read-only and
 *                    stale;
 * - `offline`      — the AG Loop UI reports `offline` or is unreachable. A cached
 *                    snapshot may still be shown; presentation marks it stale.
 *
 * A failed read may only keep or lower the reported quality: a link already known
 * to be offline never looks better because a retry failed as well.
 */
export type AgLoopLinkState = "connecting" | "connected" | "degraded" | "offline";
