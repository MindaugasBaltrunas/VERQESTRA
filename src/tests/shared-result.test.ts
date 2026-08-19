import assert from "node:assert/strict";
import test from "node:test";
import { err, ok } from "../shared/index.js";

test("ok/err carry their payloads and discriminate on the ok flag", () => {
  const success = ok(42);
  const failure = err("nope");
  assert.equal(success.ok, true);
  assert.equal(success.value, 42);
  assert.equal(failure.ok, false);
  assert.equal(failure.error, "nope");
});
