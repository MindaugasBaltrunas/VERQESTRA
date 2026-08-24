import assert from "node:assert/strict";
import test from "node:test";
import { gateDigestOf, gatesPassedOf } from "../application/local-integration-digests.js";
import { LocalIntegrationService } from "../application/local-integration-service.js";
import type { SessionGateEvidence } from "../application/ports/session-gate-evidence-port.js";
import { REQUIRED_GATE_NAMES } from "../application/session-gate-policy.js";
import {
  fakeRepository,
  gateEvidence,
  gatePort,
  memoryRegistryStore,
  NOW,
  SESSION_ID,
  SOURCE_COMMIT,
  TARGET_HEAD,
  worktreeRecord,
  type FakeRepository,
} from "./local-control-doubles.js";
import {
  confirmationFor,
  fixture,
  OWNER,
  rejectsWith,
  writeCalls,
} from "./local-integration-doubles.js";

/**
 * The preview/confirm flow of `local-control-contract.md`: everything that
 * REFUSES before a merge is attempted.
 *
 * Two properties are asserted in almost every case: the refusal a caller sees,
 * and the fact that no Git write was attempted.
 *
 * SKAIDYMAS (VERQESTRA ≤500 eil. vartas; etalone šis failas buvo 686 eilutės). Pats merge, jo
 * atsukimas ir tėvų patikra gyvena `local-integration-merge.test.ts` — vieninteliame faile,
 * kuriam apskritai leidžiama pamatyti `merge` komandų žurnale.
 */

test("a preview describes the integration without touching Git state", async () => {
  const context = fixture({ repository: { changedFiles: ["src/b.ts", "src/a.ts"] } });
  const preview = await context.service.preview({ sessionId: SESSION_ID, actor: OWNER });

  assert.equal(preview.sessionId, SESSION_ID);
  assert.equal(preview.sourceBranch, `mobile/${SESSION_ID}`);
  assert.equal(preview.sourceCommit, SOURCE_COMMIT);
  assert.equal(preview.targetBranch, "main");
  assert.equal(preview.targetHead, TARGET_HEAD);
  assert.deepEqual([...preview.changedFiles], ["src/a.ts", "src/b.ts"]);
  assert.match(preview.diffDigest, /^sha256:[0-9a-f]{64}$/);
  assert.match(preview.gateDigest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(preview.gatesPassed, true);
  assert.equal(preview.targetClean, true);
  assert.deepEqual(writeCalls(context.repository), []);
  assert.equal(context.repository.head, TARGET_HEAD);
});

test("a session with no recorded worktree cannot be previewed", async () => {
  const context = fixture();
  await rejectsWith(
    context.service.preview({ sessionId: "223e4567-e89b-42d3-a456-426614174000", actor: OWNER }),
    "not_found",
    "unknown session",
  );
});

test("a recorded branch that is not a plain ref name never reaches a Git argument", async () => {
  // The registry file is writable by the same OS account the session agent runs
  // as, so its branch field is the one Git argument this service does not author
  // itself. A name Git would read as an option or a range is refused before any
  // command is built.
  for (const branch of ["--upload-pack=payload", "-x", "mobile/../../etc", "mobile/a b", ""]) {
    const context = fixture({ worktree: worktreeRecord({ branch }) });
    await rejectsWith(
      context.service.preview({ sessionId: SESSION_ID, actor: OWNER }),
      "internal_error",
      branch,
    );
    assert.deepEqual(context.repository.calls, [], branch);
  }
});

test("a confirmation that differs from the preview never reaches a merge", async () => {
  const cases: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
    ["diff digest", { diffDigest: `sha256:${"9".repeat(64)}` }],
    ["gate digest", { gateDigest: `sha256:${"8".repeat(64)}` }],
    ["source commit", { sourceCommit: "7".repeat(40) }],
    ["target head", { expectedTargetHead: "6".repeat(40) }],
    ["strategy", { strategy: "rebase" }],
  ];
  for (const [label, overrides] of cases) {
    const context = fixture();
    const preview = await context.service.preview({ sessionId: SESSION_ID, actor: OWNER });
    await rejectsWith(
      context.service.integrate({
        sessionId: SESSION_ID,
        confirmation: confirmationFor(preview, overrides),
        actor: OWNER,
        verifyConfirmation: () => true,
      }),
      "invalid_request",
      label,
    );
    assert.deepEqual(writeCalls(context.repository), [], label);
    assert.equal(context.worktreeState(), "review_ready", label);
  }
});

