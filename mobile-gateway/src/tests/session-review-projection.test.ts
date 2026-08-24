import assert from "node:assert/strict";
import test from "node:test";
import { diffDigestOf } from "../application/local-integration-digests.js";
import { SESSION_REVIEW_CAPS } from "../application/session-review-contract.js";
import {
  parseUnifiedDiff,
  projectSessionReview,
} from "../application/session-review-projection.js";
import {
  addedLinesRecord,
  at,
  carriedLineCount,
  factsOf,
  fileAt,
  hunkAt,
  lineAt,
  manyFiles,
  MODIFIED_DIFF,
  refusalOf,
  SESSION_ID,
  SOURCE_COMMIT,
  TARGET_HEAD,
  OBSERVED_AT,
} from "./session-review-doubles.js";

/**
 * The read-only session review projection, exercised against the diff shapes a
 * real `git diff` produces and against the hostile shapes it never does.
 *
 * No fixture is imported from the mobile app: the client's contract is mirrored
 * by hand in `session-review-contract.ts`, so the caps are asserted through the
 * host's own constant and the client's clamp is checked as an INVARIANT ("what
 * the host produces already satisfies it") rather than by running the client's
 * code here.
 *
 * SKAIDYMAS (VERQESTRA ≤500 eil. vartas; etalone šis failas buvo 1175 eilučių). Čia — SNAPSHOT'AS:
 * klasifikacija, ribos ir digest'ai. Vartų įrodymas ir auditas — `session-review-evidence.test.ts`;
 * parserio kraštiniai atvejai ir priešiškas įvestis — `session-review-diff-parse.test.ts`.
 */

test("the snapshot repeats the observed facts field for field", () => {
  const snapshot = projectSessionReview(factsOf({ rawDiff: MODIFIED_DIFF }));
  assert.equal(snapshot.sessionId, SESSION_ID);
  assert.equal(snapshot.sessionEnded, true);
  assert.deepEqual(snapshot.git, {
    sourceBranch: "mobile/8f2c",
    sourceCommit: SOURCE_COMMIT,
    targetBranch: "master",
    targetHead: TARGET_HEAD,
    targetClean: true,
  });
  assert.equal(snapshot.observedAt, OBSERVED_AT.toISOString());
  assert.deepEqual(snapshot.changedFiles, { paths: ["src/app.ts"], totalCount: 1 });
  assert.equal(snapshot.diff.totalFileCount, 1);
  assert.equal(snapshot.diff.addedLineCount, 1);
  assert.equal(snapshot.diff.removedLineCount, 1);
  assert.equal(snapshot.diff.truncated, false);
  assert.equal(snapshot.diff.truncationReason, null);
});

test("every kind of change is classified, and a rename reports its new path", () => {
  const rawDiff = [
    "diff --git a/src/added.ts b/src/added.ts",
    "new file mode 100644",
    "index 0000000..1111111",
    "--- /dev/null",
    "+++ b/src/added.ts",
    "@@ -0,0 +1,1 @@",
    "+export const added = 1;",
    MODIFIED_DIFF,
    "diff --git a/src/deleted.ts b/src/deleted.ts",
    "deleted file mode 100644",
    "index 2222222..0000000",
    "--- a/src/deleted.ts",
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    "-export const gone = 1;",
    "diff --git a/src/old-name.ts b/src/new-name.ts",
    "similarity index 100%",
    "rename from src/old-name.ts",
    "rename to src/new-name.ts",
  ].join("\n");

  const snapshot = projectSessionReview(factsOf({ rawDiff }));
  assert.deepEqual(
    snapshot.diff.files.map((file) => [file.path, file.change]),
    [
      ["src/added.ts", "added"],
      ["src/app.ts", "modified"],
      ["src/deleted.ts", "deleted"],
      ["src/new-name.ts", "renamed"],
    ],
  );
  // A pure rename has no hunks at all, which is not the same as "no change".
  assert.deepEqual(fileAt(snapshot, 3).hunks, []);
  assert.equal(fileAt(snapshot, 3).binary, false);
  assert.equal(snapshot.diff.addedLineCount, 2);
  assert.equal(snapshot.diff.removedLineCount, 2);
});

