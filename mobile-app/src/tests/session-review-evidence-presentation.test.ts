import assert from "node:assert/strict";
import test from "node:test";

import { presentSessionReview } from "../controller/presentation/session-review-presenter.js";
import type { SessionReviewFailureCode } from "../model/session-review-read.js";
import { initialAppState } from "../model/state.js";
import type { SessionReviewViewProps } from "../view/contracts.js";
import {
  gateReport,
  otherCommit,
  present,
  reduce,
  sessionId,
  snapshot,
  sourceCommit,
} from "./session-review-presentation-doubles.js";

/**
 * SKAIDYMAS (VERQESTRA ≤500 eil. vartas; žr. `session-review-presentation-doubles.ts`). Čia —
 * ĮRODYMAS ir KANALAS: kaip nusakomi vartai, kurių niekas neįrašė, auditas, kuris nebuvo
 * paleistas, ir peržiūra, kurios skaitymas nepavyko. Diff'as — `session-review-presentation.test.ts`.
 *
 * Šio pjūvio esmė viena: visi šie testai tvirtina, kad NEBUVIMAS niekada nevirsta patvirtinimu.
 */

test("an unwired review port presents as not configured, not as a network failure", () => {
  const view = presentSessionReview(initialAppState);

  assert.equal(view.connection.label, "Not configured");
  assert.equal(view.connection.canRetry, false);
  assert.equal(view.connection.errorMessage, null);
  assert.equal(view.showLoadingPlaceholder, false);
  assert.equal(view.showUnavailablePlaceholder, true, "an empty screen must say why it is empty");
  assert.equal(view.unavailableLabel, "No session selected.");
  assert.deepEqual(view.fingerprint, [], "no fingerprint row may be fabricated");
  assert.deepEqual(view.diff.files, []);
  assert.equal(view.diff.isEmpty, false, "an unread diff is unknown, not empty");
  assert.equal(view.diff.digestLabel, null);
  assert.equal(view.observedAtLabel, null);

  const selectedButUnread = presentSessionReview(reduce(
    { type: "session-review.selected", sessionId },
  ));
  assert.equal(selectedButUnread.unavailableLabel, "No session review has been received yet.");
});

test("every failure code maps to its own message while the cached review stays visible", () => {
  const messages: Readonly<Record<SessionReviewFailureCode, string>> = Object.freeze({
    not_found: "This session has no review record on the host.",
    unavailable: "The session review channel is not reachable.",
    unauthorized: "Device pairing is required.",
    invalid_response: "The session review response was rejected.",
    transport_failed: "The session review read failed.",
  });

  const seen = new Set<string>();
  for (const [failure, message] of Object.entries(messages)) {
    const view = presentSessionReview(reduce(
      { type: "session-review.selected", sessionId },
      { type: "session-review.snapshot", snapshot: snapshot() },
      { type: "session-review.read-failed", failure: failure as SessionReviewFailureCode },
      { type: "session-review.read-settled" },
    ));

    assert.equal(view.connection.errorMessage, message, failure);
    assert.equal(view.connection.stale, true, `${failure}: an unconfirmed review must be stale`);
    assert.equal(view.connection.canRetry, true, `${failure}: the operator may retry`);
    assert.equal(view.showUnavailablePlaceholder, false, `${failure}: cached data is still rendered`);
    assert.equal(view.diff.files.length, 1, `${failure}: the cached diff stays readable`);
    seen.add(message);
  }
  assert.equal(seen.size, 5, "no two failure codes may share a message");
});

test("with no review at all, the gates are not passed and the audit is not run", () => {
  // The honest wording must not depend on a snapshot being present: an empty
  // screen is exactly where an assumed "passed" or "clean" would do most damage.
  const view = presentSessionReview(initialAppState);

  assert.equal(view.gates.available, false);
  assert.equal(view.gates.passed, false);
  assert.equal(view.gates.verdictLabel, "No gate evidence recorded");
  assert.deepEqual(view.gates.missingGateNames, []);
  assert.equal(view.gates.recordedAtLabel, null);
  assert.equal(view.audit.available, false);
  assert.equal(view.audit.statusLabel, "AG audit not run");
  assert.deepEqual(view.audit.rows, []);
  assert.equal(view.sessionStateLabel, "No session review");
  assert.equal(view.targetCleanLabel, "Target state unknown");

  const failed = presentSessionReview(reduce(
    { type: "session-review.selected", sessionId },
    { type: "session-review.read-started" },
    { type: "session-review.read-failed", failure: "unauthorized" },
    { type: "session-review.read-settled" },
  ));
  assert.equal(failed.gates.passed, false, "a failed read proves nothing about the gates");
  assert.equal(failed.audit.statusLabel, "AG audit not run");
  assert.equal(failed.connection.stale, false, "there is no cached review that could be stale");
  assert.equal(failed.connection.errorMessage, "Device pairing is required.");
});

test("missing gate evidence presents as not proven, never as passed", () => {
  const view = present({ gates: null });

  assert.equal(view.gates.available, false);
  assert.equal(view.gates.passed, false);
  assert.equal(view.gates.verdictLabel, "No gate evidence recorded");
  assert.deepEqual(view.gates.rows, []);
  assert.equal(view.gates.recordedAtLabel, null);
  assert.equal(view.gates.stale, false, "absent evidence is not stale evidence");

  const proven = present({ gates: gateReport() });
  assert.equal(proven.gates.passed, true, "recorded, current, complete evidence does pass");
  assert.equal(proven.gates.verdictLabel, "All required gates passed");
});

