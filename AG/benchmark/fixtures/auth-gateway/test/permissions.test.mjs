import assert from "node:assert/strict";
import test from "node:test";

import { can, permissionsFor, requirePermission } from "../src/permissions.mjs";

test("a viewer may read and nothing else", () => {
  assert.deepEqual(permissionsFor(["viewer"]), ["task:read"]);
  assert.equal(can(["viewer"], "task:write"), false);
});

test("multiple roles union their permissions", () => {
  assert.deepEqual(permissionsFor(["viewer", "approver"]), [
    "task:approve",
    "task:read",
    "task:write",
  ]);
});

test("an unknown role grants nothing", () => {
  assert.deepEqual(permissionsFor(["superuser"]), []);
  assert.deepEqual(permissionsFor([]), []);
});

test("a role named after an inherited property grants nothing rather than crashing", () => {
  for (const role of ["constructor", "toString", "__proto__", "valueOf"]) {
    assert.deepEqual(permissionsFor([role]), [], role);
    assert.equal(can([role], "task:read"), false, role);
  }
});

test("requirePermission throws instead of returning a value a caller can drop", () => {
  assert.throws(() => requirePermission(["viewer"], "user:manage"), /not granted/);
  assert.doesNotThrow(() => requirePermission(["admin"], "user:manage"));
});
