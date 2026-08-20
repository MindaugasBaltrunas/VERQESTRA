// Token-usage žurnalo santraukos report komandai (etalonas: AG_loop orchestrator/runtime/
// token-usage.ts summarizeTokenUsage/summarizeTokenUsageByModel pusė, WBR VQ-501 4/5-b).
// GRYNOS funkcijos virš jau perskaitytų eilučių; griežtas parseris atkartoja etalono
// readTokenUsageRecords semantiką — sugadinta eilutė META klaidą (tolerantiškas kelias
// analitikai — learning/usage-view parseTolerantUsageRecords, jo čia nedubliuojam).

import { numericUsage } from "../learning/usage-view.js";

export type TokenUsageSummaryRecord = {
  phase: string;
  model: string;
  records: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  total_cost_usd: number;
};

export type TokenUsageAdapterSummary = {
  model: string;
  records: number;
};

export type TokenUsageSummaryLine = { phase: string; model: string } & Record<string, unknown>;

/** Griežtas JSONL parseris (etalono readTokenUsageRecords paritetas): bloga eilutė meta. */
export function parseTokenUsageSummaryLines(raw: string | undefined): TokenUsageSummaryLine[] {
  const records: TokenUsageSummaryLine[] = [];
  for (const line of (raw ?? "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    records.push({
      ...parsed,
      phase: typeof parsed["phase"] === "string" ? parsed["phase"] : "",
      model: typeof parsed["model"] === "string" ? parsed["model"] : "",
    });
  }
  return records;
}

// Grupavimo rakto separatorius — NUL simbolis kaip etalone (phase/model tekstuose jo būti
// negali, tad raktai niekada nesusilieja). String.fromCharCode(0) vietoj literalo/escape —
// failų higienos skenas literalų NUL laiko defektu (worktree-layout precedentas).
const GROUP_KEY_SEPARATOR = String.fromCharCode(0);

export function summarizeTokenUsage(records: readonly TokenUsageSummaryLine[]): TokenUsageSummaryRecord[] {
  const grouped = new Map<string, TokenUsageSummaryRecord>();
  for (const record of records) {
    const key = record.phase + GROUP_KEY_SEPARATOR + record.model;
    const current = grouped.get(key) ?? {
      phase: record.phase,
      model: record.model,
      records: 0,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      total_cost_usd: 0,
    };

    current.records += 1;
    current.input_tokens += numericUsage(record["input_tokens"]);
    current.output_tokens += numericUsage(record["output_tokens"]);
    current.cache_read_input_tokens += numericUsage(record["cache_read_input_tokens"]);
    current.cache_creation_input_tokens += numericUsage(record["cache_creation_input_tokens"]);
    current.total_cost_usd += numericUsage(record["total_cost_usd"]);
    grouped.set(key, current);
  }

  return [...grouped.values()].sort((a, b) => a.phase.localeCompare(b.phase) || a.model.localeCompare(b.model));
}

export function summarizeTokenUsageByModel(records: readonly TokenUsageSummaryLine[]): TokenUsageAdapterSummary[] {
  const grouped = new Map<string, TokenUsageAdapterSummary>();
  for (const record of records) {
    const current = grouped.get(record.model) ?? { model: record.model, records: 0 };
    current.records += 1;
    grouped.set(record.model, current);
  }
  return [...grouped.values()].sort((a, b) => b.records - a.records || a.model.localeCompare(b.model));
}
