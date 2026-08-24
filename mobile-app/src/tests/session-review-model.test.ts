import assert from "node:assert/strict";
import test from "node:test";

import { reduceAppState, type AppEvent } from "../model/reducer.js";
import {
  clampSessionReviewSnapshot,
  sessionDiffCaps,
  type SessionDiffFile,
  type SessionDiffLine,
  type SessionReviewFailureCode,
  type SessionReviewLinkState,
  type SessionReviewSnapshot,
} from "../model/session-review-read.js";
import { initialAppState, type AppState } from "../model/state.js";

const sessionId = "0f0a9b2c-1d3e-4f50-8a61-72b3c4d5e6f7";
const otherSessionId = "9e8d7c6b-5a49-4382-91b0-0c1d2e3f4a5b";
const sourceCommit = "1f2e3d4c5b6a79880011223344556677889900aa";

function line(kind: SessionDiffLine["kind"], text: string): SessionDiffLine {
  return Object.freeze({ kind, text });
}

function diffFile(path: string, lineCount: number): SessionDiffFile {
  return Object.freeze({
    path,
    change: "modified" as const,
    binary: false,
    hunks: Object.freeze([Object.freeze({
      header: `@@ ${path} @@`,
      lines: Object.freeze(Array.from(
        { length: lineCount },
        (_unused, index) => line(index % 2 === 0 ? "added" : "removed", `${path}:${index}`),
      )),
    })]),
    hiddenHunkCount: 0,
  });
}

function snapshot(overrides: Partial<SessionReviewSnapshot> = {}): SessionReviewSnapshot {
  return Object.freeze({
    sessionId,
    sessionEnded: true,
    git: Object.freeze({
      sourceBranch: "ag/session-0f0a9b2c",
      sourceCommit,
      targetBranch: "master",
      targetHead: "aabbccddeeff00112233445566778899aabbccdd",
      targetClean: true,
    }),
    changedFiles: Object.freeze({
      paths: Object.freeze(["src/model/state.ts"]),
      totalCount: 1,
    }),
    diff: Object.freeze({
      files: Object.freeze([diffFile("src/model/state.ts", 4)]),
      totalFileCount: 1,
      addedLineCount: 2,
      removedLineCount: 2,
      truncated: false,
      truncationReason: null,
      digest: "sha256:8a1c0d5e7f6b4a39281706f5e4d3c2b1a09f8e7d6c5b4a3928170615243342ab",
    }),
    gates: null,
    audit: null,
    observedAt: "2026-08-10T10:00:00.000Z",
    ...overrides,
  });
}

function reduce(state: AppState, ...events: readonly AppEvent[]): AppState {
  return events.reduce(reduceAppState, state);
}

const selected = reduce(initialAppState, { type: "session-review.selected", sessionId });

test("a snapshot for a session the user already left is dropped", () => {
  const moved = reduce(
    selected,
    { type: "session-review.snapshot", snapshot: snapshot() },
    { type: "session-review.selected", sessionId: otherSessionId },
  );

  // The `sessionId` read answers after the operator moved to another session.
  const late = reduce(moved, { type: "session-review.snapshot", snapshot: snapshot() });

  assert.equal(late, moved, "a stale response must not change any state");
  assert.equal(late.sessionReview, null, "another session's diff must not be rendered");
  assert.equal(late.sessionReviewSessionId, otherSessionId);
});

test("selecting another session drops the previous diff and the previous error", () => {
  const failed = reduce(
    selected,
    { type: "session-review.snapshot", snapshot: snapshot() },
    { type: "session-review.read-failed", failure: "transport_failed" },
  );
  assert.notEqual(failed.sessionReview, null);
  assert.equal(failed.sessionReviewError, "transport_failed");

  const switched = reduce(failed, { type: "session-review.selected", sessionId: otherSessionId });

  assert.equal(switched.sessionReviewSessionId, otherSessionId);
  assert.equal(switched.sessionReview, null);
  assert.equal(switched.sessionReviewError, null, "another session's failure is not this one's");

  // Re-selecting the current session is a no-op and keeps the loaded review.
  assert.equal(reduce(failed, { type: "session-review.selected", sessionId }), failed);
});

