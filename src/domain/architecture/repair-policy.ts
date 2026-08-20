// Architektūros mazgo repair politika (etalonas: AG_loop architecture/
// architecture-repair-policy.ts 1:1, WBR VQ-501 3/5-c). GRYNOS taisyklės — jokio IO:
// verifyNode failure tekstai deterministiškai žemėlapiuojami į issue rūšį, o bandymų
// skaitliukas riboja automatinį repair iki MAX_ATTEMPTS prieš human-review.

import type { ArchitectureNodeProgress } from "./graph.js";

export type RepairableIssueKind =
  | "missing-evidence"
  | "unclear-interface"
  | "stale-code-index"
  | "oversized-node"
  | "missing-test-target"
  | "missing-upstream-stub"
  | "incomplete-context-pack"
  | "weak-task-boundary";

export type RepairDecision = {
  action: "repair" | "human-review";
  reason: string;
  updated_attempts: Record<string, number>;
};

export const REPAIRABLE_ISSUES: ReadonlySet<RepairableIssueKind> = new Set([
  "missing-evidence",
  "unclear-interface",
  "stale-code-index",
  "oversized-node",
  "missing-test-target",
  "missing-upstream-stub",
  "incomplete-context-pack",
  "weak-task-boundary",
]);

const MAX_ATTEMPTS = 3;

/**
 * Sentinel returned by {@link classifyRepairableIssue} when no repairable
 * failure pattern matches. It is intentionally NOT a member of
 * {@link REPAIRABLE_ISSUES}, so {@link evaluateRepairPolicy} routes it straight
 * to human-review.
 */
export const UNCLASSIFIED_ISSUE = "unclassified";

/**
 * AOD-01 lifecycle point (3): map the `failures` produced by `verifyNode`
 * onto a {@link RepairableIssueKind} so the verify-node failure path can drive
 * {@link evaluateRepairPolicy}.
 *
 * Deterministinis failure-pattern → issue-kind žemėlapis (pirmas atitikmuo pagal
 * prioritetą): forbidden path / dist → `governance-violation` (nerepair'inama);
 * „not found in progress ledger" → `unresolvable-node` (nerepair'inama);
 * „does not list ... as upstream" → `missing-upstream-stub`; „Required export ...
 * not found" → `unclear-interface`; „No test file found for" →
 * `missing-test-target`; „Implemented file does not exist" → `stale-code-index`;
 * visa kita → `unclassified`.
 *
 * Non-repairable (governance / structural) failures win over repairable ones:
 * a forbidden-path violation cannot be auto-repaired, so it must reach a human
 * even when a repairable failure is also present.
 */
export function classifyRepairableIssue(failures: string[]): string {
  // Non-repairable failures take precedence — they force human-review.
  for (const failure of failures) {
    if (/forbidden path|forbidden dist path/i.test(failure)) return "governance-violation";
    if (/not found in progress ledger/i.test(failure)) return "unresolvable-node";
  }

  const repairablePatterns: Array<[RegExp, RepairableIssueKind]> = [
    [/does not list .* as upstream/i, "missing-upstream-stub"],
    [/Required export .* not found/i, "unclear-interface"],
    [/No test file found for/i, "missing-test-target"],
    [/Implemented file does not exist/i, "stale-code-index"],
  ];
  for (const [pattern, kind] of repairablePatterns) {
    if (failures.some((failure) => pattern.test(failure))) return kind;
  }

  return UNCLASSIFIED_ISSUE;
}

export function evaluateRepairPolicy(nodeProgress: ArchitectureNodeProgress, issueKind: string): RepairDecision {
  const updated_attempts = { ...nodeProgress.attempts };

  if (!REPAIRABLE_ISSUES.has(issueKind as RepairableIssueKind)) {
    return {
      action: "human-review",
      reason: `Issue kind "${issueKind}" is not repairable automatically.`,
      updated_attempts,
    };
  }

  const current = nodeProgress.attempts[issueKind] ?? 0;

  if (current >= MAX_ATTEMPTS) {
    return {
      action: "human-review",
      reason: `Issue "${issueKind}" has reached the maximum of ${MAX_ATTEMPTS} repair attempts.`,
      updated_attempts,
    };
  }

  updated_attempts[issueKind] = current + 1;

  return {
    action: "repair",
    reason: `Attempt ${current + 1} of ${MAX_ATTEMPTS} for "${issueKind}".`,
    updated_attempts,
  };
}
