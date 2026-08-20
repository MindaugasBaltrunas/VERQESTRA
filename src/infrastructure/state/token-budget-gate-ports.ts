// Realūs `TokenBudgetGatePorts` adapteriai (etalonas: AG_loop policy/tool-budget.ts IO
// pusė). application/token-governance vartai skaičiuoja; čia — tik failai: žalias
// `vq/logs/token-usage.jsonl`, `vq/state/llm-call-resets.json` ir best-effort
// `vq/state/token-budget-status.json` veidrodis (merge pagal raktą — etalono
// writeBudgetStatus semantika, kad skirtingų vartų sprendimai vienas kito neužtrintų).

import {
  llmCallResetsPath,
  tokenBudgetStatusPath,
  tokenUsageLogPath,
  type TokenBudgetGatePorts,
} from "../../application/token-governance/tool-budget-gates.js";
import { nodeFsAdapter } from "../fs/node-fs-adapter.js";

/** Tolerantiškas JSON objekto skaitymas: nėra failo arba sugadintas — `{}` (etalono readJson fallback). */
async function readJsonObject(absolutePath: string): Promise<Record<string, unknown>> {
  const raw = await nodeFsAdapter.readTextFileIfExists(absolutePath);
  if (raw === undefined) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function createTokenBudgetGatePorts(runtimeRoot: string): TokenBudgetGatePorts {
  return {
    fs: nodeFsAdapter,
    async readTokenUsageLog(): Promise<string> {
      return (await nodeFsAdapter.readTextFileIfExists(tokenUsageLogPath(runtimeRoot))) ?? "";
    },
    async readLlmCallResets(): Promise<Record<string, unknown>> {
      return await readJsonObject(llmCallResetsPath(runtimeRoot));
    },
    async writeLlmCallResets(resets: Record<string, unknown>): Promise<void> {
      await nodeFsAdapter.writeTextFile(llmCallResetsPath(runtimeRoot), `${JSON.stringify(resets, null, 2)}\n`);
    },
    async writeBudgetStatus(key: string, status: unknown): Promise<void> {
      const statusPath = tokenBudgetStatusPath(runtimeRoot);
      const existing = await readJsonObject(statusPath);
      await nodeFsAdapter.writeTextFile(statusPath, `${JSON.stringify({ ...existing, [key]: status }, null, 2)}\n`);
    },
    nowIso(): string {
      return new Date().toISOString();
    },
  };
}
