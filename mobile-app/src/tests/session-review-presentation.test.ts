import assert from "node:assert/strict";
import test from "node:test";

import { sessionDiffCaps } from "../model/session-review-read.js";
import { diffFile, digest, line, present } from "./session-review-presentation-doubles.js";

/**
 * SKAIDYMAS (VERQESTRA ≤500 eil. vartas; etalone šis failas buvo 560 eilučių). Čia — DIFF'AS:
 * kas patenka į ekraną, kas nukerpama ir kaip ekranas apie tai pasako. Vartų įrodymas, auditas
 * ir kanalo būsena — `session-review-evidence-presentation.test.ts`; bendra fikstūra —
 * `session-review-presentation-doubles.ts`.
 */

test("an empty diff renders an explicit empty-diff label", () => {
  const view = present({
    changedFiles: Object.freeze({ paths: Object.freeze([]), totalCount: 0 }),
    diff: Object.freeze({
      files: Object.freeze([]),
      totalFileCount: 0,
      addedLineCount: 0,
      removedLineCount: 0,
      truncated: false,
      truncationReason: null,
      digest,
    }),
  });

  assert.equal(view.diff.isEmpty, true);
  assert.equal(view.diff.emptyLabel, "No changes: this session produced an empty diff.");
  assert.equal(view.diff.summaryLabel, "0 files changed · +0 / -0");
  assert.equal(view.showUnavailablePlaceholder, false, "an empty diff is an answer, not a gap");
  assert.equal(view.changedFileHiddenCount, 0);
});

test("a truncated diff reports how much is hidden and words the digest as the full diff", () => {
  const view = present({
    changedFiles: Object.freeze({
      paths: Object.freeze(["a.ts", "b.ts", "c.ts"]),
      totalCount: 214,
    }),
    diff: Object.freeze({
      files: Object.freeze([
        diffFile("a.ts", [line("added", "one"), line("added", "two"), line("context", "ctx")]),
        diffFile("b.ts", [line("removed", "three"), line("removed", "four"), line("meta", "meta")]),
      ]),
      totalFileCount: 214,
      addedLineCount: 20_664,
      removedLineCount: 20_664,
      truncated: true,
      truncationReason: "line_limit",
      digest,
    }),
  });

  assert.equal(view.diff.truncated, true);
  assert.equal(
    view.diff.truncationLabel,
    "Showing 4 of 41328 diff lines · 2 of 214 files (capped by the host)",
  );
  // The digest covers the diff the host produced, not the fragment on screen.
  assert.equal(view.diff.digestLabel, `Full-diff digest ${digest}`);
  assert.match(view.diff.digestLabel ?? "", /Full-diff/);
  assert.equal(view.diff.summaryLabel, "214 files changed · +20664 / -20664");
  assert.equal(view.changedFileTotalCount, 214);
});

test("a payload far over the mobile caps still reports the host's own totals", () => {
  // Unlike the hand-built truncation above, this payload is clamped by the Model
  // on its way in, so the whole path — cap, reduce, present — is exercised.
  const files = Array.from({ length: 60 }, (_unused, fileIndex) => diffFile(
    `src/file-${fileIndex}.ts`,
    Array.from(
      { length: 100 },
      (_ignored, lineIndex) => line(lineIndex % 2 === 0 ? "added" : "removed", `${fileIndex}:${lineIndex}`),
    ),
  ));

  const view = present({
    changedFiles: Object.freeze({
      paths: Object.freeze(Array.from({ length: 260 }, (_unused, index) => `src/file-${index}.ts`)),
      totalCount: 260,
    }),
    diff: Object.freeze({
      files: Object.freeze(files),
      totalFileCount: 260,
      addedLineCount: 3_000,
      removedLineCount: 3_000,
      truncated: false,
      truncationReason: null,
      digest,
    }),
  });

  const shownLines = view.diff.files.reduce(
    (sum, file) => sum + file.hunks.reduce((fileSum, hunk) => fileSum + hunk.lines.length, 0),
    0,
  );
  assert.equal(view.diff.files.length, sessionDiffCaps.maxFiles, "the screen is handed at most the cap");
  assert.equal(shownLines, sessionDiffCaps.maxHunkLinesTotal);
  assert.equal(view.diff.truncated, true, "a clamped payload must admit that it is clamped");
  assert.equal(view.diff.isEmpty, false, "a diff too large to carry is not an empty diff");
  // Every number the screen reports as the size of the work is the host's own.
  assert.equal(view.diff.summaryLabel, "260 files changed · +3000 / -3000");
  assert.equal(
    view.diff.truncationLabel,
    "Showing 2000 of 6000 diff lines · 50 of 260 files (capped by the host)",
  );
  assert.equal(view.diff.digestLabel, `Full-diff digest ${digest}`);
  assert.equal(view.changedFiles.length, sessionDiffCaps.maxChangedFilePaths);
  assert.equal(view.changedFileTotalCount, 260);
  assert.equal(view.changedFileHiddenCount, 60);
});