/**
 * The section heading after the second `@@` is a line copied out of the file, so
 * it must not ride along inside `header`, where no line budget would ever see it.
 */
test("line markers and the hunk section heading stay out of the payload", () => {
  const rawDiff = [
    "diff --git a/src/app.ts b/src/app.ts",
    "index 1111111..2222222 100644",
    "--- a/src/app.ts",
    "+++ b/src/app.ts",
    "@@ -10,3 +10,4 @@ export function surroundingFunction(): void {",
    " const kept = 1;",
    "-const before = 2;",
    "+const after = 3;",
  ].join("\n");

  const snapshot = projectSessionReview(factsOf({ rawDiff }));
  const hunk = hunkAt(snapshot, 0);
  assert.equal(hunk.header, "@@ -10,3 +10,4 @@");
  assert.deepEqual(hunk.lines, [
    { kind: "context", text: "const kept = 1;" },
    { kind: "removed", text: "const before = 2;" },
    { kind: "added", text: "const after = 3;" },
  ]);
  assert.equal(JSON.stringify(snapshot).includes("surroundingFunction"), false);
});

test("the same change parses with and without context lines", () => {
  const withContext = [
    "diff --git a/src/app.ts b/src/app.ts",
    "index 1111111..2222222 100644",
    "--- a/src/app.ts",
    "+++ b/src/app.ts",
    "@@ -1,5 +1,5 @@",
    " const first = 1;",
    " const second = 2;",
    "-const third = 3;",
    "+const third = 4;",
    " const fourth = 4;",
    " const fifth = 5;",
  ].join("\n");

  const zeroContext = projectSessionReview(factsOf({ rawDiff: MODIFIED_DIFF }));
  const threeContext = projectSessionReview(factsOf({ rawDiff: withContext }));
  for (const snapshot of [zeroContext, threeContext]) {
    assert.equal(snapshot.diff.addedLineCount, 1);
    assert.equal(snapshot.diff.removedLineCount, 1);
    assert.equal(fileAt(snapshot, 0).path, "src/app.ts");
  }
  assert.equal(hunkAt(zeroContext, 0).lines.length, 2);
  assert.deepEqual(
    hunkAt(threeContext, 0).lines.map((line) => line.kind),
    ["context", "context", "removed", "added", "context", "context"],
  );
});

test("a missing trailing newline is a note about the file, not a changed line", () => {
  const rawDiff = [
    "diff --git a/src/app.ts b/src/app.ts",
    "index 1111111..2222222 100644",
    "--- a/src/app.ts",
    "+++ b/src/app.ts",
    "@@ -1 +1 @@",
    "-const third = 3;",
    "\\ No newline at end of file",
    "+const third = 4;",
    "\\ No newline at end of file",
  ].join("\n");

  const snapshot = projectSessionReview(factsOf({ rawDiff }));
  assert.deepEqual(
    hunkAt(snapshot, 0).lines.map((line) => [line.kind, line.text]),
    [
      ["removed", "const third = 3;"],
      ["meta", "No newline at end of file"],
      ["added", "const third = 4;"],
      ["meta", "No newline at end of file"],
    ],
  );
  assert.equal(snapshot.diff.addedLineCount, 1);
  assert.equal(snapshot.diff.removedLineCount, 1);
});