test("an invalid local re-auth proof stops the integration before any read", async () => {
  const context = fixture();
  const preview = await context.service.preview({ sessionId: SESSION_ID, actor: OWNER });
  await rejectsWith(
    context.service.integrate({
      sessionId: SESSION_ID,
      confirmation: confirmationFor(preview),
      actor: OWNER,
      verifyConfirmation: () => false,
    }),
    "forbidden",
    "invalid proof",
  );
  assert.deepEqual(writeCalls(context.repository), []);
});

test("repository state that moved after the preview is a conflict, not a merge", async () => {
  const drifts: ReadonlyArray<readonly [string, (repository: FakeRepository) => void]> = [
    ["target head drift", (repository) => { repository.head = "5".repeat(40); }],
    ["source branch moved", (repository) => { repository.sourceCommit = "4".repeat(40); }],
    ["diff changed", (repository) => { repository.diff = "@@ -0,0 +2 @@\n+other\n"; }],
  ];
  for (const [label, drift] of drifts) {
    const context = fixture();
    const preview = await context.service.preview({ sessionId: SESSION_ID, actor: OWNER });
    drift(context.repository);
    await rejectsWith(
      context.service.integrate({
        sessionId: SESSION_ID,
        confirmation: confirmationFor(preview),
        actor: OWNER,
        verifyConfirmation: () => true,
      }),
      "conflict",
      label,
    );
    assert.deepEqual(writeCalls(context.repository), [], label);
  }
});

test("a dirty target refuses the integration", async () => {
  const context = fixture({ repository: { status: " M src/a.ts\n" } });
  const preview = await context.service.preview({ sessionId: SESSION_ID, actor: OWNER });
  assert.equal(preview.targetClean, false);
  await rejectsWith(
    context.service.integrate({
      sessionId: SESSION_ID,
      confirmation: confirmationFor(preview),
      actor: OWNER,
      verifyConfirmation: () => true,
    }),
    "conflict",
    "dirty target",
  );
  assert.deepEqual(writeCalls(context.repository), []);
});

test("missing or failed gates refuse the integration", async () => {
  const cases: ReadonlyArray<readonly [string, SessionGateEvidence | undefined]> = [
    ["no evidence at all", undefined],
    ["a failed gate", gateEvidence({ gates: [{ name: "test", passed: false }] })],
    ["evidence for another commit", gateEvidence({ commit: "3".repeat(40) })],
    ["an empty gate list", gateEvidence({ gates: [] })],
    // A record that is green as far as it goes, but says nothing about one of
    // the gates the verifier requires. "Not run" and "failed" are the same risk.
    ["a required gate that was never run", gateEvidence({
      gates: REQUIRED_GATE_NAMES
        .filter((name) => name !== "secret")
        .map((name) => ({ name, passed: true })),
    })],
  ];
  for (const [label, evidence] of cases) {
    const context = fixture({ evidence });
    const preview = await context.service.preview({ sessionId: SESSION_ID, actor: OWNER });
    assert.equal(preview.gatesPassed, false, label);
    await rejectsWith(
      context.service.integrate({
        sessionId: SESSION_ID,
        confirmation: confirmationFor(preview),
        actor: OWNER,
        verifyConfirmation: () => true,
      }),
      "conflict",
      label,
    );
    assert.deepEqual(writeCalls(context.repository), [], label);
    // The refusal happens before the worktree is claimed for an integration, so
    // an operator never finds a `locally_integrating` record for work that was
    // rejected on its gates.
    assert.equal(context.worktreeStates().includes("locally_integrating"), false, label);
    assert.equal(context.worktreeState(), "review_ready", label);
  }
});

