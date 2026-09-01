// Task 080 — vaiko exit visada palieka diagnozę ir stderr.
//
// `formatChildExitDiagnostics` yra grynas formatuotojas, kviečiamas iš `command.ts` `runChild`
// tik kai `result.code !== 0`. Testai tikrina keturis exit atvejus; penktas (code === 0) niekada
// nepasiekia formatuotojo — tą tikrina pats `runChild` blokas, ne šis modulis.

import assert from "node:assert/strict";
import { test } from "node:test";
import { formatChildExitDiagnostics } from "../composition/loop/child-exit-diagnostics.js";

test("stderr yra: rašoma stderr uodega, exit kontekstas, be SILENT", () => {
  const message = formatChildExitDiagnostics({
    code: 1,
    stdout: "",
    stderr: "boom: stack trace here",
    durationMs: 250,
    workerId: "worker-1",
    taskId: "task-1",
  });

  assert.match(message, /^WAVE SLOT CHILD EXIT 1: slot=worker-1 task=task-1/);
  assert.match(message, /--- child stderr \(tail\) ---\nboom: stack trace here/);
  assert.doesNotMatch(message, /child stderr: EMPTY/);
  assert.match(message, /child exit context: code=1 duration=250$/m);
  assert.doesNotMatch(message, /CHILD EXIT SILENT/);
});

test("stderr tuščias, stdout yra: EMPTY žyma + stdout uodega, be SILENT", () => {
  const message = formatChildExitDiagnostics({
    code: 2,
    stdout: "some progress output",
    stderr: "   ",
    durationMs: 1000,
    workerId: "worker-2",
    taskId: "task-2",
  });

  assert.match(message, /--- child stderr: EMPTY ---/);
  assert.match(message, /--- child stdout \(tail\) ---\nsome progress output/);
  assert.match(message, /child exit context: code=2 duration=1000$/m);
  assert.doesNotMatch(message, /CHILD EXIT SILENT/);
});

test("abu tušti: EMPTY žyma + CHILD EXIT SILENT eilutė", () => {
  const message = formatChildExitDiagnostics({
    code: 3,
    stdout: "",
    stderr: "",
    durationMs: 5,
    workerId: "worker-3",
    taskId: "task-3",
  });

  assert.match(message, /--- child stderr: EMPTY ---/);
  assert.doesNotMatch(message, /child stdout \(tail\)/);
  assert.match(message, /child exit context: code=3 duration=5$/m);
  assert.match(message, /CHILD EXIT SILENT: worker-3 task-3$/m);
});

test("worktree log uodega: blokas rašomas, SILENT žyma lieka (tylus vaikas su išgelbėta priežastimi)", () => {
  const message = formatChildExitDiagnostics({
    code: 1,
    stdout: "",
    stderr: "",
    durationMs: 549313,
    workerId: "w2",
    taskId: "task-5",
    worktreeLogTail: "[ts] PHASE FAILED: phase=preflight exit=1 Task exceeds size limits\n[ts] TASK HUMAN REVIEW: task-5 preflight_failed=1\n",
  });

  assert.match(message, /--- worktree vq\/logs\/orchestrator\.log \(tail\) ---\n\[ts\] PHASE FAILED/);
  assert.match(message, /TASK HUMAN REVIEW: task-5 preflight_failed=1$/m);
  // SILENT semantika nesikeičia: proceso srautai tušti, žyma lieka — blokas šalia paaiškina priežastį.
  assert.match(message, /CHILD EXIT SILENT: w2 task-5$/m);
});

test("worktree log uodega: tuščia/neperduota → bloko nėra", () => {
  const withoutField = formatChildExitDiagnostics({
    code: 1,
    stdout: "",
    stderr: "err",
    durationMs: 10,
    workerId: "w1",
    taskId: "task-6",
  });
  assert.doesNotMatch(withoutField, /worktree vq\/logs\/orchestrator\.log/);

  const blankField = formatChildExitDiagnostics({
    code: 1,
    stdout: "",
    stderr: "err",
    durationMs: 10,
    workerId: "w1",
    taskId: "task-6",
    worktreeLogTail: "   \n  ",
  });
  assert.doesNotMatch(blankField, /worktree vq\/logs\/orchestrator\.log/);
});

test("worktree log uodega: ilgas žurnalas atpjaunamas iš galo (paskutinės eilutės — priežastis)", () => {
  const filler = "x".repeat(10_000);
  const message = formatChildExitDiagnostics({
    code: 1,
    stdout: "",
    stderr: "",
    durationMs: 5,
    workerId: "w1",
    taskId: "task-7",
    worktreeLogTail: `${filler}\nPHASE FAILED: galas`,
  });

  assert.match(message, /PHASE FAILED: galas$/m);
  const block = message.split("--- worktree vq/logs/orchestrator.log (tail) ---\n")[1] ?? "";
  const blockBody = block.split("\nchild exit context:")[0] ?? "";
  assert.ok(blockBody.length <= 4000, `worktree bloko kūnas ${blockBody.length} > 4000`);
});

test("signal pridedamas tik jei perduotas", () => {
  const withoutSignal = formatChildExitDiagnostics({
    code: 1,
    stdout: "",
    stderr: "err",
    durationMs: 10,
    workerId: "worker-4",
    taskId: "task-4",
  });
  assert.doesNotMatch(withoutSignal, /signal=/);

  const withSignal = formatChildExitDiagnostics({
    code: 1,
    stdout: "",
    stderr: "err",
    durationMs: 10,
    workerId: "worker-4",
    taskId: "task-4",
    signal: "SIGTERM",
  });
  assert.match(withSignal, /child exit context: code=1 duration=10 signal=SIGTERM$/m);
});
