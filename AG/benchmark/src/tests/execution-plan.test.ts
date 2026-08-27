import assert from "node:assert/strict";
import test from "node:test";

import {
  CONTROL_MODEL_ID,
  MODE_DIFFERENCE_ASPECTS,
  MODE_EXECUTION_PROFILES,
  modeExecutionProfile,
  normalizeExecutionPlan,
  normalizeLimits,
  normalizePrompt,
} from "../application/ports/execution-plan.js";
import { EXECUTION_MODES } from "../domain/result.js";
import { executionSettings, planInput, RUN_MODEL, scenario } from "./execution-fixtures.js";

/**
 * What BENCH-3 requires of the three modes: one plan, held equal wherever that is
 * technically possible, and every remaining difference declared rather than
 * discovered.
 */

test("every execution mode declares a profile, and no profile claims another mode", () => {
  for (const mode of EXECUTION_MODES) {
    const profile = modeExecutionProfile(mode);
    assert.equal(profile.mode, mode);
  }
  assert.deepEqual(
    Object.keys(MODE_EXECUTION_PROFILES).sort(),
    [...EXECUTION_MODES].sort(),
    "a mode without a profile would execute under undeclared conditions",
  );
});

test("every declared difference names a known aspect and a non-empty code and detail", () => {
  for (const mode of EXECUTION_MODES) {
    for (const difference of modeExecutionProfile(mode).differences) {
      assert.ok(
        (MODE_DIFFERENCE_ASPECTS as readonly string[]).includes(difference.aspect),
        `${mode} declares an unknown difference aspect: ${difference.aspect}`,
      );
      assert.notEqual(difference.code, "");
      assert.notEqual(difference.detail, "");
    }
  }
});

test("ag-loop declares that its cell arrives with the approval gates already passed", () => {
  // BENCH-3 honesty for the 2026-08-27 change: the loop's task envelope carries a
  // HUMAN-REVIEW-APPROVED marker, so its human-review numbers are not what the gates would have
  // caught. Undeclared, that reads as "the loop escalates less" — the opposite of what happened.
  const declared = modeExecutionProfile("ag-loop").differences.find(
    (difference) => difference.code === "approval-preapplied",
  );
  assert.ok(declared, "ag-loop no longer declares that approval is pre-applied to its cell task");
  assert.equal(declared.aspect, "prompt");
  assert.match(declared.detail, /HUMAN-REVIEW-APPROVED/);
});

test("a profile cannot be rewritten after a run was measured under it", () => {
  const profile = modeExecutionProfile("ag-loop");
  assert.throws(() => {
    (profile.differences as { length: number }).length = 0;
  });
  assert.throws(() => {
    (profile.differences[0] as { code: string }).code = "rewritten";
  });
  assert.ok(profile.differences.length > 0);
});

test("the prompt, the limits and the checkout are identical across every mode", () => {
  const settings = executionSettings();
  const plans = EXECUTION_MODES.map((mode) => normalizeExecutionPlan(planInput({ mode }), settings));

  const [first] = plans;
  assert.ok(first !== undefined);
  for (const plan of plans) {
    assert.equal(plan.prompt, first.prompt);
    assert.deepEqual(plan.limits, first.limits);
    assert.equal(plan.startCommit, first.startCommit);
    assert.equal(plan.workingDirectory, first.workingDirectory);
    assert.equal(plan.scenarioId, "docs-add-page");
  }
});

test("the model is the run's model for a mode that calls one, and a named absence otherwise", () => {
  const settings = executionSettings();
  assert.equal(normalizeExecutionPlan(planInput({ mode: "ag-loop" }), settings).model, RUN_MODEL);
  assert.equal(
    normalizeExecutionPlan(planInput({ mode: "agent-solo" }), settings).model,
    RUN_MODEL,
  );
  assert.equal(
    normalizeExecutionPlan(planInput({ mode: "deterministic-control" }), settings).model,
    CONTROL_MODEL_ID,
    "an empty model would read as an unknown model rather than as no model",
  );
});

