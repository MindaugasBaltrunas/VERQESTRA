import type { BenchmarkScenario } from "../../domain/scenario.js";
import type { AcceptanceDecision, CheckResult } from "../../domain/result.js";
import type { IsolatedWorktree } from "./worktree-port.js";

export interface AcceptanceVerificationRequest {
  readonly scenario: BenchmarkScenario;
  readonly worktree: IsolatedWorktree;
  readonly changedFiles: readonly string[];
  readonly agentClaimedDone: boolean;
}

export interface AcceptanceVerification {
  readonly checks: readonly CheckResult[];
  readonly outOfScopeFiles: readonly string[];
  readonly decision: AcceptanceDecision;
}

/**
 * The independent verifier (BENCH-6).
 *
 * It re-runs the declared checks itself rather than reading the agent's report,
 * so a `verified-accepted` decision means: a non-empty change, the declared
 * checks passing, scope respected, and the factual outcome matching the
 * scenario's expected outcome.
 */
export interface AcceptanceVerifierPort {
  verify(request: AcceptanceVerificationRequest): Promise<AcceptanceVerification>;
}
