/**
 * The shapes a Git ref name and a commit id are allowed to have.
 *
 * They live on their own for the same reason the path rule does: two flows now
 * check the same recorded values — the merge path in
 * `local-integration-service.ts`, where a branch name becomes an element of an
 * argument vector, and the read-only session review projection, where it becomes
 * a name an operator reads before deciding. Two copies of a shape rule drift,
 * and the weaker copy is the one an attacker reaches.
 *
 * Each caller keeps its own refusal message, because the two refusals mean
 * different things: one is "this must not reach Git", the other is "this must
 * not be shown as fact".
 */

/**
 * A branch name that can safely become an argument.
 *
 * A name beginning with `-` would reach `git rev-parse` as an OPTION rather than
 * a revision, so the shape this gateway actually creates (`mobile/<uuid>`) is
 * required and anything else is refused. `..` is excluded separately because Git
 * reads it as a range.
 */
const SAFE_BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$/;

/** A full 40-hex object id; an abbreviation is ambiguous by construction. */
const COMMIT_OID = /^[0-9a-f]{40}$/;

export function isSafeBranchName(value: string): boolean {
  return SAFE_BRANCH.test(value) && !value.includes("..");
}

export function isCommitOid(value: string): boolean {
  return COMMIT_OID.test(value);
}
