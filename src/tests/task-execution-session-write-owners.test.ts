// Rollback'o savininkystės taisyklė be dispatch nonce (auditas 2026-08-29, P1).
//
// Kontekstas: `filterStagePathsByOwnership` be nonce sąmoningai NEMETA nieko — tai Stop
// staging'o kontraktas, kurį dalijasi package guard'as ir diagnozė. Rollback'as tą pačią
// „nieko neįrodyta" būseną paverčia destrukcija: visas bendras ledger'is pakliūva į atstatymo
// aibę ir lygiagrečios sesijos necommit'intas darbas revertinamas. Todėl rollback kelias turi
// SAVO, griežtesnę taisyklę — ją ir užrakina šis failas.
import assert from "node:assert/strict";
import test from "node:test";

import {
  taskScopeRestorePaths,
  taskScopeRestorePlan,
  type SessionWriteOwners,
} from "../application/task-execution/session-write-owners.js";

const OWNERS: SessionWriteOwners = {
  "src/mine.ts": { sessions: ["nonce-1"], tasks: ["890"] },
  "src/theirs.ts": { sessions: ["kitas-nonce"], tasks: ["999"] },
  "src/tuscias.ts": { sessions: [], tasks: [] },
};

test("be nonce: savo task'o kelias atstatomas", () => {
  const plan = taskScopeRestorePlan(["src/mine.ts"], OWNERS, { session: "", taskId: "890" });

  assert.deepEqual(plan.paths, ["src/mine.ts"]);
  assert.deepEqual(plan.foreign, []);
  assert.deepEqual(plan.skipped, []);
});

test("be nonce: svetimos sesijos kelias NEatstatomas ir yra foreign sąraše", () => {
  const plan = taskScopeRestorePlan(["src/mine.ts", "src/theirs.ts"], OWNERS, { session: "", taskId: "890" });

  assert.deepEqual(plan.paths, ["src/mine.ts"]);
  assert.deepEqual(plan.foreign, ["src/theirs.ts"], "svetimas darbas privalo likti nepaliestas");
  assert.deepEqual(plan.skipped, []);
});

test("be nonce: kelias be savininkystės praleidžiamas su priežastimi (fail-closed)", () => {
  const plan = taskScopeRestorePlan(["src/legacy.ts", "src/tuscias.ts"], OWNERS, { session: "", taskId: "890" });

  assert.deepEqual(plan.paths, [], "neįrodyta savininkystė nėra leidimas revertinti");
  assert.deepEqual(plan.foreign, []);
  assert.deepEqual(plan.skipped, [
    { path: "src/legacy.ts", reason: "no-ownership-record" },
    { path: "src/tuscias.ts", reason: "empty-ownership-record" },
  ]);
});

test("be nonce ir be current-task-id: nėra su kuo lyginti, tad neatstatoma niekas", () => {
  const plan = taskScopeRestorePlan(["src/mine.ts", "src/theirs.ts"], OWNERS, { session: "", taskId: "" });

  assert.deepEqual(plan.paths, []);
  assert.deepEqual(plan.skipped.map((skip) => skip.reason), ["unknown-current-task", "unknown-current-task"]);
});

test("su nonce: staging'o taisyklė nepakitusi — be įrašo kelias lieka nuosavas", () => {
  const plan = taskScopeRestorePlan(["src/mine.ts", "src/theirs.ts", "src/legacy.ts"], OWNERS, {
    session: "nonce-1",
    taskId: "890",
  });

  assert.deepEqual(plan.paths, ["src/mine.ts", "src/legacy.ts"]);
  assert.deepEqual(plan.foreign, ["src/theirs.ts"]);
  assert.deepEqual(plan.skipped, [], "su žinoma tapatybe fail-closed praleidimų nėra");
});

test("runtime keliai nepatenka nei į paths, nei į foreign/skipped ataskaitą", () => {
  const plan = taskScopeRestorePlan(["vq/state/x.json", "src/mine.ts"], OWNERS, { session: "", taskId: "890" });

  assert.deepEqual(plan.paths, ["src/mine.ts"]);
  assert.deepEqual(plan.foreign, []);
  assert.deepEqual(plan.skipped, [], "loop'o buhalterija nėra praleistas produkto darbas");
});

test("taskScopeRestorePaths lieka porto parašas: plano keliai be papildomos formos", () => {
  const identity = { session: "", taskId: "890" };
  const input = ["src/mine.ts", "src/theirs.ts", "src/legacy.ts"];

  assert.deepEqual(taskScopeRestorePaths(input, OWNERS, identity), taskScopeRestorePlan(input, OWNERS, identity).paths);
});
