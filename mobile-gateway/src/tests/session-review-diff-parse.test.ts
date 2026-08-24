import assert from "node:assert/strict";
import test from "node:test";
import { diffDigestOf } from "../application/local-integration-digests.js";
import { projectSessionReview } from "../application/session-review-projection.js";
import {
  addedLinesRecord,
  factsOf,
  fileAt,
  hunkAt,
  MODIFIED_DIFF,
  refusalOf,
  SESSION_ID,
} from "./session-review-doubles.js";

/**
 * SKAIDYMAS (VERQESTRA ≤500 eil. vartas; etalone `session-review-projection.test.ts` buvo 1175
 * eilučių). Čia — PARSERIS ir priešiška įvestis: ką reiškia neatpažinta eilutė, kaip elgiasi
 * git tikrai rašomos išplėstinės antraštės, ir kokia įvestis atmetama, kad į ekraną nepatektų
 * nei mažiau pakeitimų, nei jų yra, nei vardas, kurio negalima parodyti sąžiningai.
 */

/**
 * A parser that skips what it does not recognise loses payload in silence: the
 * hunk body ends at the unexpected line, the changes after it never reach the
 * snapshot, and nothing marks the diff truncated. A review that shows FEWER
 * changes than the repository holds is the dangerous direction to be wrong in,
 * so an unrecognised line is a refusal.
 */
test("a line the parser does not recognise is refused, never dropped in silence", () => {
  const record = (...body: readonly string[]): string => [
    "diff --git a/src/app.ts b/src/app.ts",
    "index 1111111..2222222 100644",
    "--- a/src/app.ts",
    "+++ b/src/app.ts",
    "@@ -1,4 +1,4 @@",
    ...body,
  ].join("\n");

  const malformed: readonly (readonly [string, string])[] = [
    // `diff.suppressBlankEmpty=true` writes an empty context line for an empty
    // source line, so the shape is one a real repository configuration produces.
    [
      "a blank context line inside a hunk",
      record(" const first = 1;", "", "-const third = 3;", "+const third = 4;"),
    ],
    [
      "an unknown line inside a hunk",
      record(" const first = 1;", "something unexpected", "+const third = 4;"),
    ],
    [
      "an unknown line between records",
      `${MODIFIED_DIFF}\nsomething unexpected\n${addedLinesRecord("src/other.ts", 1)}`,
    ],
  ];
  for (const [reason, rawDiff] of malformed) {
    const error = refusalOf(() => projectSessionReview(factsOf({ rawDiff })));
    assert.equal(error.code, "internal_error", reason);
    assert.equal(error.message, "Session diff could not be parsed", reason);
    assert.equal(error.message.includes("const third"), false, reason);
  }
});

test("the extended headers git really writes are recognised rather than refused", () => {
  const rawDiff = [
    "diff --git a/src/app.ts b/src/app.ts",
    "old mode 100644",
    "new mode 100755",
    "similarity index 95%",
    "dissimilarity index 40%",
    "index abc1234..def5678 100644",
    "--- a/src/app.ts",
    "+++ b/src/app.ts",
    "@@ -1 +1 @@",
    "-const third = 3;",
    "+const third = 4;",
  ].join("\n");

  const snapshot = projectSessionReview(factsOf({ rawDiff }));
  assert.deepEqual(snapshot.diff.files.map((file) => [file.path, file.change]), [
    ["src/app.ts", "modified"],
  ]);
  assert.equal(snapshot.diff.addedLineCount, 1);
  assert.equal(snapshot.diff.removedLineCount, 1);
  assert.equal(snapshot.diff.truncated, false);
  // Recognised means "understood and dropped", not "carried through".
  const carried = JSON.stringify(snapshot);
  for (const header of ["100755", "dissimilarity", "abc1234"]) {
    assert.equal(carried.includes(header), false, header);
  }
});

