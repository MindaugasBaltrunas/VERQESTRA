import assert from "node:assert/strict";
import test from "node:test";

import {
  DuplicateTaskError,
  TaskNotFoundError,
  addTask,
  completeTask,
  listTasks,
  removeTask,
} from "../src/domain/task-store.mjs";

const task = (id, priority = "normal", done = false) => ({ id, title: id, priority, done });

test("addTask appends without mutating the input", () => {
  const before = [task("a")];
  const after = addTask(before, task("b"));
  assert.deepEqual(before.map((entry) => entry.id), ["a"]);
  assert.deepEqual(after.map((entry) => entry.id), ["a", "b"]);
});

test("addTask refuses a duplicate id", () => {
  assert.throws(() => addTask([task("a")], task("a")), DuplicateTaskError);
});

test("completeTask marks exactly one task", () => {
  const after = completeTask([task("a"), task("b")], "b");
  assert.deepEqual(after.map((entry) => entry.done), [false, true]);
});

test("completeTask and removeTask reject an unknown id", () => {
  assert.throws(() => completeTask([task("a")], "z"), TaskNotFoundError);
  assert.throws(() => removeTask([task("a")], "z"), TaskNotFoundError);
});

test("listTasks filters by done and by priority", () => {
  const tasks = [task("a", "high", true), task("b", "high"), task("c", "low")];
  assert.deepEqual(listTasks(tasks, { done: true }).map((entry) => entry.id), ["a"]);
  assert.deepEqual(listTasks(tasks, { priority: "high" }).map((entry) => entry.id), ["a", "b"]);
  assert.deepEqual(listTasks(tasks).length, 3);
});