test("binary files are counted but never carry hunks", () => {
  const rawDiff = [
    "diff --git a/assets/img.png b/assets/img.png",
    "index 1111111..2222222 100644",
    "Binary files a/assets/img.png and b/assets/img.png differ",
    "diff --git a/assets/blob.bin b/assets/blob.bin",
    "new file mode 100644",
    "index 0000000..3333333",
    "GIT binary patch",
    "literal 12",
    "zcmZQzU|",
    "",
    "literal 0",
    "HcmV?d00001",
    "",
    MODIFIED_DIFF,
  ].join("\n");

  const snapshot = projectSessionReview(factsOf({ rawDiff }));
  assert.equal(snapshot.diff.totalFileCount, 3);
  for (const file of snapshot.diff.files.slice(0, 2)) {
    assert.equal(file.binary, true);
    assert.deepEqual(file.hunks, []);
    assert.equal(file.hiddenHunkCount, 0);
  }
  assert.deepEqual(snapshot.diff.files.map((file) => file.path), [
    "assets/img.png",
    "assets/blob.bin",
    "src/app.ts",
  ]);
  // The binary payload contributes nothing to the counters.
  assert.equal(snapshot.diff.addedLineCount, 1);
  assert.equal(snapshot.diff.removedLineCount, 1);
});

test("git path quoting is decoded as bytes, once, or refused", () => {
  const quoted = (name: string): string => [
    `diff --git ${name.replace("PREFIX", "a/")} ${name.replace("PREFIX", "b/")}`,
    "index 1111111..2222222 100644",
    `--- ${name.replace("PREFIX", "a/")}`,
    `+++ ${name.replace("PREFIX", "b/")}`,
    "@@ -1 +1 @@",
    "-before",
    "+after",
  ].join("\n");

  // `\303\251` is one two-byte UTF-8 character: decoded per byte it would become
  // two replacement characters instead of `é`.
  const accented = projectSessionReview(factsOf({
    rawDiff: quoted(String.raw`"PREFIXf\303\251.txt"`),
  }));
  assert.equal(fileAt(accented, 0).path, "fé.txt");

  // An escaped quote must not end the token.
  const quotedName = projectSessionReview(factsOf({
    rawDiff: quoted(String.raw`"PREFIXqu\"ote.txt"`),
  }));
  assert.equal(fileAt(quotedName, 0).path, "qu\"ote.txt");

  // `\303\050` is a lead byte followed by `(`: not valid UTF-8, so the name
  // cannot be displayed truthfully and is refused rather than shown mangled.
  const invalid = refusalOf(() => projectSessionReview(factsOf({
    rawDiff: quoted(String.raw`"PREFIXbad\303\050.txt"`),
  })));
  assert.equal(invalid.code, "internal_error");

  // A decoded tab is a real control character, and the path rule refuses those
  // AFTER unquoting — which is the whole point of decoding first.
  const tabbed = refusalOf(() => projectSessionReview(factsOf({
    rawDiff: quoted(String.raw`"PREFIXpa\thas.txt"`),
  })));
  assert.equal(tabbed.message, "Repository reported a path outside the working tree");
});

test("a diff naming a path outside the working tree is refused by rule, not by value", () => {
  const record = (target: string): string => [
    `diff --git a/src/app.ts b/src/app.ts`,
    "index 1111111..2222222 100644",
    "--- a/src/app.ts",
    `+++ ${target}`,
    "@@ -1 +1 @@",
    "-before",
    "+after",
  ].join("\n");

  for (const target of ["b//etc/passwd", "b/../x", String.raw`"b/../x"`]) {
    const error = refusalOf(() => projectSessionReview(factsOf({ rawDiff: record(target) })));
    assert.equal(error.code, "internal_error");
    assert.equal(error.message, "Repository reported a path outside the working tree");
    assert.equal(error.message.includes("etc"), false);
  }
});

