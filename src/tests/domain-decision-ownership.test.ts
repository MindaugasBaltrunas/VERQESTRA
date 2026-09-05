// Task 173: `vq/supervisor/decision.json` nuosavybės taisyklė yra VIENA gryna funkcija.
//
// Iki 2026-09-05 ji egzistavo dviem kopijomis (`dispatch-adapters` ir `coordinator-adapters`),
// ir jos nesutapo: raidžių dydis ir trūkstamo `task_id` reikšmė. Šie testai fiksuoja pačią
// taisyklę — adapterių sujungimą tikrina `composition-dispatch-attempt-channel.test.ts` ir
// `task-execution-run-claude-log.test.ts`, kurie eina per REALIUS adapterius.

import assert from "node:assert/strict";
import test from "node:test";
import { decisionOwnership } from "../domain/tasks/decision-ownership.js";

test("decisionOwnership: raidžių dydis nesprendžia nuosavybės (dispatch'o taisyklė laimi)", () => {
  assert.equal(decisionOwnership({ decisionTaskId: "TASK-1", taskId: "task-1" }), "own");
  assert.equal(decisionOwnership({ decisionTaskId: "task-1", taskId: "TASK-1" }), "own");
  assert.equal(decisionOwnership({ decisionTaskId: "Task-1", taskId: "tAsK-1" }), "own");
});

test("decisionOwnership: tarpai apkarpomi abiejose pusėse", () => {
  assert.equal(decisionOwnership({ decisionTaskId: "  task-1  ", taskId: "task-1" }), "own");
  assert.equal(decisionOwnership({ decisionTaskId: "task-1", taskId: "\ttask-1\n" }), "own");
  assert.equal(decisionOwnership({ decisionTaskId: " TASK-1\n", taskId: "\ttask-1 " }), "own");
});

test("decisionOwnership: tuščias, tik tarpai, undefined ir ne-eilutė — visi `missing`", () => {
  assert.equal(decisionOwnership({ decisionTaskId: "", taskId: "task-1" }), "missing");
  assert.equal(decisionOwnership({ decisionTaskId: "   ", taskId: "task-1" }), "missing");
  assert.equal(decisionOwnership({ decisionTaskId: undefined, taskId: "task-1" }), "missing");
  // Ne-eilutė yra pasiekiama būsena: abu kvietėjai `task_id` gauna iš JSON'o per cast'ą, tad
  // tipas jos negarantuoja. Todėl `typeof` sargyba gyvena taisyklės viduje, ne kopijose.
  assert.equal(decisionOwnership({ decisionTaskId: 42, taskId: "task-1" }), "missing");
  assert.equal(decisionOwnership({ decisionTaskId: null, taskId: "task-1" }), "missing");
  assert.equal(decisionOwnership({ decisionTaskId: { task_id: "task-1" }, taskId: "task-1" }), "missing");
});

test("decisionOwnership: kito task'o id — `foreign`, atskirtas nuo `missing`", () => {
  assert.equal(decisionOwnership({ decisionTaskId: "kitas-task", taskId: "task-1" }), "foreign");
  // Prefiksas nėra tapatybė: „task-1" ir „task-10" yra skirtingi task'ai.
  assert.equal(decisionOwnership({ decisionTaskId: "task-10", taskId: "task-1" }), "foreign");
  assert.equal(decisionOwnership({ decisionTaskId: "task-1", taskId: "task-10" }), "foreign");
});

test("decisionOwnership: tuščias laukiamas taskId savu nepadaro NIEKO", () => {
  // Degeneratyvus kvietimas: net tuščiam laukiamam id nuosavybė nesuteikiama tyliai — abu
  // atvejai lieka ne-`own`, tad vartas fail-closed iš abiejų pusių.
  assert.equal(decisionOwnership({ decisionTaskId: "task-1", taskId: "" }), "foreign");
  assert.equal(decisionOwnership({ decisionTaskId: "", taskId: "" }), "missing");
});
