// BENCH-2 palyginimo taisyklės: comparability sprendžiama PRIEŠ bet kokį delta skaičiavimą,
// kokybės regresija vertinama per task'ą, ir vienintelis kelias skelbti optimizacijos sėkmę —
// verdict `improved`. Pure. Behaviour etalon: AG_loop domain/metrics/accepted-change.ts
// (comparison pusė; WBR VQ-204 skaidymas; round2 — iš shared).

import { round2 } from "../../shared/numbers.js";
import type { BenchmarkTotals } from "./totals.js";
import type { TokensPerAcceptedChange } from "./acceptance-gates.js";

/** The comparable projection of a benchmark run — everything `compareBenchmarkRuns` needs. */
export type BenchmarkComparable = {
  config_hash: string;
  case_ids: string[];
  integrity_ok: boolean;
  totals: BenchmarkTotals;
  tokens_per_verified_accepted_change: TokensPerAcceptedChange;
};

export type BenchmarkComparisonVerdict = "improved" | "neutral" | "regressed" | "not_comparable";

export type BenchmarkComparison = {
  verdict: BenchmarkComparisonVerdict;
  comparable: boolean;
  reasons: string[];
  regression_limit_pct: number;
  token_delta_pct: number | null;
  /**
   * Tokenų pokytis VIENAM task'ui. Būtent juo remiasi regresijos vartai: `token_delta_pct`
   * (bendra suma) auga vien nuo didesnės imties ir apie efektyvumą nieko nesako.
   */
  token_per_task_delta_pct: number | null;
  tokens_per_accepted_delta_pct: number | null;
  accepted_change_delta: number;
  first_pass_rate_delta_pp: number | null;
  human_review_delta: number;
  /** Human-review įvykių pokytis vienam task'ui — kokybės verdikto pagrindas. */
  human_review_per_task_delta: number | null;
  out_of_scope_delta: number;
  /** Out-of-scope failų pokytis vienam task'ui — kokybės verdikto pagrindas. */
  out_of_scope_per_task_delta: number | null;
  exceeds_token_regression_limit: boolean;
};

/** Task'ų skaičius, kuriuo normalizuojami kokybės rodikliai: matuoti task'ai, o jų nesant — visi. */
function normalizationTaskCount(totals: BenchmarkTotals): number {
  return totals.measured_tasks > 0 ? totals.measured_tasks : totals.task_count;
}

/** Rodiklis vienam task'ui; `null`, kai imtis tuščia (dalyba iš nulio nėra „nulinis rodiklis"). */
function perTaskRate(value: number, totals: BenchmarkTotals): number | null {
  const tasks = normalizationTaskCount(totals);
  return tasks > 0 ? value / tasks : null;
}

/** Dviejų run'ų rodiklių skirtumas vienam task'ui; `null`, kai bent viena imtis tuščia. */
function perTaskDelta(
  baselineValue: number,
  baselineTotals: BenchmarkTotals,
  currentValue: number,
  currentTotals: BenchmarkTotals,
): number | null {
  const baselineRate = perTaskRate(baselineValue, baselineTotals);
  const currentRate = perTaskRate(currentValue, currentTotals);
  if (baselineRate === null || currentRate === null) return null;
  return round2(currentRate - baselineRate);
}

/**
 * BENCH-2: comparability is decided before any delta is computed. A run that is not comparable
 * yields `not_comparable`, never `improved` — a lower token count against a different frozen
 * config, a different case set or a run with integrity problems is not evidence of optimization.
 */
