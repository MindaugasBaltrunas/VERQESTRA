import assert from "node:assert/strict";
import test from "node:test";

import { filteredSummary, overallSummary, prioritySummary } from "../src/domain/summary.mjs";

/**
 * The safety net a refactor scenario has to keep green. It pins the results, not
 * the shape of the code, so collapsing the three duplicated walks is allowed and
 * changing what they return is not.
 */

const tasks = [
  { id: "a", title: "a", priority: "high", done: true },
  { id: "b", title: "b", priority: "high", done: false },
  { id: "c", title: "c", priority: "low", done: true },
];

test("overallSummary counts every task", () => {
  assert.deepEqual(overallSummary(tasks), { total: 3, done: 2, percent: 67 });
});

test("prioritySummary counts only the matching priority", () => {
  assert.deepEqual(prioritySummary(tasks, "high"), { total: 2, done: 1, percent: 50 });
  assert.deepEqual(prioritySummary(tasks, "urgent"), { total: 0, done: 0, percent: 0 });
});

test("filteredSummary counts whatever the predicate admits", () => {
  assert.deepEqual(filteredSummary(tasks, (task) => task.done), { total: 2, done: 2, percent: 100 });
});

test("an empty list reports zero percent rather than NaN", () => {
  assert.deepEqual(overallSummary([]), { total: 0, done: 0, percent: 0 });
});
