import assert from "node:assert/strict";
import test from "node:test";
import type { LocalControlError } from "../application/local-control-errors.js";
import { REQUIRED_GATE_NAMES } from "../application/session-gate-policy.js";
import { SESSION_ID } from "./local-control-doubles.js";
import {
  gateContext,
  OTHER_COMMIT,
  OWNER,
  PASSED,
  refusalOf,
  rejectsWith,
  withContext,
  type GateRegistry,
  type GitScript,
} from "./session-gate-doubles.js";

/**
 * What happens when the world moves WHILE the gates run.
 *
 * SKAIDYMAS (VERQESTRA ≤500 eil. vartas; etalone `session-gates.test.ts` buvo 984 eilutės).
 * Šis pjūvis ne mechaninis: kiekvienas žemiau esantis testas naudoja tą patį įrankį —
 * `answer`/`afterEvidence` kabliuką, kuriuo galima pajudinti registrą TIKSLIU vykdymo momentu.
 * `session-gates.test.ts` testai jo nenaudoja nė karto.
 */

test("a worktree that moved while the gates ran records nothing", async () => {
  const drifts: ReadonlyArray<readonly [string, (git: GitScript) => void]> = [
    ["HEAD moved", (git) => { git.head = OTHER_COMMIT; }],
    ["the tree became dirty", (git) => { git.status = " M src/a.ts\n"; }],
  ];
  for (const [label, drift] of drifts) {
    let apply = (): void => undefined;
    await withContext({
      prefix: "ag-gates-drift-",
      answer: (_request, index) => {
        if (index === REQUIRED_GATE_NAMES.length - 1) apply();
        return PASSED;
      },
    }, async (context) => {
      apply = () => drift(context.git);
      await rejectsWith(
        context.service.runGates({ sessionId: SESSION_ID, actor: OWNER }),
        "conflict",
        label,
      );
      // The gates proved something about a commit the worktree no longer holds,
      // so neither the record nor the disposition may claim otherwise.
      assert.deepEqual(context.evidence.records, [], label);
      assert.equal(context.registry.updates(), 0, label);
      assert.equal(context.registry.state(), "ready", label);
    });
  }
});

test("evidence that could not be written leaves the disposition where it was", async () => {
  await withContext({ prefix: "ag-gates-evidence-fail-", evidenceFails: true }, async (context) => {
    await rejectsWith(
      context.service.runGates({ sessionId: SESSION_ID, actor: OWNER }),
      "internal_error",
      "evidence write failed",
    );
    // Recording the disposition would announce a reviewable worktree whose
    // evidence the integration flow will never find.
    assert.equal(context.registry.updates(), 0);
    assert.equal(context.registry.state(), "ready");
  });
});

test("a second gate run for the same session is refused, never queued", async () => {
  let release = (): void => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const context = await gateContext({
    prefix: "ag-gates-mutex-",
    answer: async (_request, index) => {
      if (index === 0) await held;
      return PASSED;
    },
  });
  try {
    const first = context.service.runGates({ sessionId: SESSION_ID, actor: OWNER });
    await rejectsWith(
      context.service.runGates({ sessionId: SESSION_ID, actor: OWNER }),
      "conflict",
      "a run is already in flight",
    );
    release();
    assert.equal((await first).allPassed, true);

    // The slot is released in `finally`, so the session is runnable again.
    const third = await context.service.runGates({ sessionId: SESSION_ID, actor: OWNER });
    assert.equal(third.allPassed, true);
    assert.equal(context.evidence.records.length, 2);
  } finally {
    release();
    await context.cleanup();
  }
});

test("a worktree that reached a final state during the run is not recorded as reviewable", async () => {
  let drift = (): void => undefined;
  await withContext({
    prefix: "ag-gates-final-",
    answer: (_request, index) => {
      if (index === REQUIRED_GATE_NAMES.length - 1) drift();
      return PASSED;
    },
  }, async (context) => {
    drift = () => context.registry.setState("integrated");
    await rejectsWith(
      context.service.runGates({ sessionId: SESSION_ID, actor: OWNER }),
      "conflict",
      "integrated during the run",
      "Worktree became integrated during the gate run",
    );
    // Nothing at all is written. The disposition is re-read after the gates and
    // before the evidence, so a conflict that is already visible when the gates
    // finish leaves neither a record nor a registry write behind — an evidence
    // file describing a result nobody can use is not a lesser failure, it is a
    // file the operator has to reason about later.
    assert.equal(context.evidence.records.length, 0);
    assert.equal(context.registry.updates(), 0);
    assert.equal(context.registry.state(), "integrated");
  });
});