test("the diff's own trailing newline is the one blank line a record may end on", () => {
  const plain = projectSessionReview(factsOf({ rawDiff: MODIFIED_DIFF }));
  const trailing = projectSessionReview(factsOf({ rawDiff: `${MODIFIED_DIFF}\n` }));
  const carriageReturns = projectSessionReview(factsOf({
    rawDiff: `${MODIFIED_DIFF.replace(/\n/g, "\r\n")}\r\n`,
  }));

  for (const snapshot of [trailing, carriageReturns]) {
    assert.equal(snapshot.diff.files.length, 1);
    assert.equal(snapshot.diff.addedLineCount, 1);
    assert.equal(snapshot.diff.removedLineCount, 1);
    assert.equal(snapshot.diff.truncated, false);
    assert.deepEqual(hunkAt(snapshot, 0).lines, hunkAt(plain, 0).lines);
    // Line endings are normalised out of the digest, so the same change keeps
    // the same digest whichever way the host wrote it out.
    assert.equal(snapshot.diff.digest, plain.diff.digest);
  }
});

/**
 * `normalizeDiff` in `local-integration-digests.ts` drops a RUN of trailing
 * newlines, so a producer may hand over more than one — and refusing the whole
 * review over a blank line nobody can see would take the screen away for a
 * reason the operator cannot act on. A blank line before the last content is
 * still a hunk body this parser would abandon, so it still refuses.
 */
test("a run of trailing blank lines ends the diff, while an interior one refuses", () => {
  const plain = projectSessionReview(factsOf({ rawDiff: MODIFIED_DIFF }));
  const padded = projectSessionReview(factsOf({ rawDiff: `${MODIFIED_DIFF}\n\n\n` }));

  assert.equal(padded.diff.files.length, plain.diff.files.length);
  assert.deepEqual(hunkAt(padded, 0).lines, hunkAt(plain, 0).lines);
  assert.equal(padded.diff.truncated, false);

  const interior = refusalOf(() =>
    projectSessionReview(factsOf({ rawDiff: `${MODIFIED_DIFF}\n\n${MODIFIED_DIFF}` }))
  );
  assert.equal(interior.code, "internal_error");
});

/**
 * Distinct from the binary test in `session-review-projection.test.ts`, which
 * asserts what a binary record CONTRIBUTES: this one asserts that the payload's
 * own lines — none of which is a diff line — survive the strict parse only
 * because the record is binary.
 */
test("a binary record's base85 payload is skipped wholesale, not parsed line by line", () => {
  const rawDiff = [
    "diff --git a/assets/blob.bin b/assets/blob.bin",
    "index 1111111..2222222 100644",
    "GIT binary patch",
    "delta 34",
    "zcmZQzU|?fx0zzp3Gcqt7FfcJ%o0m3s",
    "literal 0",
    "HcmV?d00001",
    "",
    MODIFIED_DIFF,
  ].join("\n");

  const snapshot = projectSessionReview(factsOf({ rawDiff }));
  assert.equal(fileAt(snapshot, 0).binary, true);
  assert.deepEqual(fileAt(snapshot, 0).hunks, []);
  assert.equal(snapshot.diff.totalFileCount, 2);
  assert.equal(snapshot.diff.addedLineCount, 1);
  const carried = JSON.stringify(snapshot);
  for (const payload of ["zcmZQz", "HcmV", "delta 34"]) {
    assert.equal(carried.includes(payload), false, payload);
  }

  // The same unreadable lines outside a binary record are refused.
  const error = refusalOf(() => projectSessionReview(factsOf({
    rawDiff: MODIFIED_DIFF.replace("index 1111111..2222222 100644", "HcmV?d00001"),
  })));
  assert.equal(error.message, "Session diff could not be parsed");
});

/**
 * `repositoryRelativePaths` leaves git's C-style quoting in place on purpose:
 * its output is hashed into `diffDigestOf`, and decoding it there would move
 * `diffDigest` and break the preview/confirm comparison. The DTO still has to
 * show a name a human can read — so the list is decoded for the reader while
 * the digest stays on git's own spelling.
 */