test("a target that moved after the approval was journalled is refused before the merge", async () => {
  // `locally_integrating` is a durable write, so the repository has had one more
  // chance to move since it was observed. What the operator approved is a
  // SPECIFIC state, and that has to stay true right up to the command that
  // changes it.
  const drifts: ReadonlyArray<readonly [string, (repository: FakeRepository) => void]> = [
    ["HEAD moved", (repository) => { repository.head = "5".repeat(40); }],
    ["the target stopped being clean", (repository) => { repository.status = " M src/a.ts\n"; }],
  ];
  for (const [label, drift] of drifts) {
    const holder: { repository?: FakeRepository } = {};
    const context = fixture({
      onWorktreeState: (state) => {
        if (state === "locally_integrating" && holder.repository) drift(holder.repository);
      },
    });
    holder.repository = context.repository;
    const preview = await context.service.preview({ sessionId: SESSION_ID, actor: OWNER });
    await rejectsWith(
      context.service.integrate({
        sessionId: SESSION_ID,
        confirmation: confirmationFor(preview),
        actor: OWNER,
        verifyConfirmation: () => true,
      }),
      "conflict",
      label,
    );
    // Nothing was touched, so the worktree returns for another review rather
    // than being left mid-flight.
    assert.deepEqual(writeCalls(context.repository), [], label);
    assert.equal(context.worktreeStates().includes("locally_integrating"), true, label);
    assert.equal(context.worktreeState(), "review_ready", label);
  }
});

test("a gate verdict is read from the required list, never from the record itself", async () => {
  const green = REQUIRED_GATE_NAMES.map((name) => ({ name, passed: true }));
  const required = [...REQUIRED_GATE_NAMES];
  // `noUncheckedIndexedAccess`: „pirmas privalomas vartas" yra prielaida, kurią šis testas
  // daro — tad ji ir pasakoma. Tuščias `REQUIRED_GATE_NAMES` sąrašas padarytų kiekvieną įrašą
  // „pilnu", todėl jo tuštumas turi kristi čia, o ne tylėti.
  const firstGate = green[0];
  assert.ok(firstGate, "the required gate list must not be empty");
  const cases: ReadonlyArray<readonly [string, SessionGateEvidence | undefined, boolean]> = [
    ["every required gate, green", gateEvidence({ gates: green }), true],
    ["one required gate missing", gateEvidence({ gates: green.slice(1) }), false],
    ["a required gate recorded twice", gateEvidence({ gates: [...green, firstGate] }), false],
    // A host is free to record more than the minimum, but a recorded failure is
    // a recorded failure whether or not the verifier asked for that gate.
    ["an extra gate that passed", gateEvidence({
      gates: [...green, { name: "licence", passed: true }],
    }), true],
    ["an extra gate that failed", gateEvidence({
      gates: [...green, { name: "licence", passed: false }],
    }), false],
    ["evidence recorded for another commit", gateEvidence({ gates: green, commit: "9".repeat(40) }), false],
    ["no evidence at all", undefined, false],
  ];
  for (const [label, evidence, expected] of cases) {
    assert.equal(gatesPassedOf(evidence, SOURCE_COMMIT, required), expected, label);
  }
});

