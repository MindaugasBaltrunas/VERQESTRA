import { LocalControlError } from "./local-control-errors.js";

/**
 * The one rule for "a path Git reported about the working tree".
 *
 * It lives on its own because two flows now consume the same Git output: the
 * merge path in `local-integration-service.ts`, which shows the file list to the
 * operator before an integration, and the read-only session review projection,
 * which carries the same names to a phone. Two copies of a refusal rule drift —
 * one gets a case the other never learns about — and the weaker copy would then
 * be the one an attacker reaches. There is exactly one copy here.
 *
 * Every violation is a refusal rather than a filter. A path outside the working
 * tree is not noise to drop quietly: either the output is not the change set it
 * claims to be, or something is trying to make the reader approve a name that
 * does not describe what changed. Both mean the projection must not be built.
 *
 * The message never contains the offending path. It is shown to a human and
 * logged, and an absolute path is precisely the host layout this surface is
 * required to withhold — so the refusal names the rule, never the value.
 */

/** The single refusal message; deliberately free of the value that triggered it. */
const REFUSAL = "Repository reported a path outside the working tree";

/** No repository-relative name is this long; a longer one is a payload, not a path. */
const MAX_PATH_LENGTH = 4096;

/**
 * A path Git never emits for a repository-relative change: rooted, drive-bound
 * or containing a `..` segment.
 *
 * The drive prefix is matched as `[A-Za-z]:` rather than `[A-Za-z]:[/\\]` on
 * purpose. Windows resolves the drive-relative form `C:x` against that drive's
 * own current directory, which is not the repository — so it escapes the working
 * tree just as surely as `C:\x` does, while looking relative.
 */
const ESCAPING_PATH = /^(?:[/\\]|[A-Za-z]:)|(?:^|[/\\])\.\.(?:[/\\]|$)/;

/**
 * C0 and C1 controls. `\0` truncates a path for anything that hands it to the
 * operating system, and `\r`/`\n` let one recorded name forge a second line in
 * whatever list a later reader splits.
 */
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * Bidirectional and format overrides. The path is an approval artefact an
 * operator reads before deciding, and an RTL override lets one name be displayed
 * while another is what actually changed.
 */
const DIRECTION_OVERRIDE = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/;

/**
 * Refuses anything that is not a plain path inside the working tree.
 *
 * @throws LocalControlError `internal_error`, always without the path itself.
 */
export function assertRepositoryRelativePath(candidate: string): void {
  if (candidate.length === 0 || candidate.length > MAX_PATH_LENGTH) {
    throw new LocalControlError("internal_error", REFUSAL);
  }
  if (
    ESCAPING_PATH.test(candidate) ||
    CONTROL_CHARACTER.test(candidate) ||
    DIRECTION_OVERRIDE.test(candidate)
  ) {
    throw new LocalControlError("internal_error", REFUSAL);
  }
  // `git diff --name-only` never names a file under `.git`, so a change that
  // claims to touch one is not a change to the work under review — and
  // `.git/hooks/*` is code the next Git command would run. Every segment is
  // checked, not just the first: a submodule puts its `.git` one level down, so
  // a first-segment test would pass `sub/.git/hooks/pre-commit` through.
  if (candidate.split(/[/\\]/).some((segment) => segment.toLowerCase() === ".git")) {
    throw new LocalControlError("internal_error", REFUSAL);
  }
}

/**
 * The `git diff --name-only` output as a sorted, frozen list of repository
 * relative paths.
 *
 * The sort is the default `Array.prototype.sort` — code-unit order — and must
 * stay that way: this list is hashed into `diffDigestOf`, so a locale-aware
 * comparison would produce a different `diffDigest` on a different host and
 * break the preview/confirm comparison the whole integration flow rests on.
 */
export function repositoryRelativePaths(output: string): readonly string[] {
  const paths = output.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
  for (const candidate of paths) {
    assertRepositoryRelativePath(candidate);
  }
  return Object.freeze([...paths].sort());
}