test("reads in flight is a counter and never goes negative", () => {
  const overlapping = reduce(
    selected,
    { type: "session-review.read-started" },
    { type: "session-review.read-started" },
  );
  assert.equal(overlapping.sessionReviewReadsInFlight, 2);

  const half = reduce(overlapping, { type: "session-review.read-settled" });
  assert.equal(half.sessionReviewReadsInFlight, 1, "the second read is still outstanding");

  const unmatched = reduce(
    half,
    { type: "session-review.read-settled" },
    { type: "session-review.read-settled" },
  );
  assert.equal(unmatched.sessionReviewReadsInFlight, 0, "an unmatched settle must not go negative");
});

test("a refresh over a healthy link does not flash connecting", () => {
  const connected = reduce(selected, { type: "session-review.snapshot", snapshot: snapshot() });
  assert.equal(connected.sessionReviewLink, "connected");

  const refreshing = reduce(connected, { type: "session-review.read-started" });
  assert.equal(refreshing.sessionReviewLink, "connected", "a refresh must not flash `connecting`");
  assert.equal(refreshing.sessionReviewReadsInFlight, 1);

  // A first read, and a retry over an offline link, do report `connecting`.
  assert.equal(
    reduce(selected, { type: "session-review.read-started" }).sessionReviewLink,
    "connecting",
  );
  const offline = reduce(selected, { type: "session-review.read-failed", failure: "unavailable" });
  assert.equal(
    reduce(offline, { type: "session-review.read-started" }).sessionReviewLink,
    "connecting",
  );
});

