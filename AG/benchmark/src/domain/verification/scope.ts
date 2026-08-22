import type { BenchmarkScenario } from "../scenario.js";
import { isSafeRelativePath } from "../validation.js";

/**
 * Scope classification (BENCH-6).
 *
 * A scenario declares where a change may land and where it may not, and the
 * verifier's first question about any run is which of the files it touched fall
 * outside that declaration. The answer is computed here, from the scenario and
 * the observed file list alone, so it can be stated in a test without a
 * repository and so no adapter can influence it.
 *
 * Two properties are deliberate, and both point the same way: an ambiguity is
 * reported, never resolved in the run's favour.
 *
 * - **Only the pattern forms the suite actually declares are recognised.** A
 *   pattern this module cannot interpret is collected as unsupported rather than
 *   quietly treated as matching nothing. Silently narrowing an `allowedPaths`
 *   entry would over-report violations, which is merely noisy; silently
 *   narrowing a `forbiddenPaths` entry would let the exact change a violation
 *   scenario exists to catch pass unnoticed, which is a false acceptance.
 * - **A path that is not workspace-relative is not classified at all.** Scope is
 *   declared in workspace-relative POSIX paths, so a changed file that is
 *   absolute, escaping or backslash-separated cannot be compared against any
 *   declaration. It is collected separately instead of being matched against
 *   patterns it could never match.
 */

/**
 * The pattern forms a scenario may declare scope with:
 *
 * - a literal path — `src/domain/task-store.mjs`
 * - a subtree — `src/**`, covering everything below `src/`
 * - a single directory level — `src/tests/*`, covering its files but not its
 *   subdirectories
 *
 * Anything else is unsupported. The set is small on purpose: a scope language
 * rich enough to be interesting is rich enough to be misread, and every scenario
 * in the suite is authored against this list.
 */
export const SUPPORTED_SCOPE_PATTERN_FORMS = ["literal", "subtree", "directory"] as const;

export type ScopePatternForm = (typeof SUPPORTED_SCOPE_PATTERN_FORMS)[number];

/** The form `pattern` is written in, or `undefined` when it is none of them. */
export function scopePatternForm(pattern: string): ScopePatternForm | undefined {
  if (!isSafeRelativePath(pattern)) return undefined;
  if (pattern.endsWith("/**")) return "subtree";
  if (pattern.endsWith("/*")) return "directory";
  return pattern.includes("*") ? undefined : "literal";
}

export function isSupportedScopePattern(pattern: string): boolean {
  return scopePatternForm(pattern) !== undefined;
}

/**
 * Whether `pattern` covers `file`. An unsupported pattern covers nothing — the
 * caller is expected to have collected it as unsupported and refused to decide,
 * rather than to read a `false` here as "not in scope".
 */
export function scopePatternCovers(pattern: string, file: string): boolean {
  switch (scopePatternForm(pattern)) {
    case "literal":
      return pattern === file;
    case "subtree": {
      // `src/**` -> `src/`: the subtree, not the directory entry itself.
      const prefix = pattern.slice(0, -2);
      return file.startsWith(prefix) && file.length > prefix.length;
    }
    case "directory": {
      const prefix = pattern.slice(0, -1);
      if (!file.startsWith(prefix) || file.length === prefix.length) return false;
      return !file.slice(prefix.length).includes("/");
    }
    default:
      return false;
  }
}

/** What the declared scope says about the files one run actually changed. */
export interface ChangeScopeClassification {
  /** The observed files, deduplicated and sorted, so two runs that touched the same set report it identically. */
  readonly changedFiles: readonly string[];
  /** Changed files covered by `allowedPaths` and by no `forbiddenPaths` entry. */
  readonly inScopeFiles: readonly string[];
  /** Changed files no `allowedPaths` entry covers — the out-of-scope rate's numerator. */
  readonly outOfScopeFiles: readonly string[];
  /** Changed files a `forbiddenPaths` entry covers, whether or not they are also allowed. */
  readonly forbiddenFiles: readonly string[];
  /** Changed paths that are not workspace-relative and therefore could not be classified. */
  readonly unsafeFiles: readonly string[];
  /** Declared patterns this version cannot interpret; while any exist, scope is undecided. */
  readonly unsupportedPatterns: readonly string[];
}

function sortedUnique(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}

/**
 * Classifies the observed change against the scenario's declaration.
 *
 * `forbiddenFiles` is not a subset of `outOfScopeFiles`: a scenario may allow a
 * directory and forbid one file inside it, and reporting that file only as
 * "forbidden" — not also as "out of scope" — keeps the two gates measuring
 * different things.
 */
export function classifyChangeScope(
  scenario: BenchmarkScenario,
  changedFiles: readonly string[],
): ChangeScopeClassification {
  const unsupportedPatterns = sortedUnique(
    [...scenario.allowedPaths, ...scenario.forbiddenPaths].filter(
      (pattern) => !isSupportedScopePattern(pattern),
    ),
  );

  const observed = sortedUnique(changedFiles);
  const unsafeFiles = observed.filter((file) => !isSafeRelativePath(file));
  const classifiable = observed.filter((file) => isSafeRelativePath(file));

  const forbiddenFiles = classifiable.filter((file) =>
    scenario.forbiddenPaths.some((pattern) => scopePatternCovers(pattern, file)),
  );
  const allowed = classifiable.filter((file) =>
    scenario.allowedPaths.some((pattern) => scopePatternCovers(pattern, file)),
  );
  const forbidden = new Set(forbiddenFiles);
  const allowedSet = new Set(allowed);

  return {
    changedFiles: observed,
    inScopeFiles: allowed.filter((file) => !forbidden.has(file)),
    outOfScopeFiles: classifiable.filter((file) => !allowedSet.has(file)),
    forbiddenFiles,
    unsafeFiles,
    unsupportedPatterns,
  };
}
