// Human-review escalation use-case wrapping the PRODUCTION decision the preflight gate makes:
// reads a task file and delegates to the pure analyzeHumanReviewGates domain rule
// (domain/tasks/human-review/gates.ts) to detect dependency/database/security/deploy/
// destructive_data/billing/outbound_communication/learning_policy gates. This use-case does
// NOT re-implement gate detection — it only turns the existing HumanReviewGateResult into a
// two-branch outcome via HumanReviewEscalationPorts, so it stays testable with fakes.
//
// Wiring status (etalono CV-04, DECIDED): intentionally NOT wired into the canonical loop.
// The loop already runs this exact gate before every dispatch — preflight calls
// analyzeHumanReviewGates and routes risky tasks to human-review. Calling this use-case from
// the loop would only re-read the task and double-run an identical analysis. It is instead a
// CLI-free MODEL giving that gate->outcome decision a reusable, directly unit-testable home,
// alongside its sibling use-cases retry-repair.ts and adapter-routing.ts (see index.ts wiring
// note). Etalone modulis nešėsi default port'ą (`analyzeTaskFileHumanReviewGates` FS skaitytoją);
// VERQESTRA adapterį paduoda composition root — failo skaitymas yra už application ribos.
//
// It also does NOT model any retry-driven escalation: retry-exhausted -> human-review is
// covered by decideRetryOrRepair (retry-repair.ts). This use-case covers the independent
// gate-based escalation path, not the retry-limit path.
import type { HumanReviewGateResult } from "../../domain/tasks/index.js";

export type HumanReviewEscalationOutcome = "human-review" | "no-escalation";

export type HumanReviewEscalationDecision = {
  outcome: HumanReviewEscalationOutcome;
  reason: string;
  gates: HumanReviewGateResult;
};

export type HumanReviewEscalationPorts = {
  /** Reads taskFile and returns the gate-analysis result for it (adapter: file read + `analyzeHumanReviewGates`). */
  analyzeGates(taskFile: string, projectRoot?: string): Promise<HumanReviewGateResult>;
};

export type HumanReviewEscalationParams = {
  taskFile: string;
  projectRoot?: string;
};

/**
 * Decides whether a task file's content/allowed-files trigger a human-review gate
 * (dependency/database/security/deploy/destructive_data/billing/outbound_communication/
 * learning_policy), mirroring the preflight gate's requires_human_review flag.
 */
export async function decideHumanReviewEscalation(
  params: HumanReviewEscalationParams,
  ports: HumanReviewEscalationPorts,
): Promise<HumanReviewEscalationDecision> {
  const gates = await ports.analyzeGates(params.taskFile, params.projectRoot);

  if (gates.requires_human_review) {
    return { outcome: "human-review", reason: gates.reasons.join("; ") || "human-review gate triggered", gates };
  }

  return { outcome: "no-escalation", reason: "no human-review gate triggered", gates };
}