test("the gate digest moves for a changed outcome and for nothing else", async () => {
  // A digest that moved because a gate took two seconds longer would invalidate
  // an approval for a reason invisible in the preview.
  const base = gateEvidence({ gates: [{ name: "test", passed: true }] });
  const digest = gateDigestOf(base);
  for (const [label, variant] of [
    ["a recorded status", gateEvidence({ gates: [{ name: "test", passed: true, status: "passed" }] })],
    ["a recorded duration", gateEvidence({ gates: [{ name: "test", passed: true, durationMs: 90_000 }] })],
    ["a later instant", gateEvidence({
      gates: [{ name: "test", passed: true }],
      recordedAt: "2027-01-01T00:00:00.000Z",
    })],
  ] as const) {
    assert.equal(gateDigestOf(variant), digest, label);
  }
  assert.notEqual(
    gateDigestOf(gateEvidence({ gates: [{ name: "test", passed: false }] })),
    digest,
    "an inverted outcome",
  );
});

test("a verifier configured with an unusable required gate list refuses to exist", async () => {
  // The policy a verifier applies must come from its own configuration; an empty
  // list would make every record "complete", and a duplicated name would hide a
  // typo behind a gate that happens to be recorded twice.
  for (const [label, requiredGateNames] of [
    ["an empty list", []],
    ["a duplicated name", ["typecheck", "test", "typecheck"]],
  ] as const) {
    assert.throws(
      () => new LocalIntegrationService({
        git: fakeRepository().git,
        registry: memoryRegistryStore(),
        gates: gatePort(gateEvidence()),
        repositoryRootOf: async () => "/repository",
        requiredGateNames,
        clock: () => NOW,
      }),
      (error: unknown) => error instanceof Error && /required gate names are invalid/.test(error.message),
      label,
    );
  }
});

test("an expired preview cannot be confirmed", async () => {
  const context = fixture({ previewTtlMs: 60_000 });
  const preview = await context.service.preview({ sessionId: SESSION_ID, actor: OWNER });
  context.advance(60_001);
  await rejectsWith(
    context.service.integrate({
      sessionId: SESSION_ID,
      confirmation: confirmationFor(preview),
      actor: OWNER,
      verifyConfirmation: () => true,
    }),
    "conflict",
    "expired preview",
  );
  assert.deepEqual(writeCalls(context.repository), []);
});

test("a preview belonging to another session is refused", async () => {
  const context = fixture();
  const preview = await context.service.preview({ sessionId: SESSION_ID, actor: OWNER });
  await rejectsWith(
    context.service.integrate({
      sessionId: "223e4567-e89b-42d3-a456-426614174001",
      confirmation: confirmationFor(preview),
      actor: OWNER,
      verifyConfirmation: () => true,
    }),
    "invalid_request",
    "foreign session",
  );
});

test("a preview moves a ready worktree to review_ready only on observed evidence", async () => {
  const withEvidence = fixture({
    worktree: worktreeRecord({ state: "ready" }),
    sessionState: "ended",
  });
  await withEvidence.service.preview({ sessionId: SESSION_ID, actor: OWNER });
  assert.equal(withEvidence.worktreeState(), "review_ready");

  const withoutGates = fixture({
    worktree: worktreeRecord({ state: "ready" }),
    sessionState: "ended",
    evidence: undefined,
  });
  await withoutGates.service.preview({ sessionId: SESSION_ID, actor: OWNER });
  assert.equal(withoutGates.worktreeState(), "ready", "no recorded gates");

  // A read must not declare work reviewable while the agent is still writing to
  // the tree, and `orphaned` is an unknown outcome rather than a finished one.
  for (const state of ["live", "closing", "orphaned"] as const) {
    const running = fixture({ worktree: worktreeRecord({ state: "ready" }), sessionState: state });
    await running.service.preview({ sessionId: SESSION_ID, actor: OWNER });
    assert.equal(running.worktreeState(), "ready", state);
  }

  // No session record at all proves nothing about the process either.
  const unknownSession = fixture({ worktree: worktreeRecord({ state: "ready" }) });
  await unknownSession.service.preview({ sessionId: SESSION_ID, actor: OWNER });
  assert.equal(unknownSession.worktreeState(), "ready", "no session record");
});
