// Bendras eilučių skenavimas digest varikliui: notable/passing/count-summary šablonai,
// tail, dedupe ir cap'ai. Behaviour etalon: AG_loop domain/tool-results/
// bash-output-digest.ts (scan pusė; WBR VQ-204 skaidymas).

import { BASH_DIGEST_CAPS, type BashOutputCounts } from "./model.js";

export function splitLines(text: string): string[] {
  // `\r?\n` covers the Windows/PowerShell CRLF form; a trailing `\r` never reaches a signal.
  return text.split(/\r?\n/).map((line) => line.replace(/\r$/, ""));
}

// A line is notable when it can carry the reason something failed. `Error\b` and `Warning\b`
// are case-sensitive on purpose: they catch `AssertionError`/`TypeError`/`ERR_ASSERTION` and
// Node's `DeprecationWarning:`/`ExperimentalWarning:`, none of which have a word boundary
// before "Error"/"Warning" — and a green run's stderr is exactly where those appear, i.e. the
// text the replacement path would otherwise delete without a trace.
const NOTABLE_LINE_PATTERNS: readonly RegExp[] = [
  /\b(?:error|errors|warn|warning|warnings|fail|failed|failing|failure|failures|exception|blocked)\b/i,
  /\bnot ok\b/,
  /Error\b/,
  /Warning\b/,
  // Package-manager and OS failure markers that spell neither "error" nor "fail".
  /\bERR!/,
  /\b(?:ELIFECYCLE|ENOENT|EACCES|EPERM|EEXIST)\b/,
  /[✖✗×]/,
];

// Lines the runners print for tests that PASSED. Excluded from the notable scan: a passing
// test named "fails when the queue is empty" is not a diagnostic, and treating it as one
// would flag a green run's digest unsafe on its own test names.
const PASSING_LINE_PATTERNS: readonly RegExp[] = [
  /^\s*ok\s+\d+\b/,
  /^\s*[✔✓]\s/,
  /^\s*#\s*Subtest:/,
  /^\s*(?:ℹ\s*)?(?:pass|tests|suites|todo|skipped|cancelled|duration_ms)\s+\d/,
];

// Tally lines a runner prints as its own summary (`# fail 0`, `Found 0 errors.`). They stay
// in the digest as evidence, but they are NOT diagnostics: counting them would report
// "errors=1" for a fully green run whose only notable line is the zero it printed.
const COUNT_SUMMARY_LINE_PATTERNS: readonly RegExp[] = [
  /^\s*[#ℹ]?\s*(?:fail|failed|failures|pass|passed|tests|suites|todo|skipped|cancelled)\s+\d+\s*$/i,
  /^\s*Found\s+\d+\s+errors?\b/,
  /\d+\s+problems?\s*\(\d+\s+errors?,\s*\d+\s+warnings?\)/,
  /^\s*(?:Tests|Test Files)\s+\d+\s+passed/,
];

// Warning-vs-error classification must use the SAME no-word-boundary rule the notable scan
// uses, or a line that is notable only because of `/Warning\b/` (`DeprecationWarning:`) gets
// tallied as an error and the digest reports `errors=1` for a run that succeeded.
const WARNING_LINE_PATTERN = /warn(?:ing)?s?\b/i;

/** A line that can carry the reason something failed — the unit both the scan and the parsers use. */
export function isNotableLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length === 0) return false;
  if (PASSING_LINE_PATTERNS.some((pattern) => pattern.test(line))) return false;
  return NOTABLE_LINE_PATTERNS.some((pattern) => pattern.test(trimmed));
}

// Stack frames and TAP's `location:` field carry the position of a failure without naming it,
// so they are location sources even though they are not diagnostics themselves.
const STACK_FRAME_LINE = /^\s*at\s+\S/;
const YAML_LOCATION_LINE = /^\s*location:\s*\S/;

export function isLocationSource(line: string): boolean {
  return isNotableLine(line) || STACK_FRAME_LINE.test(line) || YAML_LOCATION_LINE.test(line);
}

export type NotableScan = { lines: string[]; clipped: boolean; errorLines: number; warningLines: number };

export function collectNotableLines(lines: string[]): NotableScan {
  const collected: string[] = [];
  let clipped = false;
  let errorLines = 0;
  let warningLines = 0;

  for (const line of lines) {
    if (!isNotableLine(line)) continue;
    const trimmed = line.trim();

    if (!COUNT_SUMMARY_LINE_PATTERNS.some((pattern) => pattern.test(trimmed))) {
      if (WARNING_LINE_PATTERN.test(trimmed)) warningLines += 1;
      else errorLines += 1;
    }

    if (trimmed.length > BASH_DIGEST_CAPS.lineChars) {
      collected.push(`${trimmed.slice(0, BASH_DIGEST_CAPS.lineChars)}…`);
      clipped = true;
    } else {
      collected.push(trimmed);
    }
  }

  return { lines: collected, clipped, errorLines, warningLines };
}

/**
 * Counts precedence: whatever the runner reported (directly, or via the diagnostics this
 * engine recognized) wins outright. Line tallies are a LAST resort, used only when the parse
 * produced no counts at all — mixing them in would report `errors=2` for a run whose own
 * summary already said `fail=1`, turning a count of diagnostic LINES into a fake count of
 * failures. An absent count stays absent; it is never invented as zero.
 */
export function fillCounts(counts: BashOutputCounts, notable: NotableScan): BashOutputCounts {
  if (Object.keys(counts).length > 0) return counts;
  return {
    ...(notable.errorLines > 0 ? { errors: notable.errorLines } : {}),
    ...(notable.warningLines > 0 ? { warnings: notable.warningLines } : {}),
  };
}

export function tailOf(lines: string[]): { signal: { tail?: string }; clipped: boolean } {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const trimmed = lines[index]?.trim() ?? "";
    if (trimmed.length === 0) continue;
    if (trimmed.length > BASH_DIGEST_CAPS.tailChars) {
      return { signal: { tail: `${trimmed.slice(0, BASH_DIGEST_CAPS.tailChars)}…` }, clipped: true };
    }
    return { signal: { tail: trimmed }, clipped: false };
  }
  return { signal: {}, clipped: false };
}

export function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

export function capList<T>(items: T[], cap: number): { items: T[]; truncated: boolean } {
  return items.length <= cap ? { items, truncated: false } : { items: items.slice(0, cap), truncated: true };
}
