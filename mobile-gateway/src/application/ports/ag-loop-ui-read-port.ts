export type AgLoopAvailability = "online" | "offline";

export type AgLoopDashboard = Readonly<{
  availability: AgLoopAvailability;
  currentTask: Readonly<{ id: string | null; state: "none" | "active" | "stale" }>;
  queueCounts: Readonly<Record<string, number>>;
  runtime: readonly Readonly<{ name: string; status: "running" | "stopped" | "unknown" }>[];
  reviewCount: number;
  updatedAt: string;
}>;

export type AgLoopTaskBucket = Readonly<{
  bucket: string;
  tasks: readonly string[];
  totalCount: number;
}>;

/** The three AG Loop logs `api-contract.yaml` exposes, and nothing else. */
export type AgLoopLogName = "claude" | "orchestrator" | "checks";

export const AG_LOOP_LOG_NAMES: readonly AgLoopLogName[] = Object.freeze([
  "claude",
  "orchestrator",
  "checks",
]);

/**
 * Gateway bounds, all narrower than the AG Loop UI's own. They live on the port
 * because the router validates the request against them and the adapter clamps
 * the upstream answer to them — the same number must govern both sides.
 */
export const AG_LOOP_LOG_LINE_LIMIT = 200;
export const AG_LOOP_LOG_LINE_DEFAULT = 100;
export const AG_LOOP_LOG_LINE_CHAR_LIMIT = 4096;
export const AG_LOOP_TOKEN_USAGE_LIMIT = 500;
export const AG_LOOP_TOKEN_USAGE_DEFAULT = 100;

export type AgLoopLogs = Readonly<{
  log: AgLoopLogName;
  lines: readonly string[];
  truncated: boolean;
}>;

export type AgLoopTokenUsageRecord = Readonly<{
  ts: string;
  phase: string;
  taskId: string;
  model: string;
  attempt: number | null;
  outcome: "succeeded" | "failed" | "infrastructure" | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  totalCostUsd: number;
}>;

export type AgLoopTokenUsage = Readonly<{ records: readonly AgLoopTokenUsageRecord[] }>;

export type AgLoopTokenBucket = Readonly<{ key: string; totalTokens: number }>;

export type AgLoopTokenAnalyticsSnapshot = Readonly<{
  generatedAt: string;
  totals: Readonly<{ records: number; totalTokens: number; uniqueTasks: number }>;
  tokensByPhase: readonly AgLoopTokenBucket[];
  tokensByModel: readonly AgLoopTokenBucket[];
  tokensByDay: readonly AgLoopTokenBucket[];
  cacheHitRate: number;
  repairShare: number;
}>;

export type AgLoopOptimizationCandidate = Readonly<{
  taskId: string;
  familyKey: string;
  taskTokens: number;
  groupMedianTokens: number;
  multiplier: number;
  reasonHint: string;
}>;

/**
 * Only the newest snapshot travels: the upstream history is unbounded and a
 * phone renders the current picture, not an archive.
 */
export type AgLoopTokenAnalytics = Readonly<{
  candidates: readonly AgLoopOptimizationCandidate[];
  latestSnapshot: AgLoopTokenAnalyticsSnapshot | null;
}>;

/**
 * A policy control as the phone may see it: an identity, a label and the current
 * value. `route`, `source`, `editable` and any pending proposal stay on the host
 * — they are the vocabulary of mutation, and this channel has none.
 */
export type AgLoopPolicyControl = Readonly<{
  id: string;
  label: string;
  value: string | number | boolean | null;
}>;

export type AgLoopPolicyGroup = Readonly<{
  id: string;
  label: string;
  controls: readonly AgLoopPolicyControl[];
}>;

export type AgLoopPolicyControls = Readonly<{ groups: readonly AgLoopPolicyGroup[] }>;

export type AgLoopLearningRecommendation = Readonly<{
  id: string;
  status: "pending" | "approved" | "rejected";
  summary: string;
  labels: readonly string[];
}>;

export type AgLoopLearningSummary = Readonly<{
  records: number;
  byType: Readonly<Record<string, number>>;
  pendingRecommendations: number;
  approvedRecommendations: number;
  rejectedRecommendations: number;
}>;

export type AgLoopLearning = Readonly<{
  summary: AgLoopLearningSummary;
  recommendations: readonly AgLoopLearningRecommendation[];
}>;

/** Sanitized projection of the upstream `AgentActivity` SSE payload. */
export type AgLoopActivity = Readonly<{
  chain: readonly string[];
  statuses: Readonly<Record<string, string>>;
  currentAgent: string | null;
  currentActivity: string | null;
  taskId: string | null;
  claudeStatus: string | null;
  mode: "subagents" | "inline" | "idle";
  updatedAt: string;
}>;

/**
 * Stream element. `keepalive` carries no data and exists so the interface layer
 * can keep an idle connection observably alive without inventing an event: a
 * silent SSE channel is indistinguishable from a dead socket.
 */
export type AgLoopStreamMessage =
  | Readonly<{ type: "activity"; activity: AgLoopActivity }>
  | Readonly<{ type: "keepalive" }>;

/**
 * Read-only view of one project's AG Loop UI.
 *
 * Every method is a read by construction. There is deliberately no mutation
 * member — `design.md` §10 makes "mobile cannot drive AG Loop" a property of the
 * contract, not of the current implementation of it.
 */
export interface AgLoopUiReadPort {
  dashboard(): Promise<AgLoopDashboard>;
  taskBucket(bucket: string): Promise<AgLoopTaskBucket>;
  logs(log: AgLoopLogName, lines: number): Promise<AgLoopLogs>;
  tokenUsage(limit: number): Promise<AgLoopTokenUsage>;
  tokenAnalytics(): Promise<AgLoopTokenAnalytics>;
  policyControls(): Promise<AgLoopPolicyControls>;
  learning(): Promise<AgLoopLearning>;
  /**
   * Sanitized activity stream that reconnects to the upstream SSE channel on its
   * own and ends when `signal` aborts. Each element is a complete snapshot, so a
   * reconnecting consumer needs no replay to be current again.
   */
  activityStream(signal: AbortSignal): AsyncIterable<AgLoopStreamMessage>;
}
