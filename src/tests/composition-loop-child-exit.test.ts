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
