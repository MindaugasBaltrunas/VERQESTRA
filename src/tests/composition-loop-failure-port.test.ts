// `coordinatorFailurePort` — dispatch baigties klasifikacija (task 241).
//
// Regresijos vieta: iki 2026-09-05 `isDispatchInfrastructureFailure` skaitydavo VISĄ dispatch
// sesijos transkriptą (`vq/logs/claude-last.log`, stream-json su tool rezultatais) ir ieškodavo
// `ENOENT`. Todėl task'as, kurio failuose guli `new Error("ENOENT: …")`, kiekvieną savo ne-nulinę
// baigtį paversdavo „infrastruktūra": vaikas grąžindavo failą į eilę ir metdavo
// `WorkflowInfrastructureError` su TUO PAČIU kodu 1, o tėvas kodą 1 klasifikuodavo `task-failed`
// (`LOOP_BLOCKED_EXIT_CODE` sąmoningai NĖRA infrastruktūros kodas). Vienas task'as taip nutraukė
// visą bangą du kartus per parą.
//
// Šie testai fiksuoja, kad verdiktą lemia TIK exit kodas ir kad jokio failo skaitymo nebeliko.

import assert from "node:assert/strict";
import test from "node:test";
import { coordinatorFailurePort } from "../composition/loop/coordinator-adapters.js";
import { WorkflowInfrastructureError } from "../shared/errors.js";
import {
  BUDGET_EXCEEDED_EXIT_CODE,
  DIST_STALE_EXIT_CODE,
  DISPATCH_TIMEOUT_EXIT_CODE,
  EXECUTOR_UNAVAILABLE_EXIT_CODE,
  LOOP_BLOCKED_EXIT_CODE,
  POLICY_CONFIG_INVALID_EXIT_CODE,
  USAGE_LIMIT_EXIT_CODE,
} from "../shared/exit-codes.js";

test("isDispatchInfrastructureFailure: exit 1 yra task'o nesėkmė, ne infrastruktūra", async () => {
  // Fabrikas runtime šaknies NEBEIMA — būtent ji buvo vienintelis kelias iki `claude-last.log`.
  // Parametro nebuvimas ir yra vartas: teksto skenavimo grąžinti neįmanoma nepakeitus parašo,
  // o tai lūžtų ir čia, ir `coordinator-execution-adapters.ts` kvietime.
  const port = coordinatorFailurePort();

  assert.equal(
    await port.isDispatchInfrastructureFailure(LOOP_BLOCKED_EXIT_CODE, "166-atkurtas-finished-slot"),
    false,
    "exit 1 yra task'o nesėkmė: jai priklauso diagnozė, o ne bangos abort'as",
  );
});

test("isDispatchInfrastructureFailure: infrastruktūros kodai atpažįstami be jokio teksto", async () => {
  const port = coordinatorFailurePort();

  for (const code of [
    USAGE_LIMIT_EXIT_CODE,
    DIST_STALE_EXIT_CODE,
    POLICY_CONFIG_INVALID_EXIT_CODE,
    EXECUTOR_UNAVAILABLE_EXIT_CODE,
    BUDGET_EXCEEDED_EXIT_CODE,
    DISPATCH_TIMEOUT_EXIT_CODE,
  ]) {
    assert.equal(await port.isDispatchInfrastructureFailure(code, "task"), true, `kodas ${code}`);
  }
});

test("isDispatchInfrastructureFailure: nulis ir kitos task'o nesėkmės — false", async () => {
  const port = coordinatorFailurePort();

  assert.equal(await port.isDispatchInfrastructureFailure(0, "task"), false);
  assert.equal(await port.isDispatchInfrastructureFailure(2, "task"), false, "usage klaida turi savo maršrutą");
  assert.equal(await port.isDispatchInfrastructureFailure(42, "task"), false);
});

test("isInfrastructureExit ir infrastructureError: nepakitęs kontraktas", () => {
  const port = coordinatorFailurePort();

  assert.equal(port.isInfrastructureExit(USAGE_LIMIT_EXIT_CODE), true);
  assert.equal(port.isInfrastructureExit(LOOP_BLOCKED_EXIT_CODE), false);

  const error = port.infrastructureError("dispatch infrastructure failure exit=75 task=x", {
    taskReturnedToQueue: true,
    exitCode: USAGE_LIMIT_EXIT_CODE,
  });
  assert.ok(error instanceof WorkflowInfrastructureError);
  assert.match(error.message, /exit=75/);
  assert.equal(error.exitCode, USAGE_LIMIT_EXIT_CODE);
  assert.equal(error.taskReturnedToQueue, true);
});
