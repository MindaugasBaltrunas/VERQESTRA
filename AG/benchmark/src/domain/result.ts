import type { CompressionFeature, CompressionHookProfile } from "./compression/features.js";

/**
 * Sample contract (BENCH-4, BENCH-5, BENCH-6).
 *
 * One sample is one `scenario × mode × repetition`, taken under one compression
 * variant. Every field an aggregate is later computed from lives here, because a
 * metric may never be reconstructed from prose an agent wrote about itself.
 */

/**
 * The three comparable ways of executing the same scenario (BENCH-3): the full
 * AG Loop, the same agent without the loop, and a deterministic control that
 * calls no model at all and therefore bounds what the measurement itself costs.
 */
export const EXECUTION_MODES = ["ag-loop", "agent-solo", "deterministic-control"] as const;

export type ExecutionMode = (typeof EXECUTION_MODES)[number];

export const CHECK_STATUSES = ["passed", "failed", "skipped", "errored"] as const;

export type CheckStatus = (typeof CHECK_STATUSES)[number];

/**
 * The class a failed check belongs to. Kept separate from the check id because
 * BENCH-7 reports test, architecture and security failure rates independently.
 */
export const CHECK_KINDS = ["test", "architecture", "security", "build", "other"] as const;

export type CheckKind = (typeof CHECK_KINDS)[number];

export interface CheckResult {
  readonly id: string;
  readonly kind: CheckKind;
  readonly status: CheckStatus;
  readonly durationMs: number;
}

/**
 * `verified-accepted` is the only success value and it is the verifier's word,
 * not the agent's (BENCH-6). `inconclusive` covers a sample whose evidence is
 * incomplete or corrupt — BENCH-5 forbids dropping such a sample silently.
 */
export const ACCEPTANCE_VERDICTS = ["verified-accepted", "rejected", "inconclusive"] as const;

export type AcceptanceVerdict = (typeof ACCEPTANCE_VERDICTS)[number];

export interface AcceptanceDecision {
  readonly verdict: AcceptanceVerdict;
  /** Machine-readable reason codes; anything other than `verified-accepted` carries at least one. */
  readonly reasons: readonly string[];
  /** True only when the agent itself claimed success — recorded to measure the gap, never to grant it. */
  readonly agentClaimedDone: boolean;
}

/** Cost evidence (BENCH-5). Token counts are reported by the adapter, not estimated. */
export interface SampleTelemetry {
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly llmCalls: number;
  readonly attempts: number;
  readonly repairs: number;
  readonly humanReviewEvents: number;
}

export const WORKTREE_CLEANUP_RESULTS = ["removed", "kept-for-diagnosis", "failed"] as const;

export type WorktreeCleanupResult = (typeof WORKTREE_CLEANUP_RESULTS)[number];

/** Isolation evidence (BENCH-4): what the run started from, what it changed, what was left behind. */
export interface SampleWorkspaceRecord {
  readonly startCommit: string;
  readonly endCommit: string;
  readonly changedFiles: readonly string[];
  /** Changed files outside the scenario's allowed paths — the out-of-scope rate's numerator. */
  readonly outOfScopeFiles: readonly string[];
  readonly cleanup: WorktreeCleanupResult;
}

/**
 * Where a usage record's counts came from.
 *
 * Two producers are permitted and one field holds their answer, so the sample
 * has to say which of them wrote it. `envelope` is the agent's own stdout
 * record; `run-log` is derived by an adapter from the isolated worktree's own
 * `vq/logs/token-usage.jsonl`, a documented AG log contract. Precedence is
 * fixed: an envelope block wins, and a run log is read only when no envelope
 * carried one — so a reader can always say where a number came from instead of
 * guessing which producer was active.
 */
export const USAGE_SOURCES = ["envelope", "run-log"] as const;

export type UsageSource = (typeof USAGE_SOURCES)[number];

/**
 * How a turn count was arrived at. A count the agent reported for itself and one
 * counted from dispatch attempts are both usable and are not the same
 * measurement, so the sample records which it holds rather than averaging two
 * different definitions together.
 */
export const TURNS_SOURCES = ["recorded", "dispatch-attempts"] as const;

export type TurnsSource = (typeof TURNS_SOURCES)[number];

