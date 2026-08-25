// Task 019: work_evidence gate detail text must reflect whether the gate passed, not always
// read as a failure ("no dispatch usage recorded"). Accepted verdict logic is unchanged.
import assert from "node:assert/strict";
import test from "node:test";
import { evaluateAcceptance } from "../domain/metrics/acceptance-gates.js";

function baseInput() {
  return {
    terminal_state: "done" as const,
    human_review_count: 0,
    out_of_scope_files: [],
    dispatch_attempts: 0,
  };
}

test("work_evidence gate detail reports dispatch attempts when the gate passes", () => {
  const verdict = evaluateAcceptance({ ...baseInput(), dispatch_attempts: 3 });
  const gate = verdict.gates.find((g) => g.name === "work_evidence");
  assert.equal(gate?.passed, true);
  assert.equal(gate?.detail, "3 dispatch attempt(s) recorded");
  assert.equal(verdict.accepted, true);
});

test("work_evidence gate detail reports no usage when the gate fails", () => {
  const verdict = evaluateAcceptance({ ...baseInput(), dispatch_attempts: 0 });
  const gate = verdict.gates.find((g) => g.name === "work_evidence");
  assert.equal(gate?.passed, false);
  assert.equal(gate?.detail, "no dispatch usage recorded");
  assert.equal(verdict.accepted, false);
});