test("an oversized diff is clamped without touching a single authoritative counter", () => {
  // Ten large files followed by a long tail: the per-file cap bites first, the
  // shared line budget next, and the file cap last.
  const files = Array.from(
    { length: 214 },
    (_unused, index) => diffFile(`src/file-${index}.ts`, index < 10 ? 498 : 5),
  );
  const totalLines = files.reduce((sum, file) => sum + (file.hunks[0]?.lines.length ?? 0), 0);
  assert.equal(totalLines, 6_000, "the fixture must really be an oversized payload");

  const hostile = snapshot({
    changedFiles: Object.freeze({
      paths: Object.freeze(files.map((file) => file.path)),
      totalCount: 214,
    }),
    diff: Object.freeze({
      files: Object.freeze(files),
      totalFileCount: 214,
      addedLineCount: 3_000,
      removedLineCount: 3_000,
      truncated: false,
      truncationReason: null,
      digest: "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    }),
  });

  const clamped = clampSessionReviewSnapshot(hostile);
  const carriedLines = clamped.diff.files.reduce(
    (sum, file) => sum + file.hunks.reduce((fileSum, hunk) => fileSum + hunk.lines.length, 0),
    0,
  );

  assert.equal(clamped.diff.files.length, sessionDiffCaps.maxFiles);
  assert.equal(carriedLines, sessionDiffCaps.maxHunkLinesTotal);
  for (const file of clamped.diff.files) {
    const fileLines = file.hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0);
    assert.ok(fileLines <= sessionDiffCaps.maxHunkLinesPerFile, `${file.path} exceeds the file cap`);
  }
  assert.equal(clamped.changedFiles.paths.length, sessionDiffCaps.maxChangedFilePaths);
  assert.equal(clamped.diff.truncated, true);
  assert.equal(clamped.diff.truncationReason, "file_limit");
  // A hunk that was dropped whole is reported, never silently missing.
  assert.ok(
    clamped.diff.files.some((file) => file.hiddenHunkCount > 0),
    "dropped hunks must be counted",
  );

  // Everything the screen reports as the size of the work is the host's number.
  assert.equal(clamped.diff.totalFileCount, 214);
  assert.equal(clamped.diff.addedLineCount, 3_000);
  assert.equal(clamped.diff.removedLineCount, 3_000);
  assert.equal(clamped.changedFiles.totalCount, 214);
  assert.equal(clamped.diff.digest, hostile.diff.digest);
});

test("the shared line budget is spent across files, not once per file", () => {
  // Every file stays well under the per-file cap and the file count sits exactly
  // at the file cap, so nothing but the TOTAL budget can clamp this payload: if
  // the budget were per file, all 5 000 lines would be carried.
  const perFile = 100;
  assert.ok(perFile < sessionDiffCaps.maxHunkLinesPerFile, "the per-file cap must not be what bites");
  const files = Array.from(
    { length: sessionDiffCaps.maxFiles },
    (_unused, index) => diffFile(`src/file-${index}.ts`, perFile),
  );
  assert.equal(files.length * perFile, 5_000, "the fixture must exceed the shared budget");

  const wide = snapshot({
    diff: Object.freeze({
      ...snapshot().diff,
      files: Object.freeze(files),
      totalFileCount: sessionDiffCaps.maxFiles,
      addedLineCount: 2_500,
      removedLineCount: 2_500,
    }),
  });

  const clamped = clampSessionReviewSnapshot(wide);
  const carriedLines = clamped.diff.files.reduce(
    (sum, file) => sum + file.hunks.reduce((fileSum, hunk) => fileSum + hunk.lines.length, 0),
    0,
  );

  assert.equal(clamped.diff.files.length, sessionDiffCaps.maxFiles, "no file was dropped here");
  assert.equal(carriedLines, sessionDiffCaps.maxHunkLinesTotal, "the budget is shared, not per file");
  assert.equal(clamped.diff.truncated, true);
  assert.equal(clamped.diff.truncationReason, "line_limit");
  // 20 files spend the whole budget; the remaining 30 keep their entry and report
  // the hunk they lost, so no file silently reads as "nothing changed here".
  assert.equal(clamped.diff.files.filter((file) => file.hiddenHunkCount > 0).length, 30);

  assert.equal(clamped.diff.totalFileCount, sessionDiffCaps.maxFiles);
  assert.equal(clamped.diff.addedLineCount, 2_500);
  assert.equal(clamped.diff.removedLineCount, 2_500);
  assert.equal(clamped.diff.digest, wide.diff.digest);
});

test("the per-file cap clips one hunk and adds to the host's own hidden count", () => {
  const wideFile: SessionDiffFile = Object.freeze({
    path: "src/wide.ts",
    change: "modified" as const,
    binary: false,
    hunks: Object.freeze(Array.from({ length: 3 }, (_unused, hunkIndex) => Object.freeze({
      header: `@@ hunk-${hunkIndex} @@`,
      lines: Object.freeze(Array.from(
        { length: 150 },
        (_ignored, lineIndex) => line("added", `${hunkIndex}:${lineIndex}`),
      )),
    }))),
    // The host already hid two hunks of its own before sending this file.
    hiddenHunkCount: 2,
  });

  const clamped = clampSessionReviewSnapshot(snapshot({
    diff: Object.freeze({
      ...snapshot().diff,
      files: Object.freeze([wideFile]),
      totalFileCount: 1,
      addedLineCount: 450,
      removedLineCount: 0,
    }),
  }));
  const kept = clamped.diff.files[0];

  assert.equal(kept?.hunks.length, 2, "a hunk that got part of the budget stays visible");
  assert.equal(kept?.hunks[0]?.lines.length, 150);
  assert.equal(kept?.hunks[1]?.lines.length, 50, "the second hunk is cut where the file budget ends");
  assert.equal(
    kept?.hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0),
    sessionDiffCaps.maxHunkLinesPerFile,
  );
  assert.equal(kept?.hiddenHunkCount, 3, "the host's own hidden hunks are added to, never replaced");
  assert.equal(clamped.diff.truncated, true);
  assert.equal(clamped.diff.truncationReason, "line_limit");
  assert.equal(clamped.diff.addedLineCount, 450, "the counter still describes the full file");
});

test("a host truncation reason survives a further mobile-side clamp", () => {
  const byteCapped = snapshot({
    diff: Object.freeze({
      ...snapshot().diff,
      files: Object.freeze(Array.from(
        { length: 60 },
        (_unused, index) => diffFile(`src/file-${index}.ts`, 2),
      )),
      totalFileCount: 900,
      truncated: true,
      truncationReason: "byte_limit",
    }),
  });

  const clamped = clampSessionReviewSnapshot(byteCapped);

  assert.equal(clamped.diff.files.length, sessionDiffCaps.maxFiles);
  assert.equal(
    clamped.diff.truncationReason,
    "byte_limit",
    "the host knows why it stopped producing the diff; the clamp only knows why it stopped carrying it",
  );
});

