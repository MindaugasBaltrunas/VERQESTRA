import assert from "node:assert/strict";
import test from "node:test";

import { sortByPriority } from "../src/domain/priority.mjs";

/**
 * Bug report as a test. RED on a clean checkout — see the fixture README.
 *
 * A task carrying a label the module does not know must sort behind every known
 * one, and equal priorities must keep a stable, declared order rather than
 * whatever the engine's sort produced.
 */

const task = (id, priority) => ({ id, priority });

test("an unrecognised priority sorts last, not first", () => {
  const sorted = sortByPriority([
    task("unknown", "someday"),
    task("urgent", "urgent"),
    task("low", "low"),
  ]);
  assert.deepEqual(sorted.map((entry) => entry.id), ["urgent", "low", "unknown"]);
});

test("equal priorities are ordered by id so the result is reproducible", () => {
  const sorted = sortByPriority([task("b", "high"), task("a", "high"), task("c", "high")]);
  assert.deepEqual(sorted.map((entry) => entry.id), ["a", "b", "c"]);
});