test("an over-long diff line is clipped before it can reach the screen", () => {
  const long = "x".repeat(sessionDiffCaps.maxDiffLineLength + 120);
  const view = present({
    diff: Object.freeze({
      files: Object.freeze([diffFile("src/long.ts", [
        line("added", long),
        line("context", "short"),
      ])]),
      totalFileCount: 1,
      addedLineCount: 1,
      removedLineCount: 0,
      truncated: false,
      truncationReason: null,
      digest,
    }),
  });

  const rows = view.diff.files[0]?.hunks[0]?.lines ?? [];
  assert.equal(rows[0]?.clipped, true);
  assert.equal(rows[0]?.text.length, sessionDiffCaps.maxDiffLineLength);
  assert.equal(rows[0]?.marker, "+");
  assert.ok(!JSON.stringify(view).includes(long), "the untruncated text must never reach view state");
  assert.equal(rows[1]?.clipped, false, "a short line is not marked as clipped");
  assert.equal(rows[1]?.marker, " ");
});

test("every change kind, line marker and binary file is named by the presenter", () => {
  const view = present({
    diff: Object.freeze({
      files: Object.freeze([
        Object.freeze({
          path: "assets/logo.png",
          change: "added" as const,
          binary: true,
          hunks: Object.freeze([]),
          hiddenHunkCount: 0,
        }),
        Object.freeze({
          path: "src/gone.ts",
          change: "deleted" as const,
          binary: false,
          hunks: Object.freeze([Object.freeze({
            header: "@@ -1,3 +0,0 @@",
            lines: Object.freeze([
              line("removed", "const gone = true;"),
              line("meta", "\\ No newline at end of file"),
              line("context", "const kept = true;"),
            ]),
          })]),
          hiddenHunkCount: 3,
        }),
        Object.freeze({
          path: "src/moved.ts",
          change: "renamed" as const,
          binary: false,
          hunks: Object.freeze([]),
          hiddenHunkCount: 1,
        }),
      ]),
      totalFileCount: 3,
      addedLineCount: 0,
      removedLineCount: 1,
      truncated: false,
      truncationReason: null,
      digest,
    }),
  });

  assert.deepEqual(view.diff.files.map((file) => file.changeLabel), ["Added", "Deleted", "Renamed"]);
  // A binary file carries no textual hunks, and that absence is stated rather
  // than rendered as an empty pane that reads like "nothing changed".
  assert.equal(view.diff.files[0]?.binaryLabel, "Binary file — no textual diff");
  assert.deepEqual(view.diff.files[0]?.hunks, []);
  assert.equal(view.diff.isEmpty, false, "a binary-only change is still a change");
  assert.equal(view.diff.files[1]?.binaryLabel, null);
  assert.deepEqual(
    view.diff.files[1]?.hunks[0]?.lines.map((row) => row.marker),
    ["-", "", " "],
    "a meta line carries no gutter marker of its own",
  );
  assert.equal(view.diff.files[1]?.hiddenHunkLabel, "3 hunks not shown");
  assert.equal(view.diff.files[2]?.hiddenHunkLabel, "1 hunk not shown");
  assert.equal(view.diff.files[0]?.hiddenHunkLabel, null, "nothing hidden claims nothing hidden");
});

test("two rows under one path still get distinct render keys", () => {
  // A rename pair reaches the screen as two entries sharing a path; a key made
  // of the path alone would collapse them into one row.
  const view = present({
    diff: Object.freeze({
      files: Object.freeze([
        diffFile("src/same.ts", [line("removed", "old")]),
        diffFile("src/same.ts", [line("added", "new")]),
      ]),
      totalFileCount: 2,
      addedLineCount: 1,
      removedLineCount: 1,
      truncated: false,
      truncationReason: null,
      digest,
    }),
  });

  const fileKeys = view.diff.files.map((file) => file.key);
  const hunkKeys = view.diff.files.flatMap((file) => file.hunks.map((hunk) => hunk.key));
  const lineKeys = view.diff.files.flatMap(
    (file) => file.hunks.flatMap((hunk) => hunk.lines.map((row) => row.key)));

  assert.equal(fileKeys.length, 2);
  assert.equal(new Set(fileKeys).size, 2, "two files under one path must not share a key");
  assert.equal(new Set(hunkKeys).size, hunkKeys.length);
  assert.equal(new Set(lineKeys).size, lineKeys.length);
});

test("the changed-file hidden count uses the host's authoritative total", () => {
  const view = present({
    changedFiles: Object.freeze({
      paths: Object.freeze(["a.ts", "b.ts", "c.ts"]),
      totalCount: 214,
    }),
  });

  assert.deepEqual(view.changedFiles, ["a.ts", "b.ts", "c.ts"]);
  assert.equal(view.changedFileTotalCount, 214);
  assert.equal(view.changedFileHiddenCount, 211);

  // A total that lags behind the sent paths must not become a negative remainder.
  const lagging = present({
    changedFiles: Object.freeze({ paths: Object.freeze(["a.ts", "b.ts"]), totalCount: 1 }),
  });
  assert.equal(lagging.changedFileHiddenCount, 0);
  assert.deepEqual(lagging.changedFiles, ["a.ts", "b.ts"], "the sent paths stay listed");
});
