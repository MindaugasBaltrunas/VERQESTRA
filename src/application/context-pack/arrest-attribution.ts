// Failure attribution for the canary arrest kill switch (task 0037). Behaviour etalon:
// AG_loop application/context-pack/arrest-attribution.ts (1:1; exit kodų sąrašo savininkas —
// shared/exit-codes).
//
// The human-review arrest trigger counts canary-cohort tasks that ended in `human-review`
// and arrests the feature at K of them. It never asked WHY the task ended there. A cohort
// task parked by a lease conflict, an evidence gate, a preflight-format failure, a git
// conflict or a worker timeout raised the counter exactly as much as one whose worker lost
// the context the compiled prompt dropped — and because every feature shares one cohort,
// that same task became evidence against several features at once.
//
// 2026-08-15, live: "CANARY ARRESTED ... 116 canary-cohort task(s) ended in human-review",
// while the features were ALREADY arrested, i.e. those tasks dispatched RAW. Compression
// could not physically have caused a single one of them.
//
// This module is the deterministic answer: no LLM, no heuristics over free-form output, just
// a fixed signature table over the fields a task-event already carries (`phase`, `reason`,
// `exit_code`) plus how the dispatch actually went out (`compiled` vs `raw-fallback`).
//
// The bias is one-directional on purpose: anything not positively consistent with context
// loss stays OUT of the arrest counter. A false `unrelated` costs a slower arrest; a false
// `compression-suspected` costs a feature killed for someone else's defect.
//
// Pure: no clock, no I/O, no config.

import { isInfrastructureExitCode } from "../../shared/exit-codes.js";

/**
 * What the dispatch actually sent for a canary-cohort task.
 *
 * - `compiled`: the compressed body reached the worker, so compression is at least *able* to
 *   be the cause of what happened next.
 * - `raw-fallback`: the whole raw task went out — the size guard refused the compiled body,
 *   or the feature was already arrested. Compression was not in the prompt, so it cannot be
 *   in the failure.
 */
export type CompressionEffect = "compiled" | "raw-fallback";

export const COMPRESSION_EFFECTS: readonly CompressionEffect[] = ["compiled", "raw-fallback"];

/**
 * Why a canary-cohort task ended in human-review, as far as a deterministic reading can tell.
 *
 * - `unrelated`: a recognised non-compression signature. Real human cost, but not evidence
 *   about compression — reported as a warning, never counted toward an arrest.
 * - `compression-suspected`: the compiled body went out AND the failure signature is
 *   consistent with lost context. The only class that feeds the kill switch.
 * - `compression-proven`: reserved for direct evidence (compiled-vs-raw parity failure on the
 *   same task). Nothing populates it yet; the slot already counts.
 *
 * `null` is not a member: it is the ABSENCE of an attribution (see {@link AttributionVerdict}).
 */
export type FailureAttribution = "unrelated" | "compression-suspected" | "compression-proven";

/**
 * The additive fields a canary-cohort task-outcome record carries from this change on.
 */
export type CanaryTaskOutcomeFields = {
  /** Real compression feature names applied to this dispatch. Never the size-fallback marker. */
  compression_applied: string[];
  compression_effect: CompressionEffect;
  /** Pipeline phase the task failed in (`preflight`, `dispatch`, `diagnosis`, ...); `null` when unrecorded. */
  failure_phase: string | null;
  /** `null` = unattributed: no attribution could be made, NOT "attributed to nothing". */
  failure_attribution: FailureAttribution | null;
};

/** Everything {@link attributeFailure} is allowed to look at. Every field optional: a legacy
 *  record carries none of them, and that absence is itself the classification input. */
export type CanaryFailureEvidence = {
  compression_applied?: readonly string[] | undefined;
  /** Deliberately `string`, not {@link CompressionEffect}: an unreadable value must reach the
   *  legacy branch rather than be narrowed away at the type level and then trusted. */
  compression_effect?: string | undefined;
  failure_phase?: string | null | undefined;
  /** The task-event `reason`, verbatim (e.g. `preflight_failed=2`, `TASK NOT DONE: ...`). */
  failure_reason?: string | undefined;
  exit_code?: number | undefined;
};

