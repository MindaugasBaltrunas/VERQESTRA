// release-readiness use case (etalono architecture-boundary-check.ts, WBR VQ-305): tas pats
// forbidden-layer-import tikrinimas kaip CLI architecture-check, bet vartai taikomi tik
// pažeidimams VIRŠ sekamo baseline — anksčiau egzistavusi skola release'o neblokuoja, nauja
// regresija blokuoja. Kviečia final-audit, kad `architecture_boundary` vartai visada būtų
// išvesti iš realios patikros, o ne pasenusio doc teiginio.
import { buildCodeIndex } from "../code-intelligence/indexing/builder.js";
import { findArchitectureBoundaryViolations } from "../code-intelligence/boundary/architecture-boundary.js";
import {
  KNOWN_ARCHITECTURE_BOUNDARY_VIOLATION_BASELINE,
  newArchitectureBoundaryViolations,
} from "../code-intelligence/boundary/baseline.js";
import type { CodeIntelligenceFileSystemPort } from "../code-intelligence/ports.js";
import { loadArchitectureStylePolicy } from "../policy-governance/architecture-policies.js";
import type { PolicyConfigFileSystemPort } from "../policy-governance/ports.js";

export type ArchitectureBoundaryCheckResult = {
  ok: boolean;
  new_violation_count: number;
  baseline_violation_count: number;
  issues: string[];
};

export async function checkArchitectureBoundary(
  codeFs: CodeIntelligenceFileSystemPort,
  policyFs: PolicyConfigFileSystemPort,
  projectRoot: string,
  runtimeRoot: string,
): Promise<ArchitectureBoundaryCheckResult> {
  // Atkartoja final-audit checkRuleStatus klaidų apdorojimą: neperskaitoma politika jau
  // savarankiškai numuša `rule_status` vartus, bet ši patikra privalo raportuoti savo pačios
  // nesėkmę, o ne mesti ir nugriauti visą final-audit kompoziciją.
  try {
    const index = await buildCodeIndex(codeFs, projectRoot);
    const policy = await loadArchitectureStylePolicy(policyFs, runtimeRoot);
    const violations = findArchitectureBoundaryViolations(index, policy);
    const newViolations = newArchitectureBoundaryViolations(violations);
    return {
      ok: newViolations.length === 0,
      new_violation_count: newViolations.length,
      baseline_violation_count: KNOWN_ARCHITECTURE_BOUNDARY_VIOLATION_BASELINE.length,
      issues: newViolations.map((violation) => `${violation.from} -> ${violation.to} (${violation.dependency})`),
    };
  } catch (error: unknown) {
    return {
      ok: false,
      new_violation_count: 0,
      baseline_violation_count: KNOWN_ARCHITECTURE_BOUNDARY_VIOLATION_BASELINE.length,
      issues: [`architecture-boundary-check:${error instanceof Error ? error.message : String(error)}`],
    };
  }
}
