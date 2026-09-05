// Benchmark usage vienetai: telemetrijos įrašų struktūriniai tipai, tokenų sumavimo
// aritmetika ir kanoninė fazė. Pure — no node imports, no IO, no clock. Behaviour etalon:
// AG_loop domain/metrics/accepted-change.ts (usage pusė; WBR VQ-204 skaidymas).

import { classifyTaskUsageCall } from "../tokens/usage-ledger.js";

/** Minimal structural stand-in for the token-usage telemetry record. */
export type BenchmarkUsageEntry = {
  task_id: string;
  phase: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  total_cost_usd: number;
  attempt?: number;
  outcome?: "succeeded" | "failed" | "infrastructure";
  retry_reason?: string;
  /** Realus sesijos turn'ų skaičius, kai telemetrija jį užfiksavo (2026-08-06). */
  num_turns?: number;
};

/** Minimal structural stand-in for one task-events journal line. */
export type BenchmarkEventEntry = {
  task_id: string;
  to_state: string;
  reason: string;
  phase?: string;
  verdict?: string;
  exit_code?: number;
};

export type CanonicalBenchmarkPhase = "planning" | "preflight" | "dispatch" | "diagnose" | "other";

export type BenchmarkUsageTotals = {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  total_tokens: number;
  billable_tokens: number;
  total_cost_usd: number;
};

export type BenchmarkPhaseUsage = {
  phase: string;
  canonical_phase: CanonicalBenchmarkPhase;
  model: string;
  records: number;
  llm_calls: number;
  usage: BenchmarkUsageTotals;
};

export function emptyUsageTotals(): BenchmarkUsageTotals {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    total_tokens: 0,
    billable_tokens: 0,
    total_cost_usd: 0,
  };
}

/**
 * `total_tokens` is the benchmark's token basis (it includes cache reads, so context reuse is
 * visible); `billable_tokens` excludes cache reads and is reported alongside it for cost work.
 */
export function usageTotalsFromEntry(entry: BenchmarkUsageEntry): BenchmarkUsageTotals {
  const input = entry.input_tokens;
  const output = entry.output_tokens;
  const cacheRead = entry.cache_read_input_tokens;
  const cacheCreation = entry.cache_creation_input_tokens;
  return {
    input_tokens: input,
    output_tokens: output,
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheCreation,
    total_tokens: input + output + cacheRead + cacheCreation,
    billable_tokens: input + output + cacheCreation,
    total_cost_usd: entry.total_cost_usd,
  };
}

export function addUsageTotals(a: BenchmarkUsageTotals, b: BenchmarkUsageTotals): BenchmarkUsageTotals {
  return {
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
    cache_read_input_tokens: a.cache_read_input_tokens + b.cache_read_input_tokens,
    cache_creation_input_tokens: a.cache_creation_input_tokens + b.cache_creation_input_tokens,
    total_tokens: a.total_tokens + b.total_tokens,
    billable_tokens: a.billable_tokens + b.billable_tokens,
    total_cost_usd: a.total_cost_usd + b.total_cost_usd,
  };
}

/**
 * A usage record backed by a real, chargeable model call.
 *
 * Task 193 (auditas 2026-09-05, #28): the benchmark used to have its OWN definition —
 * "any model name that is not `none`" — so a 429/usage-limit record with zero usage counted
 * as an `llm_calls` unit while the ledger did not count it. Two definitions of "an LLM call"
 * in one codebase means the benchmark's cost-per-call figure could not be compared with the
 * ledger's. The definition source is `domain/tokens/usage-ledger.ts:108-112`
 * (`classifyTaskUsageCall`) and it is IMPORTED, not copied: a third copy is exactly what the
 * finding was about. `BenchmarkUsageEntry` satisfies the ledger's `TaskUsageEntry` structurally.
 *
 * Both directions of the inherited rule apply: a record with zero usage is `zero-usage` and no
 * longer counts, and a record with real usage but no model name counts (the ledger refuses to
 * read a missing model as deterministic — only an explicit `none` is).
 */
export function isLlmCall(entry: BenchmarkUsageEntry): boolean {
  return classifyTaskUsageCall(entry) === "model-call";
}

export function canonicalBenchmarkPhase(phase: string): CanonicalBenchmarkPhase {
  const normalized = phase.trim().toLowerCase();
  if (normalized.startsWith("preflight")) return "preflight";
  if (normalized.startsWith("dispatch")) return "dispatch";
  if (normalized.startsWith("diagnose")) return "diagnose";
  if (normalized === "planning" || normalized === "task-generate" || normalized === "context-pack") return "planning";
  if (normalized.startsWith("bootstrap")) return "planning";
  return "other";
}
