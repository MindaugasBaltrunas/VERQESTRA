// Task 095-a-02: AUDIT_COMPLETE markeris per DiagnosisRulesPort → verifyTask done-already-implemented
// (via "audit-complete"). Atskiras failas nuo task-execution-run.test.ts (500 eilučių vartas jau
// pilnas be baseline'o) — žr. `architecture-gates.test.ts#file-length`.
import assert from "node:assert/strict";
import test from "node:test";
import { createTaskRunState } from "../application/task-execution/task-run-state.js";
import { verifyTask } from "../application/task-execution/verify-task.js";
import { createFakeTaskRunEnv, fakeBucketPath } from "./helpers/fake-task-run-ports.js";

const TASK = "0042";
const TASK_MD = `${TASK}.md`;

async function verifyEnvWithActiveTask() {
  const env = createFakeTaskRunEnv();
  env.behavior.cli = () => 0;
  const file = fakeBucketPath("active", TASK_MD);
  env.files.set(file, "# Task\n## Tikslas\nX");
  const state = await createTaskRunState(file, env.ports, { interrupted: true });
  return { env, state };
}

test("verifyTask: AUDIT_COMPLETE + no-writes + švarus medis → done via audit-complete; wrote/unknown — parkas (task 095)", async () => {
  const { env, state } = await verifyEnvWithActiveTask();
  env.behavior.decision = { status: "ok", decision: { verdict: "done" } };
  env.behavior.git.hasNewHeadSince = false;
  env.behavior.git.changedProductPaths = [];
  env.behavior.git.committedProductWorkSha = undefined;
  env.behavior.git.productDirtyCount = 0;
  const AUDIT = "AUDIT_COMPLETE: auditas baigtas, radinių nerasta";

  // Dvigubas įrodymas (žodis + patvirtintas nulinis rašymas) švariame medyje → done.
  env.behavior.claudeLog = `${AUDIT}\n{"type":"system","subtype":"init","tools":["Read"]}\n{"type":"assistant","message":{"content":[{"type":"tool_use","id":"r1","name":"Read"}]}}`;
  assert.deepEqual(await verifyTask(state, env.ports, { diagnoseCmd: "d" }), {
    kind: "done-already-implemented",
    via: "audit-complete",
  });

  // Markeris yra, bet vykdytojas VIS TIEK rašė → antras įrodymas prieštarauja, parkas.
  env.behavior.claudeLog = `${AUDIT}\n{"type":"system","subtype":"init","tools":["Write"]}\n{"type":"assistant","message":{"content":[{"type":"tool_use","id":"w1","name":"Write"}]}}`;
  const wrote = await verifyTask(state, env.ports, { diagnoseCmd: "d" });
  assert.equal(wrote.kind, "human-review");
  assert.match((wrote as { reason: string }).reason, /AUDIT_COMPLETE marker without confirmed zero-write evidence/);

  // Markeris yra, bet rašymo aktyvumas NEATPAŽINTAS (nėra tool_use įrodymo) → parkas.
  env.behavior.claudeLog = AUDIT;
  const unknown = await verifyTask(state, env.ports, { diagnoseCmd: "d" });
  assert.equal(unknown.kind, "human-review");
  assert.match((unknown as { reason: string }).reason, /AUDIT_COMPLETE marker without confirmed zero-write evidence/);
});
