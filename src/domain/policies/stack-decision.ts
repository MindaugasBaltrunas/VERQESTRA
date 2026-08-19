// Stack decision — domain-owned value types and the pure human-review predicate.
// R2 inversija (WBR VQ-203): tipų tiesa gyvena ČIA; zod schema vėlesniame sluoksnyje
// privalo šiuos tipus TENKINTI, ne apibrėžti. Behaviour etalon: AG_loop
// policy/stack-decision.ts + core/schema.ts stackDecisionSchema laukai +
// architecture/stack-signals.ts (tipas ir stackSignalsToInputSignals).

export type StackSignalAppType = "api-only" | "ui-only" | "fullstack" | "worker-only" | "unknown";

export type StackSignals = {
  appType: StackSignalAppType;
  uiNodeIds: string[];
  apiNodeIds: string[];
  dataNodeIds: string[];
  integrationNodeIds: string[];
  complexity: {
    nodeCount: number;
    edgeCount: number;
    externalNodeCount: number;
    level: "low" | "medium" | "high";
  };
  deploymentHints: string[];
  riskHints: string[];
};

export type StackDecisionConfidence = "low" | "medium" | "high";

export type StackDecisionAlternative = {
  label: string;
  reason: string;
  confidence: StackDecisionConfidence;
};

export type StackDecision = {
  selectedLanguage: string | null;
  selectedFramework: string | null;
  architectureStyle: string;
  inputSignals: string[];
  alternativesConsidered: StackDecisionAlternative[];
  confidence: StackDecisionConfidence;
  reason: string;
  humanReviewRequired: boolean;
};

/** Deterministinis, rūšiuotas signalų sąrašas audito įrašui (dedup + sort). */
export function stackSignalsToInputSignals(signals: StackSignals): string[] {
  const list: string[] = [];
  list.push(`app-type:${signals.appType}`);
  for (const id of signals.uiNodeIds) list.push(`ui-node:${id}`);
  for (const id of signals.apiNodeIds) list.push(`api-node:${id}`);
  for (const id of signals.dataNodeIds) list.push(`data-node:${id}`);
  for (const id of signals.integrationNodeIds) list.push(`integration-node:${id}`);
  list.push(`complexity:${signals.complexity.level}`);
  list.push(`complexity-nodes:${signals.complexity.nodeCount}`);
  list.push(`complexity-edges:${signals.complexity.edgeCount}`);
  for (const hint of signals.deploymentHints) list.push(hint);
  for (const hint of signals.riskHints) list.push(hint);
  return Array.from(new Set(list)).sort();
}

/**
 * True when a StackDecision should be persisted as an audit record: an explicit user
 * choice made WITHOUT any inference has `inputSignals.length === 0` and is skipped.
 */
export function shouldPersistStackDecision(decision: StackDecision): boolean {
  return decision.inputSignals.length > 0;
}

/**
 * Risk hint tags that on their own force human review (security/billing/regulated data).
 * Kept intentionally narrow: advisory hints (`risk:legacy` etc.) do not warrant the gate.
 */
const HUMAN_REVIEW_RISK_HINTS: readonly string[] = ["risk:payment", "risk:pii", "risk:auth", "risk:secrets"];

/** The subset of a derived decision the human-review predicate depends on. */
export type StackHumanReviewCore = {
  confidence: StackDecisionConfidence;
  /**
   * True when an explicit caller choice contradicts what the signals inferred (README↔.mmd
   * conflict). A fully explicit choice is authoritative and never treated as a conflict.
   */
  explicitConflictsWithInferred: boolean;
};

function hasRiskHint(signals: StackSignals): boolean {
  return signals.riskHints.some((hint) => HUMAN_REVIEW_RISK_HINTS.includes(hint));
}

/**
 * Near-tie ambiguity across ui/api/data: the top two non-zero categories are within one
 * node of each other, so no single stack clearly dominates.
 */
function hasNearTieAmbiguity(signals: StackSignals): boolean {
  const [top, second] = [signals.uiNodeIds.length, signals.apiNodeIds.length, signals.dataNodeIds.length].sort(
    (a, b) => b - a,
  );
  return (second ?? 0) >= 1 && (top ?? 0) - (second ?? 0) <= 1;
}

/**
 * Pure predicate: ar išvestas StackDecision privalo eiti į human review — rizika,
 * deployment'as, aukšta kompleksika, near-tie dviprasmybė be aukšto pasitikėjimo, arba
 * explicit-vs-inferred konfliktas.
 */
export function evaluateStackHumanReview(signals: StackSignals, core: StackHumanReviewCore): boolean {
  if (hasRiskHint(signals)) return true;
  if (signals.deploymentHints.length > 0) return true;
  if (signals.complexity.level === "high") return true;
  if (core.confidence !== "high" && hasNearTieAmbiguity(signals)) return true;
  if (core.explicitConflictsWithInferred) return true;
  return false;
}