test("diff text that is not the diff it claims to be is refused", () => {
  const malformed: readonly (readonly [string, string])[] = [
    ["payload before the first record", ["@@ -1 +1 @@", "-before", "+after"].join("\n")],
    [
      "an unresolvable record header",
      ["diff --git a/src/one.ts b/src/two.ts", "old mode 100644", "new mode 100755"].join("\n"),
    ],
    [
      "a hunk header that is not one",
      [
        "diff --git a/src/app.ts b/src/app.ts",
        "index 1111111..2222222 100644",
        "--- a/src/app.ts",
        "+++ b/src/app.ts",
        "@@ nonsense @@",
        "+after",
      ].join("\n"),
    ],
  ];
  for (const [reason, rawDiff] of malformed) {
    const error = refusalOf(() => projectSessionReview(factsOf({ rawDiff })));
    assert.equal(error.code, "internal_error", reason);
    assert.equal(error.message, "Session diff could not be parsed", reason);
  }
});

test("more files than the cap allows are counted in full and carried in part", () => {
  const rawDiff = manyFiles(60, 1);
  const snapshot = projectSessionReview(factsOf({ rawDiff }));
  assert.equal(snapshot.diff.totalFileCount, 60);
  assert.equal(snapshot.diff.files.length, SESSION_REVIEW_CAPS.maxFiles);
  assert.equal(snapshot.diff.addedLineCount, 60);
  assert.equal(snapshot.diff.truncated, true);
  assert.equal(snapshot.diff.truncationReason, "file_limit");
});

test("the line budget clips per file and in total, hiding only what has no budget", () => {
  const oneBigFile = projectSessionReview(factsOf({ rawDiff: addedLinesRecord("src/big.ts", 300) }));
  // The parse itself is uncapped; the caps are applied by the projection.
  const parsed = parseUnifiedDiff(addedLinesRecord("src/big.ts", 300));
  assert.equal(at(at(parsed.files, 0, "parsed file").hunks, 0, "parsed hunk").lines.length, 300);
  assert.equal(carriedLineCount(oneBigFile), SESSION_REVIEW_CAPS.maxHunkLinesPerFile);
  // A partly funded hunk stays visible rather than disappearing.
  assert.equal(fileAt(oneBigFile, 0).hunks.length, 1);
  assert.equal(fileAt(oneBigFile, 0).hiddenHunkCount, 0);
  assert.equal(oneBigFile.diff.addedLineCount, 300);
  assert.equal(oneBigFile.diff.truncated, true);
  assert.equal(oneBigFile.diff.truncationReason, "line_limit");

  const manyBigFiles = projectSessionReview(factsOf({ rawDiff: manyFiles(12, 300) }));
  assert.equal(carriedLineCount(manyBigFiles), SESSION_REVIEW_CAPS.maxHunkLinesTotal);
  assert.equal(manyBigFiles.diff.files.length, 12);
  assert.equal(fileAt(manyBigFiles, 9).hunks.length, 1);
  // Files past the exhausted budget keep their record and hide their hunks.
  for (const file of manyBigFiles.diff.files.slice(10)) {
    assert.deepEqual(file.hunks, []);
    assert.equal(file.hiddenHunkCount, 1);
  }
  assert.equal(manyBigFiles.diff.truncationReason, "line_limit");
});

test("the file limit outranks the line limit, and the producer outranks both", () => {
  const rawDiff = manyFiles(60, 300);
  assert.equal(projectSessionReview(factsOf({ rawDiff })).diff.truncationReason, "file_limit");

  const producerCut = projectSessionReview(factsOf({
    rawDiff,
    rawDiffTruncationReason: "line_limit",
    diffDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
  }));
  assert.equal(producerCut.diff.truncationReason, "line_limit");
  assert.equal(producerCut.diff.truncated, true);
});

