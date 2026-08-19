// File-length rule — the objective detector behind the `single_responsibility` coding
// principle. Line count is a proxy, not a proof, of an SRP violation — but the proxy is
// deterministic, and the ratchet semantics keep it actionable: files ≤ limit are fine,
// files over the limit fit only their frozen baseline (shrink-only), an over-limit file
// without a baseline entry is a violation. VERQESTRA construction rule: the baseline
// argument is ALWAYS `{}` here — no file may exceed the limit, and the live gate
// (architecture-gates.test.ts) enforces that; the parameter exists so the rule stays
// byte-compatible with the etalon and testable for the ratchet semantics themselves.
// Behaviour etalon: AG_loop domain/policies/file-length.ts.

import { decideEnforcement, type EnforcementLevel, type EnforcementVerdict } from "./enforcement-level.js";

export type FileLengthMeasurement = {
  /** Repo-root-relative POSIX path. */
  file: string;
  lines: number;
};

export type FileLengthViolation = {
  file: string;
  lines: number;
  /** The ceiling this file was allowed: the global limit, or its frozen baseline. */
  allowed: number;
};

export type FileLengthBaselineIssue = {
  file: string;
  baseline: number;
  /** Both reasons mean the entry must be removed — a stale baseline re-opens headroom. */
  reason: "missing-file" | "within-limit";
};

/** Ratchet check: every measured file must fit the limit or its frozen baseline. */
export function evaluateFileLengths(
  measurements: readonly FileLengthMeasurement[],
  limit: number,
  baseline: Readonly<Record<string, number>>,
): FileLengthViolation[] {
  const violations: FileLengthViolation[] = [];
  for (const { file, lines } of measurements) {
    const allowed = Math.max(limit, baseline[file] ?? 0);
    if (lines > allowed) violations.push({ file, lines, allowed });
  }
  return violations.sort((left, right) => left.file.localeCompare(right.file));
}

/** Baseline hygiene: entries for deleted or now-within-limit files fail the gate too. */
export function findStaleFileLengthBaselineEntries(
  measurements: readonly FileLengthMeasurement[],
  limit: number,
  baseline: Readonly<Record<string, number>>,
): FileLengthBaselineIssue[] {
  const byFile = new Map(measurements.map((entry) => [entry.file, entry.lines]));
  const issues: FileLengthBaselineIssue[] = [];
  for (const [file, allowed] of Object.entries(baseline)) {
    const lines = byFile.get(file);
    if (lines === undefined) issues.push({ file, baseline: allowed, reason: "missing-file" });
    else if (lines <= limit) issues.push({ file, baseline: allowed, reason: "within-limit" });
  }
  return issues.sort((left, right) => left.file.localeCompare(right.file));
}

/** Line counts are exact measurements, so evidence is always `confirmed`. */
export function fileLengthVerdict(
  level: EnforcementLevel,
  violations: readonly FileLengthViolation[],
): EnforcementVerdict {
  if (violations.length === 0) return { effect: "none", reason_kind: "none" };
  return decideEnforcement(level, "confirmed");
}