/**
 * Cost detail {@link SampleTelemetry} does not carry (task 0029).
 *
 * `inputTokens` and `outputTokens` stay `telemetry`'s required fields and stay
 * the only place they are written; this record adds what `telemetry` lacks, so
 * no number exists twice and no reconciliation rule is needed. Absent means the
 * run never reported this detail — it is never filled in with zeros, which would
 * average in as a variant that ran for free.
 */
export interface SampleUsageRecord {
  readonly source: UsageSource;
  /**
   * `false` means the model ran but accounting failed. Every count below is then
   * absent, and a population containing such a sample may not have its tokens
   * summed at all: the missing tokens were spent, and leaving them out would
   * understate exactly the variant whose accounting a change broke.
   */
  readonly captured: boolean;
  readonly cacheReadInputTokens?: number;
  readonly cacheCreationInputTokens?: number;
  readonly numTurns?: number;
  readonly turnsSource?: TurnsSource;
}

/**
 * Character counters observed while a compressed run was assembled.
 *
 * Diagnostics only. They say how much text a compression path removed, which is
 * useful to a reader and is not evidence that anything got cheaper: characters
 * are not tokens, this package has no tokeniser, and a path that halves a prompt
 * while doubling the turns is more expensive. They may never enter the KPI or a
 * verdict, and `compression-verdict.test.ts` holds that rule.
 */
export interface SampleCompressionDiagnostics {
  readonly rawTaskChars?: number;
  readonly compiledTaskChars?: number;
  readonly workerPromptChars?: number;
  readonly symbolSourceChars?: number;
  readonly symbolSignatureChars?: number;
  readonly toolRawChars?: number;
  readonly toolDigestChars?: number;
}

/**
 * The compression variant a sample belongs to, recorded beside `mode` rather
 * than inside it (task 0029).
 *
 * Both the id and the identity are stored: the id is what a report row is
 * labelled with, the identity is what a population is keyed by. The features and
 * the hook profile are stored too, so a sample stays readable — and its identity
 * re-derivable — by a build whose cohort has since changed.
 */
export interface SampleCompressionRecord {
  readonly variantId: string;
  /** `sha256:` followed by sixty-four hex characters. */
  readonly variantIdentity: string;
  readonly features: readonly CompressionFeature[];
  readonly hookProfile: CompressionHookProfile;
  readonly diagnostics?: SampleCompressionDiagnostics;
}

/**
 * The shape version of one stored run result. It rides on every sample rather
 * than on the file holding them: samples are appended one line at a time across
 * runs, so a line has to say for itself which schema it was written under.
 *
 * Version 2 added the optional `usage` and `compression` blocks. The bump was
 * necessary rather than cosmetic: a reader that ignored `compression` would fold
 * baseline and variant samples into one population and publish the average as a
 * comparison, and the version is the guard that makes that impossible.
 */
export const BENCHMARK_SAMPLE_SCHEMA_VERSION = 2;

/**
 * Versions a stored line may be written under. Version 1 stays readable — a
 * ledger is appended to across months and cannot be rewritten — but a v1 line
 * carrying a v2 block is refused, because the presence of a field that did not
 * exist yet means the writer's own version claim is false.
 */
export const SUPPORTED_BENCHMARK_SAMPLE_SCHEMA_VERSIONS = [1, 2] as const;

/**
 * One stored run result — the record BENCH-5 requires every execution to leave
 * behind, and the only thing an aggregate may be computed from.
 */
export interface BenchmarkSample {
  readonly schemaVersion: number;
  readonly sampleId: string;
  readonly scenarioId: string;
  readonly mode: ExecutionMode;
  /** 1-based; BENCH-9 requires at least three for nondeterministic scenarios. */
  readonly repetition: number;
  readonly startedAt: string;
  readonly durationMs: number;
  readonly telemetry: SampleTelemetry;
  readonly checks: readonly CheckResult[];
  readonly workspace: SampleWorkspaceRecord;
  readonly acceptance: AcceptanceDecision;
  /** Absent on every v1 sample, and on a v2 sample whose adapter reported no usage detail. */
  readonly usage?: SampleUsageRecord;
  /** Absent when the run belongs to no declared variant; such a sample enters no compression aggregate. */
  readonly compression?: SampleCompressionRecord;
}
