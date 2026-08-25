// sessionScopedAttribution testai (task 020-b-03): garsi žymė, kai session-writes ledger'io
// failo nebuvo — struktūrizuotas laukas vietoj vien log eilutės. Grynos unit funkcijos, be IO.

import assert from "node:assert/strict";
import { test } from "node:test";
import { sessionScopedAttribution, sessionScopedChangedFiles } from "../domain/git/changes.js";

test("sessionScopedAttribution: ledger yra, su failais — filtruoja kaip sessionScopedChangedFiles, skipped=false", () => {
  const sessionWrites = ["a.ts", "vq/logs/x.log", "../outside.md"];
  const result = sessionScopedAttribution({ sessionWrites, ledgerPresent: true });
  assert.deepEqual(result.changedFiles, sessionScopedChangedFiles(sessionWrites));
  assert.deepEqual(result.changedFiles, ["a.ts"]);
  assert.equal(result.outOfScopeAttributionSkipped, false);
});

test("sessionScopedAttribution: ledger yra, tuščias sąrašas — changedFiles=[], skipped=false", () => {
  const result = sessionScopedAttribution({ sessionWrites: [], ledgerPresent: true });
  assert.deepEqual(result.changedFiles, []);
  assert.equal(result.outOfScopeAttributionSkipped, false);
});

test("sessionScopedAttribution: ledger'io nėra — changedFiles=[], skipped=true", () => {
  const result = sessionScopedAttribution({ sessionWrites: [], ledgerPresent: false });
  assert.deepEqual(result.changedFiles, []);
  assert.equal(result.outOfScopeAttributionSkipped, true);
});

test("sessionScopedAttribution: ledger'io nėra, bet sessionWrites netuščias — vėliavėlė seka ledgerPresent, ne filtro tuštumą", () => {
  const result = sessionScopedAttribution({ sessionWrites: ["a.ts"], ledgerPresent: false });
  assert.deepEqual(result.changedFiles, ["a.ts"]);
  assert.equal(result.outOfScopeAttributionSkipped, true);
});