export function compareBenchmarkRuns(
  baseline: BenchmarkComparable,
  current: BenchmarkComparable,
  options: { maxTokenRegressionPct: number },
): BenchmarkComparison {
  const regressionLimitPct = options.maxTokenRegressionPct;
  const reasons: string[] = [];

  if (baseline.config_hash !== current.config_hash) {
    reasons.push(`config hash mismatch: baseline ${baseline.config_hash}, current ${current.config_hash}`);
  }
  const baselineCaseIds = [...baseline.case_ids].sort();
  const currentCaseIds = [...current.case_ids].sort();
  if (baselineCaseIds.join(",") !== currentCaseIds.join(",")) {
    reasons.push(
      `benchmark case set changed: baseline [${baselineCaseIds.join(", ")}], current [${currentCaseIds.join(", ")}]`,
    );
  }
  if (!baseline.integrity_ok) reasons.push("baseline integrity is not clean");
  if (!current.integrity_ok) reasons.push("current integrity is not clean");
  if (baseline.tokens_per_verified_accepted_change.status !== "computed") {
    reasons.push(`baseline metric unavailable: ${baseline.tokens_per_verified_accepted_change.status}`);
  }
  if (current.tokens_per_verified_accepted_change.status !== "computed") {
    reasons.push(`current metric unavailable: ${current.tokens_per_verified_accepted_change.status}`);
  }
  if (baseline.totals.usage.total_tokens <= 0) {
    reasons.push("baseline has no recorded token usage");
  }

  if (reasons.length > 0) {
    return {
      verdict: "not_comparable",
      comparable: false,
      reasons: reasons.sort(),
      regression_limit_pct: regressionLimitPct,
      token_delta_pct: null,
      token_per_task_delta_pct: null,
      tokens_per_accepted_delta_pct: null,
      accepted_change_delta: 0,
      first_pass_rate_delta_pp: null,
      human_review_delta: 0,
      human_review_per_task_delta: null,
      out_of_scope_delta: 0,
      out_of_scope_per_task_delta: null,
      exceeds_token_regression_limit: false,
    };
  }

  const baselineTokens = baseline.totals.usage.total_tokens;
  const currentTokens = current.totals.usage.total_tokens;
  const tokenDeltaPct = round2(((currentTokens - baselineTokens) / baselineTokens) * 100);

  const baselinePerAccepted = baseline.tokens_per_verified_accepted_change.value;
  const currentPerAccepted = current.tokens_per_verified_accepted_change.value;
  let tokensPerAcceptedDeltaPct: number | null = null;
  if (baselinePerAccepted === null || currentPerAccepted === null || baselinePerAccepted === 0) {
    reasons.push("baseline tokens per verified accepted change is zero; relative delta is undefined");
  } else {
    tokensPerAcceptedDeltaPct = round2(((currentPerAccepted - baselinePerAccepted) / baselinePerAccepted) * 100);
  }

  const baselineRate = baseline.totals.first_pass_rate;
  const currentRate = current.totals.first_pass_rate;
  const firstPassRateDeltaPp =
    baselineRate === null || currentRate === null ? null : round2((currentRate - baselineRate) * 100);

  const acceptedChangeDelta = current.totals.accepted_changes - baseline.totals.accepted_changes;

  // Kokybės regresija vertinama PER TASK'Ą, ne absoliučiais įvykių skaičiais. Absoliutus
  // palyginimas matuoja imties dydį, ne kokybę: 29 task'ų run'as prieš 3 task'ų baseline visada
  // turi daugiau human-review įvykių, todėl `qualityRegressed` buvo aritmetiškai priverstinis ir
  // joks optimizavimas negalėjo gauti kitokio verdikto nei `regressed` (2026-08-06 auditas).
  // Tie patys absoliutūs deltai lieka ataskaitoje — keičiasi tik tai, kuo remiasi SPRENDIMAS.
  const humanReviewDelta = current.totals.human_review_total - baseline.totals.human_review_total;
  const outOfScopeDelta = current.totals.out_of_scope_file_total - baseline.totals.out_of_scope_file_total;
  const humanReviewPerTaskDelta = perTaskDelta(
    baseline.totals.human_review_total,
    baseline.totals,
    current.totals.human_review_total,
    current.totals,
  );
  const outOfScopePerTaskDelta = perTaskDelta(
    baseline.totals.out_of_scope_file_total,
    baseline.totals,
    current.totals.out_of_scope_file_total,
    current.totals,
  );

  // Tokenų delta irgi per task'ą: bendra suma auga vien nuo didesnės imties.
  const baselineTokensPerTask = perTaskRate(baselineTokens, baseline.totals);
  const currentTokensPerTask = perTaskRate(currentTokens, current.totals);
  const tokenPerTaskDeltaPct =
    baselineTokensPerTask === null || currentTokensPerTask === null || baselineTokensPerTask === 0
      ? null
      : round2(((currentTokensPerTask - baselineTokensPerTask) / baselineTokensPerTask) * 100);
  const exceedsTokenRegressionLimit = tokenPerTaskDeltaPct !== null && tokenPerTaskDeltaPct > regressionLimitPct;

  const qualityImproved =
    (firstPassRateDeltaPp ?? 0) > 0 || (humanReviewPerTaskDelta ?? 0) < 0 || (outOfScopePerTaskDelta ?? 0) < 0;
  const qualityRegressed =
    (firstPassRateDeltaPp ?? 0) < 0 || (humanReviewPerTaskDelta ?? 0) > 0 || (outOfScopePerTaskDelta ?? 0) > 0;

  // A quality regression always changes the outcome (it forces `regressed` and blocks `improved`),
  // so it must name the metric that moved. Without this the operator sees a blocked
  // `--compare-baseline` with no way to tell which gate fell.
  if (qualityRegressed) {
    if ((firstPassRateDeltaPp ?? 0) < 0) {
      reasons.push(`first-pass rate fell ${Math.abs(firstPassRateDeltaPp ?? 0)} pp`);
    }
    if ((humanReviewPerTaskDelta ?? 0) > 0) {
      reasons.push(`human-review events per task rose by ${humanReviewPerTaskDelta} (absolute delta ${humanReviewDelta})`);
    }
    if ((outOfScopePerTaskDelta ?? 0) > 0) {
      reasons.push(`out-of-scope files per task rose by ${outOfScopePerTaskDelta} (absolute delta ${outOfScopeDelta})`);
    }
  }

  let verdict: BenchmarkComparisonVerdict;
  if (acceptedChangeDelta < 0) {
    // Fewer verified accepted changes can never be an improvement, however cheap the run was.
    reasons.push("fewer verified accepted changes than baseline");
    verdict = exceedsTokenRegressionLimit || qualityRegressed ? "regressed" : "neutral";
  } else if (qualityRegressed) {
    verdict = "regressed";
  } else if (exceedsTokenRegressionLimit && !qualityImproved) {
    reasons.push(
      `token usage per task grew ${tokenPerTaskDeltaPct}% (> ${regressionLimitPct}%) without first-pass or risk improvement`,
    );
    verdict = "regressed";
  } else if (tokensPerAcceptedDeltaPct !== null && tokensPerAcceptedDeltaPct < 0 && !qualityRegressed) {
    verdict = "improved";
  } else {
    verdict = "neutral";
  }

  return {
    verdict,
    comparable: true,
    reasons: reasons.sort(),
    regression_limit_pct: regressionLimitPct,
    token_delta_pct: tokenDeltaPct,
    token_per_task_delta_pct: tokenPerTaskDeltaPct,
    tokens_per_accepted_delta_pct: tokensPerAcceptedDeltaPct,
    accepted_change_delta: acceptedChangeDelta,
    first_pass_rate_delta_pp: firstPassRateDeltaPp,
    human_review_delta: humanReviewDelta,
    human_review_per_task_delta: humanReviewPerTaskDelta,
    out_of_scope_delta: outOfScopeDelta,
    out_of_scope_per_task_delta: outOfScopePerTaskDelta,
    exceeds_token_regression_limit: exceedsTokenRegressionLimit,
  };
}

/**
 * BENCH-2: the only path to declaring optimization success. Lower raw usage on its own is never
 * enough — the verdict must be `improved`, which requires a comparable run, no quality
 * regression and no loss of verified accepted changes.
 */
export function canDeclareOptimizationSuccess(comparison: BenchmarkComparison): { allowed: boolean; reason: string } {
  if (comparison.verdict === "improved") {
    return { allowed: true, reason: "tokens per verified accepted change improved without a quality regression" };
  }
  const detail = comparison.reasons.join("; ");
  const base = `optimization success cannot be declared: verdict=${comparison.verdict}`;
  return { allowed: false, reason: detail ? `${base}; ${detail}` : base };
}