export type AttributionVerdict = {
  attribution: FailureAttribution | null;
  /**
   * The rule that decided it, named so the report can say WHY a human-review outcome was or
   * was not counted. A bucket without this is the same opaque number this task removed.
   */
  rule: string;
};

/** The record predates this change: without `compression_effect` there is no way to know
 *  whether the compiled body even went out, so no attribution is honest. */
export const LEGACY_RULE = "legacy-missing-attribution-fields";

/** The compiled body went out, the signature is readable, and nothing in either table matches. */
export const UNCLASSIFIED_RULE = "unclassified-failure-signature";

/**
 * Failure signatures that belong to the loop's own machinery, not to the task's prompt.
 *
 * Matched case-insensitively as substrings of `phase` + `reason` — the two fields the
 * orchestrator writes itself, never worker prose — so the same event always classifies the
 * same way. `detail` is deliberately excluded: it is a 2 000-char captured output tail.
 */
export const INFRA_FAILURE_SIGNATURES: readonly string[] = [
  // Dispatch/preflight machinery.
  "infra_abort",
  "preflight_failed",
  "preflight_retry_without_change",
  "preflight-retry-guard",
  "corrupted_decision_json",
  // Task 041-a: svetimo sprendimo nuosavybės gedimas — atskirtas nuo corrupted, bet ta pati
  // loop mašinerijos, ne prompt'o, klasė.
  "foreign_decision_task_id",
  "adapter_not_allowed",
  "context_pack_failed",
  "budget_enforcement_failed",
  "budget-governance",
  "dispatch_refused",
  "rollback_failed",
  "retry_limit",
  "policy_config",
  "duplicate",
  // Evidence / quality gates — the 0023-0026 defect class that produced most of the 116.
  "work evidence",
  "work-evidence",
  "quality_gates_failed",
  "skip_dispatch_rejected",
  "did not create a new commit",
  "no verified product changes",
  // Concurrency and worktree infrastructure.
  "lease",
  "scope lock",
  "scope_lock",
  "worktree",
  "branch-blocked",
  "dirty-tree",
  // Environment / filesystem.
  "ebusy",
  "eperm",
  "eacces",
  "enoent",
  "stale dist",
  "usage limit",
  "usage_limit",
];

/**
 * Failure signatures consistent with the worker having lost context the raw task carried.
 *
 * Only these, and only under `compiled`, can arrest a feature. The list is deliberately short:
 * each entry names a way the worker demonstrably worked from an incomplete picture of the task.
 */
export const CONTEXT_LOSS_SIGNATURES: readonly string[] = [
  "out-of-scope",
  "out_of_scope",
  "out of scope",
  "allowed_paths",
  "forbidden_path",
  "scope_violation",
  "acceptance",
  "acceptance_criteria",
  "stop_condition",
];

function matchSignature(haystack: string, table: readonly string[]): string | undefined {
  return table.find((token) => haystack.includes(token));
}

/** `phase` + `reason`, lowercased, as one searchable string. Both are orchestrator-written. */
function signatureText(evidence: CanaryFailureEvidence): string {
  return `${evidence.failure_phase ?? ""} ${evidence.failure_reason ?? ""}`.toLowerCase();
}

function isCompressionEffect(value: string | undefined): value is CompressionEffect {
  return value !== undefined && (COMPRESSION_EFFECTS as readonly string[]).includes(value);
}

/**
 * Classifies one canary-cohort human-review outcome. Deterministic, total, and pure.
 *
 * Rule order is the contract, not an implementation detail: an outcome that matches both
 * tables reads as `unrelated`, because a recognised infrastructure signature is a POSITIVE
 * fact about the cause while a context-loss token is only a consistency argument. The
 * conservative direction is always "do not arrest".
 */
