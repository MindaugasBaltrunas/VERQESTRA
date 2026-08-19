// Outcome sprendimas ir safe-to-replace verdiktas. Behaviour etalon: AG_loop
// domain/tool-results/bash-output-digest.ts (resolveOutcome/decideSafeToReplace;
// WBR VQ-204 skaidymas).

import type { BashToolResponse } from "../bash-tool-response.js";
import type { BashOutputOutcome, BashOutputSignals, ClassParse } from "./model.js";

/**
 * The exit status is authoritative when the payload carries one. Without it (bare-string
 * payloads), only the runner's own explicit verdict counts — an output that shows neither
 * failure nor success evidence yields `undefined`, i.e. `unsupported`.
 */
export function resolveOutcome(response: BashToolResponse, parse: ClassParse): BashOutputOutcome | undefined {
  if (response.interrupted) return "interrupted";
  if (response.exitCode !== undefined) return response.exitCode === 0 ? "success" : "failure";
  if (parse.failureEvidence) return "failure";
  if (parse.successEvidence) return "success";
  return undefined;
}

export function decideSafeToReplace(
  signals: BashOutputSignals,
  rawChars: number,
  digestChars: number,
): { safe: boolean; reason?: string } {
  if (signals.outcome !== "success") {
    return { safe: false, reason: `outcome=${signals.outcome}: a non-successful run keeps its raw output` };
  }
  if (signals.failedNames.length > 0 || (signals.counts.fail ?? 0) > 0) {
    // Exit status says success while the runner named failures: a contradiction this engine
    // reports rather than resolves.
    return { safe: false, reason: "exit status disagrees with failure markers in the output" };
  }
  if (signals.truncated) {
    return { safe: false, reason: "digest had to drop or clip diagnostic text" };
  }
  if (digestChars >= rawChars) {
    return { safe: false, reason: "digest is not shorter than the raw output" };
  }
  return { safe: true };
}
