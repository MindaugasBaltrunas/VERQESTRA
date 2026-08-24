import assert from "node:assert/strict";
import { LocalControlError } from "../application/local-control-errors.js";
import { REQUIRED_GATE_NAMES } from "../application/session-gate-policy.js";
import type { SessionReviewSnapshot } from "../application/session-review-contract.js";
import type { SessionReviewFacts } from "../application/session-review-projection.js";
import type { SessionGateEvidence } from "../application/ports/session-gate-evidence-port.js";

/**
 * Shared doubles for the session review suites.
 *
 * SKAIDYMAS (VERQESTRA ≤500 eil. vartas; etalone `session-review-projection.test.ts` buvo 1175
 * eilučių). Fikstūra atskirai, nes `factsOf` yra vienintelis apibrėžimas, kaip atrodo TEISĖTAS
 * faktų rinkinys — visi atmetimo testai keičia jame po vieną lauką. Trys kopijos leistų vienai
 * nepastebimai nutolti, ir dalis „atmesta dėl X" testų atmestų dėl Y.
 */

export const SESSION_ID = "11111111-2222-4333-8444-555555555555";
export const SOURCE_COMMIT = "a".repeat(40);
export const TARGET_HEAD = "b".repeat(40);
export const OBSERVED_AT = new Date("2026-08-11T10:20:30.000Z");
export const RECORDED_AT = "2026-08-11T10:00:00.000Z";
export const ESCAPE = String.fromCharCode(0x1b);
/** Assembled from parts so the repository secret scan does not match this file. */
export const TOKEN_CANARY = "ghp_" + "a".repeat(20);

export function factsOf(overrides: Partial<SessionReviewFacts> = {}): SessionReviewFacts {
  return {
    sessionId: SESSION_ID,
    sessionEnded: true,
    sourceBranch: "mobile/8f2c",
    sourceCommit: SOURCE_COMMIT,
    targetBranch: "master",
    targetHead: TARGET_HEAD,
    targetClean: true,
    changedFiles: ["src/app.ts"],
    rawDiff: "",
    observedAt: OBSERVED_AT,
    ...overrides,
  };
}

export function evidenceOf(overrides: Partial<SessionGateEvidence> = {}): SessionGateEvidence {
  return {
    sessionId: SESSION_ID,
    commit: SOURCE_COMMIT,
    recordedAt: RECORDED_AT,
    gates: REQUIRED_GATE_NAMES.map((name) => ({
      name,
      passed: true,
      status: "passed" as const,
      durationMs: 1_000,
    })),
    ...overrides,
  };
}

export function refusalOf(run: () => unknown): LocalControlError {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof LocalControlError, "expected a LocalControlError");
    return error;
  }
  return assert.fail("expected the projection to refuse these facts");
}

/** One ordinary modification record with `count` added lines. */
export function addedLinesRecord(path: string, count: number, text = "const value = 1;"): string {
  return [
    `diff --git a/${path} b/${path}`,
    "index 1111111..2222222 100644",
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1,${count} +1,${count} @@`,
    ...Array.from({ length: count }, () => `+${text}`),
  ].join("\n");
}

export function manyFiles(count: number, linesPerFile: number, text?: string): string {
  return Array.from(
    { length: count },
    (_unused, at) => addedLinesRecord(`src/file-${at}.ts`, linesPerFile, text),
  ).join("\n");
}

export function carriedLineCount(snapshot: SessionReviewSnapshot): number {
  return snapshot.diff.files.reduce(
    (total, file) => total + file.hunks.reduce((count, hunk) => count + hunk.lines.length, 0),
    0,
  );
}

export const MODIFIED_DIFF = [
  "diff --git a/src/app.ts b/src/app.ts",
  "index 1111111..2222222 100644",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -3 +3 @@",
  "-const third = 3;",
  "+const third = 4;",
].join("\n");

/**
 * NUKRYPIMAS (formos, ne elgesio): `noUncheckedIndexedAccess` daro kiekvieną `files[0]`
 * `| undefined`. Etalonas indeksavo tiesiogiai; čia indeksas virsta ĮVARDYTU teiginiu, o ne
 * `!` operatoriumi. Skirtumas praktinis: kai projekcija grąžins mažiau failų nei testas
 * laukia, pranešimas pasakys „no diff file at index 3", o ne „cannot read property of undefined".
 */
export function at<T>(items: readonly T[], index: number, label: string): T {
  const item = items[index];
  assert.ok(item, `${label}: nothing at index ${index}`);
  return item;
}

type DiffFile = SessionReviewSnapshot["diff"]["files"][number];
type DiffHunk = DiffFile["hunks"][number];
type DiffLine = DiffHunk["lines"][number];

export function fileAt(snapshot: SessionReviewSnapshot, index: number): DiffFile {
  return at(snapshot.diff.files, index, "diff file");
}

export function hunkAt(snapshot: SessionReviewSnapshot, fileIndex: number, hunkIndex = 0): DiffHunk {
  return at(fileAt(snapshot, fileIndex).hunks, hunkIndex, `hunk of file ${fileIndex}`);
}

export function lineAt(
  snapshot: SessionReviewSnapshot,
  fileIndex: number,
  hunkIndex: number,
  lineIndex: number,
): DiffLine {
  return at(hunkAt(snapshot, fileIndex, hunkIndex).lines, lineIndex, `line of file ${fileIndex}`);
}
