// Boundary baseline — VERQESTRA jis TUŠČIAS pagal konstrukciją (design: nulinė bazė nuo
// pirmo commit'o) ir niekada neauga. Behaviour etalon: AG_loop code-index/
// architecture-boundary-baseline.ts (kurio baseline 2026-07-07 irgi ištuštėjo).

import type { ArchitectureBoundaryViolation } from "./architecture-boundary.js";

export const KNOWN_ARCHITECTURE_BOUNDARY_VIOLATION_BASELINE: ArchitectureBoundaryViolation[] = [];

function violationKey(violation: ArchitectureBoundaryViolation): string {
  return `${violation.from} ${violation.to} ${violation.dependency}`;
}

/**
 * Violations found beyond the known baseline — what should actually gate CI/release.
 * Su tuščiu baseline tai yra tapatybė, bet forma išlaikyta, kad gate'ų skaitytojai
 * abiejuose repo būtų vienodi.
 */
export function newArchitectureBoundaryViolations(
  violations: ArchitectureBoundaryViolation[],
): ArchitectureBoundaryViolation[] {
  const baselineKeys = new Set(KNOWN_ARCHITECTURE_BOUNDARY_VIOLATION_BASELINE.map(violationKey));
  return violations.filter((violation) => !baselineKeys.has(violationKey(violation)));
}