test("a disposition that changes while the evidence is written still blocks the move", async () => {
  // The narrow window the re-check does NOT close: the worktree moves after
  // `assertStillRunnable` has read it and before the registry mutation runs.
  // Closing it would need an atomic evidence+registry write or a `delete` on the
  // evidence port, and a writer able to erase evidence is the worse property.
  // The guard inside the mutation is what covers this case — without this test
  // it would be unreachable code.
  let drift = (): void => undefined;
  await withContext({
    prefix: "ag-gates-late-drift-",
    afterEvidence: () => drift(),
  }, async (context) => {
    drift = () => context.registry.setState("integrated");
    await rejectsWith(
      context.service.runGates({ sessionId: SESSION_ID, actor: OWNER }),
      "conflict",
      "integrated while the evidence was written",
      "Worktree became integrated during the gate run",
    );
    assert.equal(context.evidence.records.length, 1, "the record really was written");
    assert.equal(context.registry.updates(), 1, "the write was attempted and refused");
    assert.equal(context.registry.state(), "integrated");
  });
});

test("a worktree record that disappeared during the run is refused, not recreated", async () => {
  // The `not_found` half of the drift guards. Until now only `conflict` was
  // exercised, so a service that answered a vanished record with `conflict` — or
  // with a crash on `snapshot.worktrees[sessionId]` — would have looked correct:
  // the registry is a file another process can rewrite, and "the record is gone"
  // is a different fact for the operator than "the worktree moved on".
  let drift = (): void => undefined;
  await withContext({
    prefix: "ag-gates-vanished-",
    answer: (_request, index) => {
      if (index === REQUIRED_GATE_NAMES.length - 1) drift();
      return PASSED;
    },
  }, async (context) => {
    drift = () => context.registry.remove();
    await rejectsWith(
      context.service.runGates({ sessionId: SESSION_ID, actor: OWNER }),
      "not_found",
      "the record vanished during the run",
      "Worktree record disappeared during the gate run",
    );
    assert.equal(context.evidence.records.length, 0, "nothing describes a worktree nobody records");
    assert.equal(context.registry.updates(), 0, "and no write re-creates it");
    assert.equal(context.registry.state(), "missing");
  });
});

/**
 * `assertStillRunnable` documents that "the code and the message are word for
 * word the ones the mutation raises, so the caller cannot tell the two paths
 * apart". That is a claim about two specific strings in two specific places, and
 * nothing compared them: both refusals were only ever asserted by code, and the
 * label argument of `assert.rejects` is printed on failure, never matched.
 *
 * Here the SAME drift is applied on either side of the evidence write, and the
 * two refusals are compared to each other. What may differ is only what was
 * written on the way out — which is the property the open window is allowed to
 * have — never what the caller is told.
 */
test("a drift refused before the evidence and one refused after it are the same refusal", async () => {
  const drifts: ReadonlyArray<readonly [string, (registry: GateRegistry) => void, string, string]> = [
    [
      "a worktree that moved on",
      (registry) => registry.setState("integrated"),
      "conflict",
      "Worktree became integrated during the gate run",
    ],
    [
      "a worktree record that vanished",
      (registry) => registry.remove(),
      "not_found",
      "Worktree record disappeared during the gate run",
    ],
  ];
  for (const [label, drift, code, message] of drifts) {
    let early: LocalControlError | undefined;
    let late: LocalControlError | undefined;

    // Before the evidence: the pure re-check refuses and writes nothing at all.
    let applyEarly = (): void => undefined;
    await withContext({
      prefix: "ag-gates-same-refusal-early-",
      answer: (_request, index) => {
        if (index === REQUIRED_GATE_NAMES.length - 1) applyEarly();
        return PASSED;
      },
    }, async (context) => {
      applyEarly = () => drift(context.registry);
      early = await refusalOf(
        context.service.runGates({ sessionId: SESSION_ID, actor: OWNER }),
        `${label}, before the evidence`,
      );
      assert.equal(context.evidence.records.length, 0, label);
      assert.equal(context.registry.updates(), 0, label);
    });

    // After it: the guard inside the mutation refuses, so a record exists and an
    // attempted write was turned away.
    let applyLate = (): void => undefined;
    await withContext({
      prefix: "ag-gates-same-refusal-late-",
      afterEvidence: () => applyLate(),
    }, async (context) => {
      applyLate = () => drift(context.registry);
      late = await refusalOf(
        context.service.runGates({ sessionId: SESSION_ID, actor: OWNER }),
        `${label}, after the evidence`,
      );
      assert.equal(context.evidence.records.length, 1, label);
      assert.equal(context.registry.updates(), 1, label);
    });

    assert.equal(early?.code, code, label);
    assert.equal(early?.message, message, label);
    assert.equal(late?.code, early?.code, `${label}: the same code, word for word`);
    assert.equal(late?.message, early?.message, `${label}: the same message, word for word`);
  }
});