test("carried diff text is bounded per line and in total", () => {
  const longLine = projectSessionReview(factsOf({
    rawDiff: addedLinesRecord("src/bundle.js", 1, "x".repeat(3_000)),
  }));
  const carried = lineAt(longLine, 0, 0, 0);
  assert.equal(carried.text.length, SESSION_REVIEW_CAPS.maxDiffLineChars);
  assert.equal(longLine.diff.truncated, true);
  assert.equal(longLine.diff.truncationReason, "byte_limit");

  const heavy = projectSessionReview(factsOf({
    rawDiff: manyFiles(2, 200, "y".repeat(2_000)),
  }));
  const heavyChars = heavy.diff.files.reduce(
    (total, file) => total + file.hunks.reduce(
      (count, hunk) => count + hunk.lines.reduce((sum, line) => sum + line.text.length, 0),
      0,
    ),
    0,
  );
  assert.ok(heavyChars <= SESSION_REVIEW_CAPS.maxCarriedDiffChars, "carried text stayed in budget");
  assert.equal(fileAt(heavy, 1).hiddenHunkCount, 1);
  assert.equal(heavy.diff.truncationReason, "byte_limit");
});

test("the digest covers the full diff and survives every cap", () => {
  const changedFiles = Array.from({ length: 60 }, (_unused, index) => `src/file-${index}.ts`).sort();
  const rawDiff = manyFiles(60, 1);
  const snapshot = projectSessionReview(factsOf({ changedFiles, rawDiff }));
  assert.equal(snapshot.diff.digest, diffDigestOf(changedFiles, rawDiff));
  assert.equal(snapshot.diff.files.length, SESSION_REVIEW_CAPS.maxFiles);

  const supplied = "sha256:1111111111111111111111111111111111111111111111111111111111111111";
  assert.equal(
    projectSessionReview(factsOf({ changedFiles, rawDiff, diffDigest: supplied })).diff.digest,
    supplied,
  );

  // A digest of a stream the producer already cut short would prove nothing.
  const error = refusalOf(() => projectSessionReview(factsOf({
    rawDiff: MODIFIED_DIFF,
    rawDiffTruncationReason: "byte_limit",
  })));
  assert.equal(error.code, "internal_error");
});

test("the changed file list is capped without claiming the diff was truncated", () => {
  const changedFiles = Array.from(
    { length: 250 },
    (_unused, index) => `src/file-${String(index).padStart(3, "0")}.ts`,
  );
  const snapshot = projectSessionReview(factsOf({ changedFiles, rawDiff: MODIFIED_DIFF }));
  assert.equal(snapshot.changedFiles.paths.length, SESSION_REVIEW_CAPS.maxChangedFilePaths);
  assert.equal(snapshot.changedFiles.totalCount, 250);
  assert.deepEqual(snapshot.changedFiles.paths[0], changedFiles[0]);
  assert.equal(snapshot.diff.truncated, false);
});

/**
 * The client re-applies its own bounds defensively. When the host already
 * satisfies them, that clamp has nothing to change — so the operator reads the
 * host's projection rather than the client's reduction of it.
 */
test("what the host produces already satisfies the client's defensive bounds", () => {
  const snapshot = projectSessionReview(factsOf({ rawDiff: manyFiles(60, 300) }));
  assert.ok(snapshot.diff.files.length <= 50);
  for (const file of snapshot.diff.files) {
    const perFile = file.hunks.reduce((count, hunk) => count + hunk.lines.length, 0);
    assert.ok(perFile <= 200, "per-file line bound");
  }
  assert.ok(carriedLineCount(snapshot) <= 2_000, "total line bound");
  assert.ok(snapshot.changedFiles.paths.length <= 200, "changed path bound");
});

/**
 * The producer computes this fail-closed — a session counts as ended only when
 * its process really is in a terminal state — and the projection must pass the
 * answer through untouched: a diff labelled final while the agent is still
 * writing tells the operator the change set is complete when it is not.
 */
test("a session that has not ended is reported as one that has not ended", () => {
  const running = projectSessionReview(factsOf({ rawDiff: MODIFIED_DIFF, sessionEnded: false }));
  assert.equal(running.sessionEnded, false);
  assert.equal(running.diff.files.length, 1);
  assert.equal(
    projectSessionReview(factsOf({ rawDiff: MODIFIED_DIFF, sessionEnded: true })).sessionEnded,
    true,
  );
});
