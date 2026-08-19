// Enforcement strength for a governed rule (architecture-style strictness, each coding
// principle). Pure, dependency-free: the zod schema in a later layer must MIRROR this
// union, never own it. Behaviour etalon: AG_loop domain/policies/enforcement-level.ts.

export type EnforcementLevel = "advisory" | "warn" | "block";

/** The full, ordered set of valid enforcement levels — the single "what counts as a level". */
export const ENFORCEMENT_LEVELS: EnforcementLevel[] = ["advisory", "warn", "block"];

export function isEnforcementLevel(value: unknown): value is EnforcementLevel {
  return typeof value === "string" && (ENFORCEMENT_LEVELS as string[]).includes(value);
}

export function normalizeEnforcementLevel(value: unknown): EnforcementLevel | undefined {
  return isEnforcementLevel(value) ? value : undefined;
}

/**
 * Strength of evidence that a violation already exists: `possible` is a weak signal
 * (e.g. a task-text mention), `confirmed` a real, actionable match. No `none` here —
 * `decideEnforcement` is only invoked once a violation has already been produced.
 */
export type EnforcementEvidenceLevel = "possible" | "confirmed";

export type EnforcementVerdict = {
  effect: "none" | "review" | "block";
  reason_kind: "confirmed" | "possible" | "none";
};

/**
 * Level × evidence → effect. `advisory` never has any effect; `possible` evidence never
 * blocks outright (downgrades to `review` even under `block` — a partial signal must not
 * hard-fail a task); `confirmed` follows the configured level as-is.
 */
export function decideEnforcement(level: EnforcementLevel, evidence: EnforcementEvidenceLevel): EnforcementVerdict {
  if (level === "advisory") return { effect: "none", reason_kind: "none" };
  if (evidence === "possible") return { effect: "review", reason_kind: "possible" };
  return level === "block"
    ? { effect: "block", reason_kind: "confirmed" }
    : { effect: "review", reason_kind: "confirmed" };
}
