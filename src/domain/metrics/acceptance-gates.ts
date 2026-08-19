// „Verified accepted change" priėmimo vartai (BENCH-2) ir tokens-per-accepted metrika.
// Pure. Behaviour etalon: AG_loop domain/metrics/accepted-change.ts (acceptance pusė;
// WBR VQ-204 skaidymas).

import { round2 } from "../../shared/numbers.js";

/**
 * The four acceptance gates that must all pass before a task counts as one *verified accepted
 * change*. The list is deliberately conservative: a task that we cannot prove was accepted is
 * never counted, so the denominator of `tokens_per_verified_accepted_change` can only be
 * under-reported (making the metric look worse), never inflated.
 */
export const BENCHMARK_ACCEPTANCE_GATES = ["terminal_done", "no_human_review", "scope_clean", "work_evidence"] as const;
export type BenchmarkAcceptanceGateName = (typeof BENCHMARK_ACCEPTANCE_GATES)[number];

export type BenchmarkAcceptanceGate = {
  name: BenchmarkAcceptanceGateName;
  passed: boolean;
  detail: string;
};

export type BenchmarkAcceptanceVerdict = {
  accepted: boolean;
  reason: string;
  gates: BenchmarkAcceptanceGate[];
};

export type BenchmarkTerminalState = "done" | "human-review" | "error" | "duplicate" | "unknown";

export type TokensPerAcceptedChange = {
  total_tokens: number;
  accepted_changes: number;
  value: number | null;
  status: "computed" | "no_accepted_changes" | "no_usage";
  note: string;
};

export function evaluateAcceptance(input: {
  terminal_state: BenchmarkTerminalState;
  human_review_count: number;
  out_of_scope_files: string[];
  dispatch_attempts: number;
}): BenchmarkAcceptanceVerdict {
  const gates: BenchmarkAcceptanceGate[] = [
    {
      name: "terminal_done",
      passed: input.terminal_state === "done",
      detail: `terminal state: ${input.terminal_state}`,
    },
    {
      name: "no_human_review",
      passed: input.human_review_count === 0,
      detail: `${input.human_review_count} human-review event(s)`,
    },
    {
      name: "scope_clean",
      passed: input.out_of_scope_files.length === 0,
      detail: `${input.out_of_scope_files.length} out-of-scope file(s)`,
    },
    {
      name: "work_evidence",
      passed: input.dispatch_attempts >= 1,
      detail: "no dispatch usage recorded",
    },
  ];

  const failed = gates.filter((gate) => !gate.passed);
  return {
    accepted: failed.length === 0,
    reason: failed.length === 0 ? "verified accepted change" : failed.map((gate) => gate.detail).join("; "),
    gates,
  };
}

export function computeTokensPerVerifiedAcceptedChange(
  totalTokens: number,
  acceptedChanges: number,
): TokensPerAcceptedChange {
  if (totalTokens <= 0 && acceptedChanges === 0) {
    return {
      total_tokens: totalTokens,
      accepted_changes: acceptedChanges,
      value: null,
      status: "no_usage",
      note: "no usage records in the benchmark cohort",
    };
  }
  if (acceptedChanges === 0) {
    return {
      total_tokens: totalTokens,
      accepted_changes: acceptedChanges,
      value: null,
      status: "no_accepted_changes",
      note: "tokens spent without a verified accepted change",
    };
  }
  return {
    total_tokens: totalTokens,
    accepted_changes: acceptedChanges,
    value: round2(totalTokens / acceptedChanges),
    status: "computed",
    note: "",
  };
}