test("changed file names are decoded for the reader and hashed as git wrote them", () => {
  // `\305\253` is one two-byte UTF-8 character, `ū`.
  const quoted = String.raw`doc/architekt\305\253ra/x.md`;
  const decoded = "doc/architektūra/x.md";
  const changedFiles = [`"${quoted}"`];
  const rawDiff = [
    `diff --git "a/${quoted}" "b/${quoted}"`,
    "index 1111111..2222222 100644",
    `--- "a/${quoted}"`,
    `+++ "b/${quoted}"`,
    "@@ -1 +1 @@",
    "-before",
    "+after",
  ].join("\n");

  const snapshot = projectSessionReview(factsOf({ changedFiles, rawDiff }));
  assert.deepEqual(snapshot.changedFiles, { paths: [decoded], totalCount: 1 });
  // One name, one spelling: the list and the diff record must not disagree.
  assert.deepEqual(
    [...new Set([...snapshot.changedFiles.paths, ...snapshot.diff.files.map((file) => file.path)])],
    [decoded],
  );
  // The escape itself never reaches the reader. (`diff.digest` is excluded from
  // this check on purpose: it is hex, so any three digits may legitimately occur.)
  assert.equal(JSON.stringify(snapshot.changedFiles).includes("305"), false);
  assert.equal(JSON.stringify(snapshot.diff.files).includes("305"), false);

  // The digest is taken from the UNDECODED list, or the preview it is compared
  // against would never match.
  assert.equal(snapshot.diff.digest, diffDigestOf(changedFiles, rawDiff));
  assert.notEqual(snapshot.diff.digest, diffDigestOf([decoded], rawDiff));
});

test("a changed file name that escapes the working tree once decoded is refused", () => {
  const escaping: readonly (readonly [string, string])[] = [
    ["a quoted traversal", String.raw`"a/../x"`],
    ["a plain traversal", "a/../x"],
    ["a quoted absolute path", String.raw`"/etc/passwd"`],
    // A decoded tab is a real control character; decoding first is what lets the
    // path rule see it at all.
    ["a quoted control character", String.raw`"pa\thas.txt"`],
  ];
  for (const [reason, candidate] of escaping) {
    const error = refusalOf(() => projectSessionReview(factsOf({
      changedFiles: [candidate],
      rawDiff: MODIFIED_DIFF,
    })));
    assert.equal(error.code, "internal_error", reason);
    assert.equal(error.message, "Repository reported a path outside the working tree", reason);
    assert.equal(error.message.includes("passwd"), false, reason);
  }
});

/**
 * The id reaches the snapshot verbatim and the route that carries this
 * projection takes it from a URL path segment, so an unbounded or path-shaped
 * value would travel from the request straight back into the response.
 */
test("a session id the projection would echo back is refused unless it is a plain name", () => {
  const unusable: readonly (readonly [string, string])[] = [
    ["a traversal", "../evil"],
    ["a path segment", "a/b"],
    ["a backslash segment", "a\\b"],
    ["an unbounded value", "a".repeat(300)],
    ["nothing at all", ""],
    ["a leading dot", ".hidden"],
    ["a forged second line", "session\nX-Injected: 1"],
    ["a leading dash", "-oops"],
  ];
  for (const [reason, sessionId] of unusable) {
    const error = refusalOf(() => projectSessionReview(factsOf({
      sessionId,
      rawDiff: MODIFIED_DIFF,
    })));
    assert.equal(error.code, "internal_error", reason);
    assert.equal(error.message, "Session review facts name an unusable session", reason);
    assert.equal(error.message.includes("evil"), false, reason);
    assert.equal(error.message.includes("Injected"), false, reason);
  }

  // The bound is 200 characters, and the ids this gateway really issues fit it.
  for (const sessionId of [SESSION_ID, "a", "a".repeat(200)]) {
    assert.equal(
      projectSessionReview(factsOf({ sessionId, rawDiff: MODIFIED_DIFF })).sessionId,
      sessionId,
    );
  }
  const tooLong = refusalOf(() => projectSessionReview(factsOf({
    sessionId: "a".repeat(201),
    rawDiff: MODIFIED_DIFF,
  })));
  assert.equal(tooLong.message, "Session review facts name an unusable session");
});

test("an observation instant that is not one is refused rather than thrown over", () => {
  for (const observedAt of [new Date("nonsense"), new Date(Number.NaN)]) {
    // `toISOString()` would throw a RangeError here, which is not an answer the
    // local control surface knows how to give.
    const error = refusalOf(() => projectSessionReview(factsOf({
      rawDiff: MODIFIED_DIFF,
      observedAt,
    })));
    assert.equal(error.code, "internal_error");
    assert.equal(error.message, "Session review facts carry an unusable observation instant");
  }
});

