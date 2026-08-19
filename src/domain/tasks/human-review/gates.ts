// Pure human-review routing rules: which gates a task's text and allowed-file list
// trigger. Behaviour etalon: AG_loop domain/tasks/human-review.ts (WBR VQ-201 split:
// the rule lives here, the per-category regex detectors in ./evidence.ts).

import {
  billingEvidence,
  databaseEvidence,
  dependencyEvidence,
  deployEvidence,
  destructiveDataEvidence,
  learningPolicyEvidence,
  outboundCommunicationEvidence,
  securityEvidence,
} from "./evidence.js";

export type HumanReviewGateCategory =
  | "dependency"
  | "database"
  | "security"
  | "deploy"
  | "destructive_data"
  | "billing"
  | "outbound_communication"
  | "learning_policy";

export type HumanReviewGate = {
  category: HumanReviewGateCategory;
  reason: string;
  evidence: string[];
};

export type HumanReviewGateResult = {
  requires_human_review: boolean;
  gates: HumanReviewGate[];
  reasons: string[];
  /** Set when an explicit HUMAN-REVIEW-APPROVED marker suppressed the gates. */
  approved_marker?: string;
};

// Eksplicitaus žmogaus patvirtinimo žyma task tekste: be jos requeue parkintų patvirtintą
// task'ą vėl ir vėl (keyword vartai saugumo task'ui suveiks visada). Žymą įrašo TIK žmogus:
//   HUMAN-REVIEW-APPROVED: <kas> <data> [pastaba]
// Leidžiamas neprivalomas bullet prefiksas (`-`/`*`) — operatoriai žymą natūraliai rašo
// sąrašo punktu (0000-0 incidentas); laisvo teksto viduryje žyma nesuveikia.
const HUMAN_REVIEW_APPROVED_RE = /^(?:[-*]\s+)?HUMAN-REVIEW-APPROVED:\s*(\S.*)$/im;

export function analyzeHumanReviewGates(taskText: string, allowedFiles: string[] = []): HumanReviewGateResult {
  const approval = taskText.match(HUMAN_REVIEW_APPROVED_RE);
  const approvedMarker = approval?.[1];
  if (approvedMarker !== undefined) {
    return { requires_human_review: false, gates: [], reasons: [], approved_marker: approvedMarker.trim() };
  }

  const normalizedText = taskText.toLowerCase();
  const normalizedPaths = allowedFiles.map((file) => file.replace(/\\/g, "/").toLowerCase());
  const gates: HumanReviewGate[] = [];

  addGate(gates, "dependency", dependencyEvidence(normalizedText, normalizedPaths), "new dependency or package manager change requires spec approval and human-review");
  addGate(gates, "database", databaseEvidence(normalizedText, normalizedPaths), "database schema or migration work requires human-review before execution");
  addGate(gates, "security", securityEvidence(normalizedText, normalizedPaths), "auth/security/payment/secrets/permissions/encryption changes require human-review after planning");
  addGate(gates, "deploy", deployEvidence(normalizedText, normalizedPaths), "production deploy or release automation requires human-review");
  addGate(gates, "destructive_data", destructiveDataEvidence(normalizedText, normalizedPaths), "destructive data operation requires human-review");
  addGate(gates, "billing", billingEvidence(normalizedText, normalizedPaths), "billing or subscription behavior requires human-review");
  addGate(gates, "outbound_communication", outboundCommunicationEvidence(normalizedText, normalizedPaths), "outbound user communication behavior requires human-review");
  addGate(gates, "learning_policy", learningPolicyEvidence(normalizedText, normalizedPaths), "learning memory policy changes require human-review before applying");

  return {
    requires_human_review: gates.length > 0,
    gates,
    reasons: gates.map((gate) => gate.reason),
  };
}

/**
 * Tos pačios vartų taisyklės, pritaikytos KELIŲ SĄRAŠUI be task teksto (IVER-3):
 * integracijos rizikos vertinimas privalo atsakyti „ar šie keliai auth/DB/destruktyvūs"
 * TA PAČIA taisyklių aibe kaip preflight — tyliai išsiskyrę saugumo vartai blogiau nei jų
 * nebuvimas. `HUMAN-REVIEW-APPROVED` čia negalioja: task'o patvirtinimas nėra bangos
 * suliejimo patvirtinimas.
 */
export function analyzeChangedPathGates(changedPaths: readonly string[]): HumanReviewGateResult {
  return analyzeHumanReviewGates("", [...changedPaths]);
}

function addGate(gates: HumanReviewGate[], category: HumanReviewGateCategory, evidence: string[], reason: string): void {
  if (evidence.length === 0) return;
  gates.push({ category, reason, evidence: Array.from(new Set(evidence)).sort() });
}
