// Retry-cap + repair-routing use-case wrapping the CANONICAL production decision the loop's
// `repair` diagnosis handler makes on every "repair" verdict (retry-guard, then read the
// task-scoped repair prompt). The retry-limit judgement itself is the pure
// domain/tasks/retry.ts evaluateRetryLimit/normalizeMaxRetryAttempts rule; the IO (retry
// counter mutation, repair prompt read) is invoked through RetryRepairPorts so this stays
// testable without touching the filesystem. Etalone modulis nešėsi default port'us
// (retry-guard CLI + `AG/state/repair/<task_id>.md` skaitytojas); VERQESTRA adapterius
// paduoda composition root (E4/E5) — application sluoksnis realios FS default'ų neturi.
//
// Deliberately does NOT model the deleted applyRetryPolicy/classifyRetryOutcome outcome set —
// this only decides between proceeding with a repair attempt or escalating to human-review,
// matching the two branches the loop's repair handler actually takes before rollback/bucket-move
// side effects. Vienas gamybinis atšakos variantas, kurio šis MODELIS taip pat nemodeliuoja
// (etalono task 0003): `repair-task.ts` sėkmės kelio fail-safe — jo įėjimai yra run-scoped
// įrodymai, kurių šis CLI-free sprendimas negauna.
import { evaluateRetryLimit, normalizeMaxRetryAttempts, type RetryLimitDecision } from "../../domain/tasks/index.js";

// Application-layer bridge for the pure domain repeat-error escalation rule
// (domain/tasks/retry.ts). Re-exported here so the diagnose CLI interface adapter can
// consume it through the sanctioned interfaces -> application -> domain direction instead
// of a forbidden interfaces -> domain import. Co-located with the retry-cap decision
// because both wrap the same domain/tasks/retry.ts module.
export { evaluateRepeatedErrorEscalation } from "../../domain/tasks/index.js";

export type RetryRepairOutcome = "retry" | "human-review";

export type RetryRepairDecision = {
  outcome: RetryRepairOutcome;
  reason: string;
  limit: RetryLimitDecision;
  /** Present only when `outcome === "retry"`. */
  repairPrompt?: string;
};

export type RetryRepairPorts = {
  /** Mutates and returns the persisted retry attempt count for `taskId`/`retryKey`. */
  incrementRetryCount(taskId: string, retryKey: string): Promise<number>;
  /** Reads the task-scoped repair prompt for `taskId`; empty string when none exists. */
  readRepairPrompt(taskId: string): Promise<string>;
};

export type RetryRepairParams = {
  taskId: string;
  retryKey: string;
  maxAttempts?: number;
};

/**
 * Decides whether a "repair" verdict should proceed as a retry (repair prompt attached) or
 * escalate to human-review, mirroring the loop's repair handler:
 * retry-limit reached -> human-review; repair prompt missing -> human-review; otherwise -> retry.
 */
export async function decideRetryOrRepair(
  params: RetryRepairParams,
  ports: RetryRepairPorts,
): Promise<RetryRepairDecision> {
  const taskCount = await ports.incrementRetryCount(params.taskId, params.retryKey);
  const limit = evaluateRetryLimit(taskCount, normalizeMaxRetryAttempts(params.maxAttempts));

  if (limit.reached) {
    return { outcome: "human-review", reason: "maximum retry attempts reached", limit };
  }

  const repairPrompt = await ports.readRepairPrompt(params.taskId);
  if (!repairPrompt.trim()) {
    return { outcome: "human-review", reason: "task_scoped_repair_prompt_missing", limit };
  }

  return { outcome: "retry", reason: "repair prompt available", limit, repairPrompt };
}
