import assert from "node:assert/strict";
import test from "node:test";

import { PRIORITY_ORDER, isKnownPriority, sortByPriority } from "../src/domain/priority.mjs";

const task = (id, priority) => ({ id, priority });

test("known priorities sort most important first", () => {
  const sorted = sortByPriority([
    task("c", "low"),
    task("a", "urgent"),
    task("b", "normal"),
  ]);
  assert.deepEqual(sorted.map((entry) => entry.id), ["a", "b", "c"]);
});

test("sortByPriority does not mutate its input", () => {
  const input = [task("c", "low"), task("a", "urgent")];
  sortByPriority(input);
  assert.deepEqual(input.map((entry) => entry.id), ["c", "a"]);
});

test("isKnownPriority recognises exactly the declared labels", () => {
  for (const priority of PRIORITY_ORDER) assert.equal(isKnownPriority(priority), true);
  assert.equal(isKnownPriority("critical"), false);
});
