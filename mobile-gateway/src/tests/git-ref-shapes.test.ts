import assert from "node:assert/strict";
import test from "node:test";
import { isCommitOid, isSafeBranchName } from "../application/git-ref-shapes.js";

/**
 * The ref shapes, tested for the reason they were lifted out of
 * `local-integration-service.ts` in the first place.
 *
 * A branch name from this gateway becomes an ELEMENT OF AN ARGUMENT VECTOR: it
 * is handed to `git rev-parse`/`git merge` as a revision. Two shapes therefore
 * matter more than tidiness — a name beginning with `-` arrives as an OPTION
 * rather than a revision, and a name containing `..` arrives as a RANGE rather
 * than a point. The same predicate is now also the one the read-only review
 * projection uses before echoing a branch name back as fact, so the cases below
 * are asserted against the shared rule rather than against either caller.
 */

/** The shape this gateway actually creates for a session branch. */
const SESSION_BRANCH = "mobile/123e4567-e89b-42d3-a456-426614174010";

test("a branch name that git would read as an option is refused", () => {
  for (const candidate of ["-oops", "--upstream", "-", "-b"]) {
    assert.equal(isSafeBranchName(candidate), false, candidate);
  }
  // The refusal is about the FIRST character, not about the dash itself: the
  // gateway's own names contain dashes.
  assert.equal(isSafeBranchName("mobile/fix-something"), true);
});

test("a branch name that git would read as a range is refused", () => {
  for (const candidate of ["a..b", "..", "master..HEAD", "mobile/x...y", "a..", "..a"]) {
    assert.equal(isSafeBranchName(candidate), false, candidate);
  }
  // A single dot is a legal name character and stays one.
  assert.equal(isSafeBranchName("release.2026.08"), true);
});

test("the branch names this gateway creates are accepted", () => {
  for (const candidate of [SESSION_BRANCH, "master", "a", "A0", "feature/nested/deep-1.2_3"]) {
    assert.equal(isSafeBranchName(candidate), true, candidate);
  }
});

test("a branch name is bounded and holds nothing but name characters", () => {
  // 201 characters is the whole allowance: one leading character plus 200.
  assert.equal(isSafeBranchName("a".repeat(201)), true);
  assert.equal(isSafeBranchName("a".repeat(202)), false);
  assert.equal(isSafeBranchName(""), false);

  for (const candidate of [
    "mobile/with space",
    "mobile/x\ny",
    "mobile/x;rm",
    "mobile/x@{0}",
    "mobile/x$y",
    ".hidden",
    "/leading-slash",
    "mobile/kelias-ą",
  ]) {
    assert.equal(isSafeBranchName(candidate), false, candidate);
  }
});

test("only a full lowercase 40-hex object id is a commit id", () => {
  assert.equal(isCommitOid("a".repeat(40)), true);
  assert.equal(isCommitOid("0123456789abcdef0123456789abcdef01234567"), true);

  const unusable: readonly (readonly [string, string])[] = [
    // An abbreviation is ambiguous by construction, and a longer value is not an id.
    ["thirty-nine characters", "a".repeat(39)],
    ["forty-one characters", "a".repeat(41)],
    ["upper case hex", "A".repeat(40)],
    ["mixed case hex", `${"a".repeat(39)}F`],
    ["non-hex", `${"a".repeat(39)}g`],
    ["a ref name instead of an id", "HEAD"],
    ["a range", `${"a".repeat(40)}..${"b".repeat(40)}`],
    ["empty", ""],
    // Anchors hold at the very end of the value: a forged second line must not
    // ride along inside an id.
    ["a trailing newline", `${"a".repeat(40)}\n`],
    ["a trailing newline with payload", `${"a".repeat(40)}\nrm -rf`],
    ["leading whitespace", ` ${"a".repeat(40)}`],
  ];
  for (const [reason, candidate] of unusable) {
    assert.equal(isCommitOid(candidate), false, reason);
  }
});