test("changed files with no diff to show them is a contradiction the producer must explain", () => {
  const error = refusalOf(() => projectSessionReview(factsOf({
    changedFiles: ["src/app.ts"],
    rawDiff: "",
  })));
  assert.equal(error.code, "internal_error");
  assert.equal(error.message, "Session review facts list changed files but carry no diff for them");
  assert.equal(error.message.includes("src/app.ts"), false);

  const digest = "sha256:2222222222222222222222222222222222222222222222222222222222222222";
  const explained = projectSessionReview(factsOf({
    changedFiles: ["src/app.ts"],
    rawDiff: "",
    rawDiffTruncationReason: "byte_limit",
    diffDigest: digest,
  }));
  assert.deepEqual(explained.diff.files, []);
  assert.equal(explained.diff.totalFileCount, 0);
  assert.equal(explained.diff.truncated, true);
  assert.equal(explained.diff.truncationReason, "byte_limit");
  assert.equal(explained.diff.digest, digest);
  assert.deepEqual(explained.changedFiles.paths, ["src/app.ts"]);

  // A session that changed nothing is not a contradiction.
  const empty = projectSessionReview(factsOf({ changedFiles: [], rawDiff: "" }));
  assert.deepEqual(empty.changedFiles, { paths: [], totalCount: 0 });
  assert.equal(empty.diff.totalFileCount, 0);
  assert.equal(empty.diff.truncated, false);
});

/**
 * The `@@` numbers describe the FILE, not the payload, and a hand-written diff
 * can simply get them wrong — so the counters come from the `+`/`-` lines that
 * were actually seen.
 */
test("hunk header numbers are carried, not believed", () => {
  const lying = [
    "diff --git a/src/app.ts b/src/app.ts",
    "index 1111111..2222222 100644",
    "--- a/src/app.ts",
    "+++ b/src/app.ts",
    "@@ -1,999 +1,999 @@",
    "-const third = 3;",
    "+const third = 4;",
  ].join("\n");

  const snapshot = projectSessionReview(factsOf({ rawDiff: lying }));
  assert.equal(snapshot.diff.addedLineCount, 1);
  assert.equal(snapshot.diff.removedLineCount, 1);
  assert.equal(hunkAt(snapshot, 0).lines.length, 2);
  assert.equal(hunkAt(snapshot, 0).header, "@@ -1,999 +1,999 @@");
  assert.equal(snapshot.diff.truncated, false);

  // A number no line count can hold is not a hunk header.
  const error = refusalOf(() => projectSessionReview(factsOf({
    rawDiff: lying.replace("@@ -1,999 +1,999 @@", "@@ -12345678901 +1 @@"),
  })));
  assert.equal(error.code, "internal_error");
  assert.equal(error.message, "Session diff could not be parsed");
});

test("a rename that also changed content reports the new path and counts its lines", () => {
  const rawDiff = [
    "diff --git a/src/old-name.ts b/src/new-name.ts",
    "similarity index 80%",
    "rename from src/old-name.ts",
    "rename to src/new-name.ts",
    "index 1111111..2222222 100644",
    "--- a/src/old-name.ts",
    "+++ b/src/new-name.ts",
    "@@ -1,2 +1,2 @@",
    " const kept = 1;",
    "-const before = 2;",
    "+const after = 3;",
  ].join("\n");

  const snapshot = projectSessionReview(factsOf({ rawDiff }));
  const file = fileAt(snapshot, 0);
  assert.equal(file.change, "renamed");
  assert.equal(file.path, "src/new-name.ts");
  assert.equal(file.binary, false);
  assert.deepEqual(hunkAt(snapshot, 0).lines.map((line) => line.kind), ["context", "removed", "added"]);
  assert.equal(snapshot.diff.addedLineCount, 1);
  assert.equal(snapshot.diff.removedLineCount, 1);
  // The old name is history, not a file the operator is approving.
  assert.equal(JSON.stringify(snapshot).includes("old-name"), false);
});