test("audit findings are capped while the host's finding total stays authoritative", () => {
  const noisy = snapshot({
    audit: Object.freeze({
      status: "findings" as const,
      findings: Object.freeze(Array.from({ length: 400 }, (_unused, index) => Object.freeze({
        severity: "warning" as const,
        rule: `rule-${index}`,
        path: `src/file-${index}.ts`,
        message: "Something to look at",
      }))),
      totalFindingCount: 400,
      ranAt: "2026-08-10T10:00:00.000Z",
      commit: sourceCommit,
    }),
  });

  const clamped = clampSessionReviewSnapshot(noisy);

  assert.equal(clamped.audit?.findings.length, sessionDiffCaps.maxAuditFindings);
  assert.equal(clamped.audit?.totalFindingCount, 400);
});

test("an empty diff is stored as empty and stays distinguishable from no snapshot", () => {
  const empty = snapshot({
    changedFiles: Object.freeze({ paths: Object.freeze([]), totalCount: 0 }),
    diff: Object.freeze({
      files: Object.freeze([]),
      totalFileCount: 0,
      addedLineCount: 0,
      removedLineCount: 0,
      truncated: false,
      truncationReason: null,
      digest: "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    }),
  });

  const state = reduce(selected, { type: "session-review.snapshot", snapshot: empty });

  assert.notEqual(state.sessionReview, null, "an empty diff is data, not a missing answer");
  assert.deepEqual(state.sessionReview?.diff.files, []);
  assert.equal(state.sessionReview?.diff.truncated, false, "nothing was clipped, nothing is claimed");
  assert.equal(state.sessionReviewLink, "connected");
  assert.equal(state.sessionReviewError, null);
  assert.equal(initialAppState.sessionReview, null, "no snapshot is a different state entirely");
  assert.equal(
    clampSessionReviewSnapshot(empty),
    empty,
    "a payload within every cap is passed through untouched, so nothing can claim truncation",
  );
});

test("a successful read clears the failure that made the cached review stale", () => {
  const degraded = reduce(
    selected,
    { type: "session-review.snapshot", snapshot: snapshot() },
    { type: "session-review.read-failed", failure: "transport_failed" },
  );
  assert.equal(degraded.sessionReviewLink, "degraded");
  assert.equal(degraded.sessionReviewError, "transport_failed");

  const recovered = reduce(
    degraded,
    { type: "session-review.read-started" },
    // A retry over a degraded link keeps showing the cached review until it lands.
    { type: "session-review.snapshot", snapshot: snapshot({ observedAt: "2026-08-10T10:05:00.000Z" }) },
    { type: "session-review.read-settled" },
  );

  assert.equal(recovered.sessionReviewError, null, "a confirmed read is no longer stale");
  assert.equal(recovered.sessionReviewLink, "connected");
  assert.equal(recovered.sessionReview?.observedAt, "2026-08-10T10:05:00.000Z");
  assert.equal(recovered.sessionReviewReadsInFlight, 0);
});

test("a failed read never upgrades the link quality, for any failure code", () => {
  const codes: readonly SessionReviewFailureCode[] = [
    "not_found",
    "unavailable",
    "unauthorized",
    "invalid_response",
    "transport_failed",
  ];
  const cached = reduce(selected, { type: "session-review.snapshot", snapshot: snapshot() });
  const alreadyOffline = reduce(
    cached,
    { type: "session-review.read-failed", failure: "unavailable" },
  );
  assert.equal(alreadyOffline.sessionReviewLink, "offline");

  for (const failure of codes) {
    const withoutSnapshot = reduce(
      reduce(selected, { type: "session-review.read-started" }),
      { type: "session-review.read-failed", failure },
    );
    assert.equal(withoutSnapshot.sessionReviewLink, "offline", `${failure}: no snapshot is offline`);
    assert.equal(withoutSnapshot.sessionReviewError, failure);

    const withSnapshot = reduce(cached, { type: "session-review.read-failed", failure });
    // Only a host that has no such review, or cannot be reached at all, is
    // offline; every other failure leaves a readable snapshot merely degraded.
    const expected: SessionReviewLinkState =
      failure === "unavailable" || failure === "not_found" ? "offline" : "degraded";
    assert.equal(withSnapshot.sessionReviewLink, expected, `${failure}: cached snapshot`);
    assert.deepEqual(withSnapshot.sessionReview, cached.sessionReview, "the cache stays readable");

    const retried = reduce(alreadyOffline, { type: "session-review.read-failed", failure });
    assert.equal(retried.sessionReviewLink, "offline", `${failure}: an offline link stays offline`);
  }
});
