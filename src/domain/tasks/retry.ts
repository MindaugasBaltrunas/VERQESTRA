// Pure retry-state rules for the task lifecycle: from an attempt count, may a task spend
// another repair dispatch? Behaviour etalon: AG_loop domain/tasks/retry.ts, pinned by the
// diagnosis-dispositions fixture's escalation semantics and the ported unit tests.
//
// WBR VQ-201 cycle inversion: DEFAULT_MAX_RETRY_ATTEMPTS is DEFINED here (it is the rule),
// not imported from a schema module — config schemas must satisfy this value, not own it.

/**
 * Canonical semantics (F8): `max` is the repair DISPATCH budget for one task_id. `count`
 * means "repair dispatches already made, INCLUDING the one being evaluated" and the limit
 * is reached at `count === max`, so a task gets at most `max - 1` repair dispatches
 * (2 with the default of 3) before human-review. Any human-facing text must quote
 * `max - 1`, not `max`.
 */
export const DEFAULT_MAX_RETRY_ATTEMPTS = 3;

export type RetryLimitDecision = {
  reached: boolean;
  count: number;
  max: number;
  remaining: number;
};

export function normalizeMaxRetryAttempts(value: unknown, fallback = DEFAULT_MAX_RETRY_ATTEMPTS): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number.parseInt(value, 10) : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function evaluateRetryLimit(attempts: number, maxAttempts: number): RetryLimitDecision {
  const count = Number.isFinite(attempts) && attempts > 0 ? Math.floor(attempts) : 0;
  const max = normalizeMaxRetryAttempts(maxAttempts);
  return {
    reached: count >= max,
    count,
    max,
    remaining: Math.max(0, max - count),
  };
}

export type RepeatedErrorEscalation = {
  escalate: boolean;
  reason: string;
};

/** Normalizes volatile locations, durations and ANSI codes without erasing error kinds. */
export function normalizeErrorSignature(signature: string): string {
  return signature
    .replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"), "")
    .replace(/\bline\s+\d+\b/gi, "line <n>")
    .replace(/:\d+(?::\d+)?\b/g, ":<loc>")
    .replace(/\b\d+(?:\.\d+)?\s*ms\b/gi, "<duration>")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * F9: when a repair's error signature is identical to the previous repair dispatch's, the
 * repair did not fix the failure — escalate to human-review instead of spending another
 * bounded repair dispatch on the same error.
 */
export function evaluateRepeatedErrorEscalation(
  currentSignature: string,
  previousSignature: string | undefined,
): RepeatedErrorEscalation {
  const current = normalizeErrorSignature(currentSignature);
  const previous = normalizeErrorSignature(previousSignature ?? "");
  if (current && previous && current === previous) {
    return { escalate: true, reason: `repeated error signature: ${current}` };
  }
  return { escalate: false, reason: "" };
}
