import { presentSessionReview } from "../controller/presentation/session-review-presenter.js";
import { reduceAppState, type AppEvent } from "../model/reducer.js";
import type {
  SessionDiffFile,
  SessionDiffLine,
  SessionGateReport,
  SessionReviewSnapshot,
} from "../model/session-review-read.js";
import { initialAppState, type AppState } from "../model/state.js";
import type { SessionReviewViewState } from "../view/session-review-view-state.js";

/**
 * Shared doubles for the session review presentation suites.
 *
 * SKAIDYMAS (VERQESTRA ≤500 eil. vartas; etalone `session-review-presentation.test.ts` buvo 560
 * eilučių). Fikstūra atskirai, nes `snapshot()` yra vienintelis apibrėžimas, kaip atrodo
 * SVEIKA peržiūra: diff'o rinkinys jame keičia `diff`, o įrodymų rinkinys — `gates`/`audit`.
 * Dvi kopijos leistų vienai nutolti, ir „štai kaip atrodo šviežias commit'as" nustotų reikšti
 * tą patį abiejose pusėse.
 */

export const sessionId = "0f0a9b2c-1d3e-4f50-8a61-72b3c4d5e6f7";
export const sourceCommit = "1f2e3d4c5b6a79880011223344556677889900aa";
export const otherCommit = "ccddeeff00112233445566778899aabbccddeeff";
export const digest = "sha256:8a1c0d5e7f6b4a39281706f5e4d3c2b1a09f8e7d6c5b4a3928170615243342ab";

export function line(kind: SessionDiffLine["kind"], text: string): SessionDiffLine {
  return Object.freeze({ kind, text });
}

export function diffFile(path: string, lines: readonly SessionDiffLine[]): SessionDiffFile {
  return Object.freeze({
    path,
    change: "modified" as const,
    binary: false,
    hunks: Object.freeze([Object.freeze({ header: `@@ ${path} @@`, lines: Object.freeze(lines) })]),
    hiddenHunkCount: 0,
  });
}

export function snapshot(overrides: Partial<SessionReviewSnapshot> = {}): SessionReviewSnapshot {
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
      files: Object.freeze([diffFile("src/model/state.ts", [
        line("added", "const answer = 42;"),
        line("removed", "const answer = 41;"),
      ])]),
      totalFileCount: 1,
      addedLineCount: 1,
      removedLineCount: 1,
      truncated: false,
      truncationReason: null,
      digest,
    }),
    gates: null,
    audit: null,
    observedAt: "2026-08-10T10:00:00.000Z",
    ...overrides,
  });
}

export function gateReport(overrides: Partial<SessionGateReport> = {}): SessionGateReport {
  return Object.freeze({
    commit: sourceCommit,
    gates: Object.freeze([
      Object.freeze({ name: "typecheck", passed: true, status: "passed" as const, durationMs: 4_200 }),
      Object.freeze({ name: "test", passed: true, status: "passed" as const, durationMs: 18_000 }),
    ]),
    recordedAt: "2026-08-10T09:59:00.000Z",
    allRequiredPassed: true,
    requiredGateNames: Object.freeze(["typecheck", "test"]),
    digest: "sha256:11223344556677889900aabbccddeeff11223344556677889900aabbccddeeff",
    ...overrides,
  });
}

export function reduce(...events: readonly AppEvent[]): AppState {
  return events.reduce(reduceAppState, initialAppState);
}

/** The healthy screen, with one field of the snapshot replaced. */
export function present(override: Partial<SessionReviewSnapshot> = {}): SessionReviewViewState {
  return presentSessionReview(reduce(
    { type: "session-review.selected", sessionId },
    { type: "session-review.snapshot", snapshot: snapshot(override) },
  ));
}
