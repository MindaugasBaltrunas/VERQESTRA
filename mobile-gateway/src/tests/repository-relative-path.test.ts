import assert from "node:assert/strict";
import test from "node:test";
import { LocalControlError } from "../application/local-control-errors.js";
import {
  assertRepositoryRelativePath,
  repositoryRelativePaths,
} from "../application/repository-relative-path.js";

/**
 * The path rule is shared by the integration preview and the read-only review
 * projection, so its refusals are asserted once, here, against the exact message
 * both surfaces show. The message is part of the contract: it names the rule and
 * never the value, because the value is the host layout being withheld.
 */

const REFUSAL = "Repository reported a path outside the working tree";
const NUL = String.fromCharCode(0);
const RIGHT_TO_LEFT_OVERRIDE = String.fromCharCode(0x202e);

function refusalOf(candidate: string): LocalControlError {
  try {
    assertRepositoryRelativePath(candidate);
  } catch (error) {
    assert.ok(error instanceof LocalControlError, "expected a LocalControlError");
    return error;
  }
  return assert.fail("expected the path rule to refuse this candidate");
}

test("repository paths keep their trimmed, sorted, non-empty shape", () => {
  const paths = repositoryRelativePaths("src/b.ts\n  src/a.ts  \n\nsrc/c.ts\n");
  assert.deepEqual(paths, ["src/a.ts", "src/b.ts", "src/c.ts"]);
  assert.equal(Object.isFrozen(paths), true);
  assert.deepEqual(repositoryRelativePaths(""), []);
});

/**
 * Code-unit order, not locale order: this list is hashed into `diffDigestOf`, so
 * a `localeCompare` here would produce a different `diffDigest` on a different
 * host and break every preview/confirm comparison.
 */
test("repository paths sort by code unit rather than by locale", () => {
  assert.deepEqual(repositoryRelativePaths("b.ts\nB.ts\na.ts"), ["B.ts", "a.ts", "b.ts"]);
});

test("a refused path is reported by rule and never by value", () => {
  const error = refusalOf("/etc/passwd");
  assert.equal(error.code, "internal_error");
  assert.equal(error.message, REFUSAL);
  assert.equal(error.message.includes("etc"), false);
  assert.equal(error.message.includes("passwd"), false);
});

test("paths outside the working tree are refused", () => {
  const refused: readonly (readonly [string, string])[] = [
    ["posix absolute", "/etc/passwd"],
    ["drive absolute", "C:/x"],
    // Windows resolves this against the drive's own current directory.
    ["drive relative", "C:x"],
    ["unc share", "\\\\server\\share"],
    ["leading traversal", "../x"],
    ["embedded traversal", "a/../b"],
    ["bare traversal", ".."],
    ["nul byte", `src/a${NUL}.ts`],
    ["newline", "src/a\n.ts"],
    ["direction override", `src/${RIGHT_TO_LEFT_OVERRIDE}sj.ts`],
    ["git internals", ".git/hooks/pre-commit"],
    ["git internals, other case", ".GIT/hooks/pre-commit"],
    ["empty", ""],
    ["oversized", "a".repeat(4097)],
  ];
  for (const [reason, candidate] of refused) {
    const error = refusalOf(candidate);
    assert.equal(error.message, REFUSAL, reason);
  }
});

test("ordinary repository paths are accepted", () => {
  for (const candidate of [
    "a/..b",
    "src/domain/command-intent.ts",
    "doc/architektūra/kelias-ą.md",
    "a".repeat(4096),
  ]) {
    assert.doesNotThrow(() => assertRepositoryRelativePath(candidate));
  }
});

/**
 * Git reports a repository-relative path with `/`, but this rule also guards
 * values a Windows host wrote out — and on Windows `\` is a separator, so a
 * traversal spelled with backslashes escapes the working tree exactly as far as
 * one spelled with slashes.
 */
test("a traversal spelled with backslashes escapes just as far", () => {
  for (const candidate of ["..\\x", "a\\..\\b", "a/..\\b", "a\\..", "a/.."]) {
    assert.equal(refusalOf(candidate).message, REFUSAL, candidate);
  }
});

/**
 * The `.git` guard is a SEGMENT rule: `.gitignore` and `.github/` are ordinary
 * repository files that happen to start with the same four characters, and
 * refusing them would make a legitimate change unreviewable.
 */
test("the git-internals guard reads segments rather than prefixes", () => {
  for (
    const candidate of [
      ".git\\hooks\\pre-commit",
      ".Git/config",
      ".git",
      // A submodule keeps its own `.git` one level down, so a guard that looked
      // only at the first segment would carry the hooks directory through.
      "sub/.git",
      "vendor/lib/.git/hooks/pre-commit",
      "docs\\.GIT\\config",
    ]
  ) {
    assert.equal(refusalOf(candidate).message, REFUSAL, candidate);
  }
  for (const candidate of [".gitignore", ".github/workflows/ci.yml", "src/gitignore.ts"]) {
    assert.doesNotThrow(() => assertRepositoryRelativePath(candidate), candidate);
  }
});

/**
 * The path is an approval artefact a human reads before deciding, so anything
 * that can make the displayed name differ from the changed one is refused —
 * including the C1 range and the bidirectional ISOLATES, which the earlier
 * override cases do not reach.
 */
test("characters that forge or hide a name are refused across their whole range", () => {
  const refused: readonly (readonly [string, string])[] = [
    ["delete", `src/a${String.fromCharCode(0x7f)}.ts`],
    ["c1 next line", `src/a${String.fromCharCode(0x85)}.ts`],
    ["c1 upper bound", `src/a${String.fromCharCode(0x9f)}.ts`],
    ["carriage return", "src/a\r.ts"],
    ["left-to-right mark", `src/${String.fromCharCode(0x200e)}a.ts`],
    ["first strong isolate", `src/${String.fromCharCode(0x2068)}a.ts`],
    ["pop directional isolate", `src/a${String.fromCharCode(0x2069)}.ts`],
  ];
  for (const [reason, candidate] of refused) {
    assert.equal(refusalOf(candidate).message, REFUSAL, reason);
  }
});

test("one bad path refuses the whole list rather than filtering it", () => {
  const error = refusalOf("../escape.ts");
  assert.equal(error.message, REFUSAL);
  assert.throws(
    () => repositoryRelativePaths("src/a.ts\n../escape.ts\nsrc/b.ts"),
    (thrown: unknown) => thrown instanceof LocalControlError && thrown.message === REFUSAL,
  );
});