test("gate evidence recorded for another commit is stale and does not count as passing", () => {
  const view = present({ gates: gateReport({ commit: otherCommit }) });

  assert.equal(view.gates.available, true);
  assert.equal(view.gates.stale, true);
  assert.equal(view.gates.staleLabel, "Evidence was recorded for another commit.");
  assert.equal(view.gates.passed, false, "evidence for another commit proves nothing about this one");
  assert.equal(view.gates.verdictLabel, "Gates did not pass");
  assert.equal(view.gates.rows.length, 2, "the recorded results stay readable");
});

test("a required gate with no recorded result is listed and blocks the verdict", () => {
  const view = present({
    gates: gateReport({
      gates: Object.freeze([
        Object.freeze({ name: "typecheck", passed: true, status: "passed" as const, durationMs: 4_200 }),
      ]),
      requiredGateNames: Object.freeze(["typecheck", "test", "lint"]),
    }),
  });

  assert.deepEqual(view.gates.missingGateNames, ["test", "lint"]);
  assert.equal(view.gates.passed, false, "an unrecorded required gate is not a passed one");
  assert.equal(view.gates.verdictLabel, "Gates did not pass");
  assert.equal(view.gates.rows[0]?.statusLabel, "Passed");
  assert.equal(view.gates.rows[0]?.detailLabel, "4200 ms");

  const failing = present({
    gates: gateReport({
      gates: Object.freeze([
        Object.freeze({ name: "typecheck", passed: false, status: "timed_out" as const, durationMs: null }),
        Object.freeze({ name: "test", passed: true, status: null, durationMs: null }),
      ]),
      allRequiredPassed: false,
    }),
  });
  assert.equal(failing.gates.rows[0]?.statusLabel, "Timed out");
  assert.equal(failing.gates.rows[0]?.detailLabel, null);
  assert.equal(failing.gates.rows[1]?.statusLabel, "Passed", "an unstated status falls back to the flag");
  assert.equal(failing.gates.passed, false);
});

test("an absent AG audit presents as not run, never as clean", () => {
  const view = present({ audit: null });

  assert.equal(view.audit.available, false);
  assert.equal(view.audit.statusLabel, "AG audit not run");
  assert.deepEqual(view.audit.rows, []);
  assert.equal(view.audit.hiddenCount, 0);
  assert.equal(view.audit.stale, false);

  const withFindings = present({
    audit: Object.freeze({
      status: "findings" as const,
      findings: Object.freeze([Object.freeze({
        severity: "error" as const,
        rule: "no-secret",
        path: null,
        message: "A token-shaped literal was found",
      })]),
      totalFindingCount: 7,
      ranAt: "2026-08-10T09:58:00.000Z",
      commit: sourceCommit,
    }),
  });
  assert.equal(withFindings.audit.available, true);
  assert.equal(withFindings.audit.statusLabel, "7 findings");
  assert.equal(withFindings.audit.hiddenCount, 6, "the host's finding total stays authoritative");
  assert.equal(withFindings.audit.rows[0]?.severityLabel, "Error");
  assert.equal(withFindings.audit.rows[0]?.locationLabel, "Whole repository");

  const staleAudit = present({
    audit: Object.freeze({
      status: "clean" as const,
      findings: Object.freeze([]),
      totalFindingCount: 0,
      ranAt: "2026-08-10T09:58:00.000Z",
      commit: otherCommit,
    }),
  });
  assert.equal(staleAudit.audit.stale, true, "an audit of another commit is not this session's audit");
});

test("the session review view state carries no mutation affordance", () => {
  const view = present({ gates: gateReport() });

  assert.equal(view.readOnly, true);
  assert.equal(view.title, "Session review — read-only");
  assert.match(view.title, /read-only/);

  const props: SessionReviewViewProps = { state: view, onRefreshPressed: () => undefined };
  assert.deepEqual(Object.keys(props).sort(), ["onRefreshPressed", "state"]);

  const serialized = JSON.stringify(view);
  for (const forbidden of ["integrationId", "expiresAt", "repositoryRoot", "worktree", "token", "merge"]) {
    assert.ok(!serialized.includes(forbidden), `session review view state leaks ${forbidden}`);
  }
});

test("the review link reports each of its own states with its own label", () => {
  const connecting = presentSessionReview(reduce(
    { type: "session-review.selected", sessionId },
    { type: "session-review.read-started" },
  ));
  assert.equal(connecting.connection.label, "Connecting");
  assert.equal(connecting.showLoadingPlaceholder, true, "a first read has nothing to show yet");
  assert.equal(connecting.connection.canRetry, false, "a read is already in flight");

  const connected = present();
  assert.equal(connected.connection.label, "Connected");
  assert.equal(connected.connection.stale, false);
  assert.equal(connected.sessionLabel, sessionId);
  assert.equal(connected.sessionStateLabel, "Session ended");
  assert.equal(connected.targetCleanLabel, "Target branch is clean");
  assert.equal(connected.observedAtLabel, "2026-08-10T10:00:00.000Z");
  assert.deepEqual(
    connected.fingerprint.map((row) => row.label),
    ["Source branch", "Source commit", "Target branch", "Target head"],
  );

  const degraded = presentSessionReview(reduce(
    { type: "session-review.selected", sessionId },
    { type: "session-review.snapshot", snapshot: snapshot() },
    { type: "session-review.read-failed", failure: "transport_failed" },
    { type: "session-review.read-settled" },
  ));
  assert.equal(degraded.connection.label, "Reconnecting — last known state");

  const offline = presentSessionReview(reduce(
    { type: "session-review.selected", sessionId },
    { type: "session-review.read-started" },
    { type: "session-review.read-failed", failure: "not_found" },
    { type: "session-review.read-settled" },
  ));
  assert.equal(offline.connection.label, "Offline");
  assert.equal(offline.showLoadingPlaceholder, false, "an offline review must not spin forever");
  assert.equal(offline.showUnavailablePlaceholder, true);
});
