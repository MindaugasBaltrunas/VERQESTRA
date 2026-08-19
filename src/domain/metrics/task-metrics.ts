// Vieno task'o benchmark metrikos iš usage + event įrašų: fazių grupavimas, dispatch
// bandymai, turn'ų šaltinis, out-of-scope failai, terminalinė būsena ir priėmimo verdiktas.
// Pure. Behaviour etalon: AG_loop domain/metrics/accepted-change.ts (task pusė;
// WBR VQ-204 skaidymas).

import {
  addUsageTotals,
  canonicalBenchmarkPhase,
  emptyUsageTotals,
  isLlmCall,
  usageTotalsFromEntry,
  type BenchmarkEventEntry,
  type BenchmarkPhaseUsage,
  type BenchmarkUsageEntry,
  type BenchmarkUsageTotals,
} from "./usage.js";
import {
  evaluateAcceptance,
  type BenchmarkAcceptanceVerdict,
  type BenchmarkTerminalState,
} from "./acceptance-gates.js";

export type BenchmarkTaskInput = {
  task_id: string;
  case_id: string | null;
  category: string | null;
  usage: BenchmarkUsageEntry[];
  events: BenchmarkEventEntry[];
};

export type BenchmarkTaskMetrics = {
  task_id: string;
  case_id: string | null;
  category: string | null;
  usage: BenchmarkUsageTotals;
  phase_usage: BenchmarkPhaseUsage[];
  llm_calls: number;
  dispatch_attempts: number;
  /**
   * Turn'ai. `turns_source` visada pasako, KAS tai per skaičius, kad telemetrijos patobulinimas
   * tyliai nepakeistų istorinių baseline'ų prasmės:
   *   - `recorded` — realus `num_turns` iš `result` envelope (nuo 2026-08-06);
   *   - `dispatch-attempts` — sena euristika (vienas įrašas vienam dispatch bandymui), t. y.
   *     apatinė riba, naudojama istoriniams įrašams be `num_turns`;
   *   - `unavailable` — nėra nė vieno signalo.
   */
  turns: number;
  turns_source: "recorded" | "dispatch-attempts" | "unavailable";
  first_pass: boolean;
  repair_count: number;
  human_review_count: number;
  out_of_scope_files: string[];
  terminal_state: BenchmarkTerminalState;
  measurable: boolean;
  acceptance: BenchmarkAcceptanceVerdict;
};

const OUT_OF_SCOPE_REASON = /changed files outside allowed paths:\s*([^\r\n]+)/i;

/** Extracts the file list from the scope-guard event reason; any other reason yields `[]`. */
export function parseOutOfScopeFiles(reason: string): string[] {
  const match = OUT_OF_SCOPE_REASON.exec(reason ?? "");
  if (!match) return [];
  return (match[1] ?? "")
    .split(",")
    .map((file) => file.trim())
    .filter((file) => file.length > 0);
}

const TERMINAL_EVENT_STATES = new Set(["done", "human-review", "error", "failed", "duplicate"]);

export function computeTaskMetrics(input: BenchmarkTaskInput): BenchmarkTaskMetrics {
  const usage = input.usage.reduce<BenchmarkUsageTotals>(
    (totals, entry) => addUsageTotals(totals, usageTotalsFromEntry(entry)),
    emptyUsageTotals(),
  );

  const grouped = new Map<string, BenchmarkPhaseUsage>();
  for (const entry of input.usage) {
    // Etalono raktas — gryna konkatenacija be skirtuko (užšaldytas elgesys).
    const key = entry.phase + entry.model;
    const current = grouped.get(key) ?? {
      phase: entry.phase,
      canonical_phase: canonicalBenchmarkPhase(entry.phase),
      model: entry.model,
      records: 0,
      llm_calls: 0,
      usage: emptyUsageTotals(),
    };
    current.records += 1;
    if (isLlmCall(entry)) current.llm_calls += 1;
    current.usage = addUsageTotals(current.usage, usageTotalsFromEntry(entry));
    grouped.set(key, current);
  }
  const phaseUsage = [...grouped.values()].sort(
    (a, b) => a.phase.localeCompare(b.phase) || a.model.localeCompare(b.model),
  );

  const llmCalls = input.usage.filter((entry) => isLlmCall(entry)).length;
  const dispatchEntries = input.usage.filter((entry) => canonicalBenchmarkPhase(entry.phase) === "dispatch");
  const maxAttempt = dispatchEntries.reduce((max, entry) => Math.max(max, entry.attempt ?? 0), 0);
  const dispatchAttempts = Math.max(dispatchEntries.length, maxAttempt);
  const repairCount = Math.max(0, dispatchAttempts - 1);

  // Realūs turn'ai, kai telemetrija juos užfiksavo (`num_turns` iš `result` envelope,
  // 2026-08-06). Turn'ai yra pagrindinis kaštų variklis — kiekvienas jų pakartotinai perskaito
  // visą kontekstą — bet iki šiol benchmark'as naudojo dispatch'ų SKAIČIŲ kaip apatinę ribą,
  // t. y. didžiausias kaštų veiksnys neturėjo prietaiso. Sena euristika lieka fallback'u
  // istoriniams įrašams, o šaltinis visada matomas `turns_source` lauke.
  const recordedTurns = input.usage.reduce((sum, entry) => sum + (entry.num_turns ?? 0), 0);
  const hasRecordedTurns = input.usage.some((entry) => typeof entry.num_turns === "number");

  const humanReviewCount = input.events.filter(
    (event) => event.to_state === "human-review" || event.to_state === "failed",
  ).length;
  const outOfScopeFiles = [...new Set(input.events.flatMap((event) => parseOutOfScopeFiles(event.reason)))].sort();

  let terminalState: BenchmarkTerminalState = "unknown";
  for (const event of input.events) {
    if (!TERMINAL_EVENT_STATES.has(event.to_state)) continue;
    terminalState = event.to_state === "failed" ? "human-review" : (event.to_state as BenchmarkTerminalState);
  }

  const acceptance = evaluateAcceptance({
    terminal_state: terminalState,
    human_review_count: humanReviewCount,
    out_of_scope_files: outOfScopeFiles,
    dispatch_attempts: dispatchAttempts,
  });

  return {
    task_id: input.task_id,
    case_id: input.case_id,
    category: input.category,
    usage,
    phase_usage: phaseUsage,
    llm_calls: llmCalls,
    dispatch_attempts: dispatchAttempts,
    turns: hasRecordedTurns ? recordedTurns : dispatchAttempts,
    turns_source: hasRecordedTurns ? "recorded" : dispatchAttempts > 0 ? "dispatch-attempts" : "unavailable",
    first_pass: terminalState === "done" && dispatchAttempts === 1 && repairCount === 0 && humanReviewCount === 0,
    repair_count: repairCount,
    human_review_count: humanReviewCount,
    out_of_scope_files: outOfScopeFiles,
    terminal_state: terminalState,
    measurable: dispatchAttempts >= 1,
    acceptance,
  };
}