test("a mode that calls a model is refused when the run names none", () => {
  const settings = executionSettings({ modelSettings: { model: "   " } });
  assert.throws(
    () => normalizeExecutionPlan(planInput({ mode: "agent-solo" }), settings),
    /calls a model, but the run configuration names none/,
  );
  assert.doesNotThrow(
    () => normalizeExecutionPlan(planInput({ mode: "deterministic-control" }), settings),
    "the control needs no model, so a missing one cannot stop it",
  );
});

test("network permission is never implicit and never granted to a mode that needs none", () => {
  const settings = executionSettings();
  for (const mode of ["ag-loop", "agent-solo"] as const) {
    assert.equal(
      normalizeExecutionPlan(planInput({ mode, allowNetworkModels: false }), settings)
        .networkPermitted,
      false,
      `${mode} was permitted a network without an explicit opt-in`,
    );
    assert.equal(
      normalizeExecutionPlan(planInput({ mode, allowNetworkModels: true }), settings)
        .networkPermitted,
      true,
    );
  }
  assert.equal(
    normalizeExecutionPlan(
      planInput({ mode: "deterministic-control", allowNetworkModels: true }),
      settings,
    ).networkPermitted,
    false,
    "the control reaches no network, whatever the caller allowed",
  );
});

test("line endings and trailing spaces cannot make one checkout's prompt differ from another's", () => {
  assert.equal(normalizePrompt("Fix the bug.\r\nThen add a test.  \r\n"), "Fix the bug.\nThen add a test.");
  assert.equal(normalizePrompt("\n\n  Add the page.\t\n\n"), "Add the page.");
  assert.equal(
    normalizePrompt("Add the page.\rNow."),
    "Add the page.\nNow.",
    "a lone carriage return is a line ending too",
  );
});

test("a scenario with nothing to ask for is refused rather than executed empty", () => {
  assert.throws(() => normalizePrompt("   \r\n\t "), /task text is empty/);
  assert.throws(
    () => normalizeExecutionPlan(planInput({ scenario: scenario({ task: " " }) }), executionSettings()),
    /task text is empty/,
  );
});

test("the effective limit is the smaller of the scenario's and the run's", () => {
  assert.deepEqual(
    normalizeLimits({ timeoutMs: 60_000, tokenLimit: 900_000 }, { timeoutMs: 600_000, tokenLimit: 500_000 }),
    { timeoutMs: 60_000, tokenLimit: 500_000 },
    "a scenario must not be able to raise what the run was configured to spend",
  );
  assert.deepEqual(
    normalizeLimits({ timeoutMs: 60_000, tokenLimit: 100 }, { timeoutMs: 10_000, tokenLimit: 500_000 }),
    { timeoutMs: 10_000, tokenLimit: 100 },
  );
});

test("an unusable limit is refused, not clamped into something that looks like agent behaviour", () => {
  const ceiling = { timeoutMs: 600_000, tokenLimit: 500_000 };
  for (const broken of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => normalizeLimits({ timeoutMs: broken, tokenLimit: 100 }, ceiling),
      /must be a positive integer/,
      `a timeout of ${String(broken)} was accepted`,
    );
    assert.throws(
      () => normalizeLimits({ timeoutMs: 100, tokenLimit: broken }, ceiling),
      /must be a positive integer/,
      `a token limit of ${String(broken)} was accepted`,
    );
  }
});

test("an execution with no checkout to run in is refused", () => {
  assert.throws(
    () => normalizeExecutionPlan(planInput({ workingDirectory: "" }), executionSettings()),
    /not confined to an isolated checkout/,
  );
});

test("the plan carries its mode's declared differences forward", () => {
  const plan = normalizeExecutionPlan(
    planInput({ mode: "deterministic-control" }),
    executionSettings(),
  );
  assert.deepEqual(
    plan.differences.map((difference) => difference.code).sort(),
    ["no-model-is-called", "prompt-not-delivered", "zero-token-cost"],
  );
});
