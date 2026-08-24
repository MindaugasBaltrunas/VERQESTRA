import assert from "node:assert/strict";
import test from "node:test";
import {
  MERGE_COMMIT,
  SESSION_ID,
  SOURCE_COMMIT,
  TARGET_HEAD,
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
 * The merge itself: the only file allowed to see a `merge` in the command log.
 *
 * SKAIDYMAS (VERQESTRA ≤500 eil. vartas; etalone `local-integration-flow.test.ts` buvo 686
 * eilutės). Ten — viskas, kas ATMETA prieš merge; čia — kas nutinka, kai merge įvyksta:
 * konfliktas ir jo atsukimas, atsukimas, kuris nepavyko, tėvai, kurių operatorius nepatvirtino,
 * peržiūrų biudžetas, savininko patikra ir pats sėkmingas kelias.
 */

test("a conflicted merge is aborted, leaves HEAD alone and retains the worktree", async () => {
  const context = fixture({ repository: { mergeExitCode: 1 } });
  const preview = await context.service.preview({ sessionId: SESSION_ID, actor: OWNER });
  await rejectsWith(
    context.service.integrate({
      sessionId: SESSION_ID,
      confirmation: confirmationFor(preview),
      actor: OWNER,
      verifyConfirmation: () => true,
    }),
    "conflict",
    "merge conflict",
  );
  assert.deepEqual(writeCalls(context.repository), [
    ["merge", "--no-ff", "--no-edit", SOURCE_COMMIT],
    ["merge", "--abort"],
  ]);
  assert.equal(context.repository.head, TARGET_HEAD);
  assert.equal(context.worktreeState(), "review_ready");
  assert.ok(context.registry.current().worktrees[SESSION_ID]);
});

test("a rollback that did not restore the target is reported instead of tidied away", async () => {
  // The conflict path only claims "the target is unchanged" when it VERIFIED
  // that. Both ways of failing to verify it — the abort itself failing, and an
  // abort that returned with HEAD somewhere other than the previewed commit —
  // must surface as an internal failure and leave the worktree in
  // `locally_integrating`, so an operator sees an unfinished integration rather
  // than a `review_ready` record that says the repository is fine.
  const cases: ReadonlyArray<readonly [string, Partial<FakeRepository>]> = [
    ["the abort command failed", { mergeExitCode: 1, abortExitCode: 1 }],
    ["HEAD did not return to the previewed target", {
      mergeExitCode: 1,
      headAfterAbort: "5".repeat(40),
    }],
  ];
  for (const [label, repository] of cases) {
    const context = fixture({ repository });
    const preview = await context.service.preview({ sessionId: SESSION_ID, actor: OWNER });
    await rejectsWith(
      context.service.integrate({
        sessionId: SESSION_ID,
        confirmation: confirmationFor(preview),
        actor: OWNER,
        verifyConfirmation: () => true,
      }),
      "internal_error",
      label,
    );
    // Exactly the merge and its rollback: a failed rollback is never followed by
    // a second attempt to move the repository.
    assert.deepEqual(writeCalls(context.repository), [
      ["merge", "--no-ff", "--no-edit", SOURCE_COMMIT],
      ["merge", "--abort"],
    ], label);
    assert.equal(context.worktreeState(), "locally_integrating", label);
    assert.ok(context.registry.current().worktrees[SESSION_ID], label);
  }
});

test("a merge whose parents are not the approved pair is refused as an internal failure", async () => {
  // `--no-ff` must produce a commit joining exactly the previewed target head to
  // the previewed source commit. Anything else means the merge did something the
  // operator never approved, so it is never recorded as `integrated` — and it is
  // not rolled back either, because the merge already completed and this service
  // is not allowed to move refs to guess at a repair.
  const cases: ReadonlyArray<readonly [string, readonly string[]]> = [
    ["a foreign first parent", ["9".repeat(40), SOURCE_COMMIT]],
    ["a foreign second parent", [TARGET_HEAD, "9".repeat(40)]],
    ["a single-parent commit", [SOURCE_COMMIT]],
  ];
  for (const [label, mergeParents] of cases) {
    const context = fixture({ repository: { mergeParents } });
    const preview = await context.service.preview({ sessionId: SESSION_ID, actor: OWNER });
    await rejectsWith(
      context.service.integrate({
        sessionId: SESSION_ID,
        confirmation: confirmationFor(preview),
        actor: OWNER,
        verifyConfirmation: () => true,
      }),
      "internal_error",
      label,
    );
    assert.deepEqual(
      writeCalls(context.repository),
      [["merge", "--no-ff", "--no-edit", SOURCE_COMMIT]],
      label,
    );
    assert.notEqual(context.worktreeState(), "integrated", label);
    assert.equal(context.worktreeState(), "locally_integrating", label);
  }
});

test("outstanding previews are bounded, and expiry gives the room back", async () => {
  // The preview table is memory a caller can grow without ever confirming, so it
  // is bounded. Refusing is only acceptable because the bound is temporary: an
  // expired preview cannot be confirmed anyway, so its slot must be reclaimed.
  const context = fixture({ maxPreviews: 2, previewTtlMs: 60_000 });
  const first = await context.service.preview({ sessionId: SESSION_ID, actor: OWNER });
  const second = await context.service.preview({ sessionId: SESSION_ID, actor: OWNER });
  assert.notEqual(first.integrationId, second.integrationId);

  await rejectsWith(
    context.service.preview({ sessionId: SESSION_ID, actor: OWNER }),
    "rate_limited",
    "third outstanding preview",
  );
  assert.deepEqual(writeCalls(context.repository), []);

  context.advance(60_001);
  const afterExpiry = await context.service.preview({ sessionId: SESSION_ID, actor: OWNER });
  assert.notEqual(afterExpiry.integrationId, first.integrationId);
  assert.notEqual(afterExpiry.integrationId, second.integrationId);
  assert.deepEqual(writeCalls(context.repository), []);
});

test("a preview is only reserved for a caller the host proved is the local owner", async () => {
  const context = fixture({ maxPreviews: 1 });
  await rejectsWith(
    context.service.preview({ sessionId: SESSION_ID, actor: { isLocalOsOwner: false } }),
    "forbidden",
    "not the local owner",
  );
  assert.deepEqual(context.repository.calls, [], "a refused caller reads nothing");
  // The refusal cost no room in the bounded table either.
  await context.service.preview({ sessionId: SESSION_ID, actor: OWNER });
});

test("a confirm from anything but the proven local owner never reaches Git", async () => {
  const context = fixture();
  const preview = await context.service.preview({ sessionId: SESSION_ID, actor: OWNER });
  // The preview's own reads are the baseline: what this asserts is not that Git
  // went unused, but that the refused confirm added nothing to the log.
  const afterPreview = context.repository.calls.map((call) => [...call]);
  const stateAfterPreview = context.worktreeState();

  await rejectsWith(
    context.service.integrate({
      sessionId: SESSION_ID,
      confirmation: confirmationFor(preview),
      actor: { isLocalOsOwner: false },
      verifyConfirmation: () => true,
    }),
    "forbidden",
    "not the local owner",
  );
  assert.deepEqual(context.repository.calls, afterPreview, "a refused confirm reads nothing");
  assert.deepEqual(writeCalls(context.repository), []);
  assert.equal(context.worktreeState(), stateAfterPreview);

  // Nor did it spend the operator's approval: the same preview still confirms.
  const result = await context.service.integrate({
    sessionId: SESSION_ID,
    confirmation: confirmationFor(preview),
    actor: OWNER,
    verifyConfirmation: () => true,
  });
  assert.equal(result.mergeCommit, MERGE_COMMIT);
  assert.equal(context.worktreeState(), "integrated");
});

test("a confirmed integration merges once and records the worktree as integrated", async () => {
  const context = fixture();
  const preview = await context.service.preview({ sessionId: SESSION_ID, actor: OWNER });
  const result = await context.service.integrate({
    sessionId: SESSION_ID,
    confirmation: confirmationFor(preview),
    actor: OWNER,
    verifyConfirmation: () => true,
  });
  assert.deepEqual(result, {
    integrationId: preview.integrationId,
    sessionId: SESSION_ID,
    targetBranch: "main",
    targetHeadBefore: TARGET_HEAD,
    targetHeadAfter: MERGE_COMMIT,
    mergeCommit: MERGE_COMMIT,
    strategy: "merge-no-ff",
  });
  assert.deepEqual(writeCalls(context.repository), [["merge", "--no-ff", "--no-edit", SOURCE_COMMIT]]);
  assert.equal(context.worktreeState(), "integrated");

  // The preview is spent: a replay is a duplicate, never a second merge.
  await rejectsWith(
    context.service.integrate({
      sessionId: SESSION_ID,
      confirmation: confirmationFor(preview),
      actor: OWNER,
      verifyConfirmation: () => true,
    }),
    "duplicate_request",
    "replayed preview",
  );
  assert.deepEqual(writeCalls(context.repository), [["merge", "--no-ff", "--no-edit", SOURCE_COMMIT]]);
});