export function attributeFailure(evidence: CanaryFailureEvidence): AttributionVerdict {
  if (!isCompressionEffect(evidence.compression_effect)) {
    return { attribution: null, rule: LEGACY_RULE };
  }
  if (evidence.compression_effect === "raw-fallback") {
    // The raw task went out: the size guard refused the compiled body, or the feature was
    // already arrested. Whatever happened next, compression was not in the prompt.
    return { attribution: "unrelated", rule: "raw-fallback-execution" };
  }
  if ((evidence.compression_applied ?? []).length === 0) {
    // `compiled` with no feature applied is the control path wearing a canary label — there
    // is no treatment here to hold responsible.
    return { attribution: "unrelated", rule: "no-compression-applied" };
  }
  if (evidence.exit_code !== undefined && isInfrastructureExitCode(evidence.exit_code)) {
    // shared/exit-codes owns this list. Re-listing the numbers here would let the two drift
    // into disagreeing about the same code.
    return { attribution: "unrelated", rule: `infra-exit-${evidence.exit_code}` };
  }

  const text = signatureText(evidence);
  const infra = matchSignature(text, INFRA_FAILURE_SIGNATURES);
  if (infra !== undefined) {
    return { attribution: "unrelated", rule: `infra-signature:${infra}` };
  }
  const contextLoss = matchSignature(text, CONTEXT_LOSS_SIGNATURES);
  if (contextLoss !== undefined) {
    return { attribution: "compression-suspected", rule: `context-loss-signature:${contextLoss}` };
  }
  // Readable fields, no matching signature. Not `unrelated` (that would claim a
  // non-compression cause nothing established) and not `suspected` (nothing points at
  // context loss). Unattributed, named as such, and not counted.
  return { attribution: null, rule: UNCLASSIFIED_RULE };
}

/**
 * Whether an attribution may raise the feature-level auto-arrest counter.
 *
 * The single place the kill-switch input is defined. `unrelated` and `null` are warning
 * statistics: visible to the operator, never a kill signal.
 */
export function isArrestCountableAttribution(attribution: FailureAttribution | null): boolean {
  return attribution === "compression-suspected" || attribution === "compression-proven";
}

/** One canary-cohort task's human-review outcome, attributed. */
export type AttributedCanaryOutcome = CanaryTaskOutcomeFields & {
  task_id: string;
  /** Which rule produced {@link CanaryTaskOutcomeFields.failure_attribution}. */
  attribution_rule: string;
};

/**
 * Attaches the four additive fields to one outcome, resolving the attribution.
 *
 * `compression_applied` is normalised here rather than trusted: the caller reads it out of a
 * JSONL line, and a blank or non-string entry must not be able to make an empty feature list
 * look populated (which would move an outcome off the `no-compression-applied` rule).
 */
export function attributeCanaryOutcome(input: {
  taskId: string;
  compressionApplied?: readonly string[] | undefined;
  compressionEffect?: string | undefined;
  failurePhase?: string | null | undefined;
  failureReason?: string | undefined;
  exitCode?: number | undefined;
}): AttributedCanaryOutcome {
  const applied = (input.compressionApplied ?? [])
    .filter((feature): feature is string => typeof feature === "string")
    .map((feature) => feature.trim())
    .filter((feature) => feature.length > 0);
  const verdict = attributeFailure({
    compression_applied: applied,
    compression_effect: input.compressionEffect,
    failure_phase: input.failurePhase,
    failure_reason: input.failureReason,
    exit_code: input.exitCode,
  });
  return {
    task_id: input.taskId,
    compression_applied: applied,
    // A record that reached the legacy branch has no readable effect; the field still has to
    // hold one of the two values, and `raw-fallback` is the reading that cannot arrest.
    compression_effect: isCompressionEffect(input.compressionEffect) ? input.compressionEffect : "raw-fallback",
    failure_phase: input.failurePhase ?? null,
    failure_attribution: verdict.attribution,
    attribution_rule: verdict.rule,
  };
}

/**
 * The arrest counter's input: the task ids whose human-review outcome is attributable to
 * compression.
 *
 * Same shape as the raw cohort selector's output, filtered by evidence. Ids are returned once
 * each, in input order, so the counter cannot be raised twice by the same task appearing under
 * two features.
 */
export function selectArrestCountableHumanReviewTaskIds(outcomes: readonly AttributedCanaryOutcome[]): string[] {
  const counted = new Set<string>();
  for (const outcome of outcomes) {
    if (!isArrestCountableAttribution(outcome.failure_attribution)) continue;
    if (outcome.task_id.trim() === "") continue;
    counted.add(outcome.task_id);
  }
  return [...counted];
}
