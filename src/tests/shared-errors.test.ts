import assert from "node:assert/strict";
import test from "node:test";
import {
  PolicyConfigError,
  WorkflowInfrastructureError,
  isAlreadyExistsError,
  isErrnoCode,
  isNotFoundError,
  isPolicyConfigError,
  toError,
  withPolicyConfigErrors,
} from "../shared/errors.js";
import {
  USAGE_ERROR_EXIT_CODE,
  classifyExitCode,
  infrastructureExitCodeForError,
  isInfrastructureErrno,
  isInfrastructureExitCode,
  isUsageErrorExitCode,
} from "../shared/exit-codes.js";

test("errno guards match on the code property of any unknown value", () => {
  assert.ok(isErrnoCode({ code: "EBUSY" }, "EBUSY"));
  assert.ok(!isErrnoCode({ code: "EBUSY" }, "ENOENT"));
  assert.ok(!isErrnoCode(null, "EBUSY"));
  assert.ok(isAlreadyExistsError({ code: "EEXIST" }));
  assert.ok(isNotFoundError({ code: "ENOENT" }));
});

test("toError wraps non-Error values and passes Error values through", () => {
  const original = new Error("x");
  assert.equal(toError(original), original);
  assert.equal(toError("boom").message, "boom");
});

test("withPolicyConfigErrors marks failures with the config file and never re-wraps", async () => {
  const wrapped = await withPolicyConfigErrors("cfg.json", async () => {
    throw new Error("bad shape");
  }).catch((error: unknown) => error);
  assert.ok(isPolicyConfigError(wrapped));
  assert.equal(wrapped.configFile, "cfg.json");
  assert.equal(wrapped.message, "bad shape");

  const inner = new PolicyConfigError("inner.json", new Error("root cause"));
  const rewrapped = await withPolicyConfigErrors("outer.json", async () => {
    throw inner;
  }).catch((error: unknown) => error);
  assert.equal(rewrapped, inner, "an already-marked error must keep its true file");
});

test("WorkflowInfrastructureError carries its resume/queue facts", () => {
  const plain = new WorkflowInfrastructureError("boom");
  assert.equal(plain.taskReturnedToQueue, false);
  assert.equal(plain.taskPreservedForResume, false);
  assert.equal(plain.exitCode, undefined);
  const rich = new WorkflowInfrastructureError("boom", { taskReturnedToQueue: true, exitCode: 75 });
  assert.equal(rich.taskReturnedToQueue, true);
  assert.equal(rich.exitCode, 75);
});

test("exit codes classify exactly like the AG_loop etalon table", () => {
  assert.equal(classifyExitCode(0), "success");
  assert.equal(classifyExitCode(USAGE_ERROR_EXIT_CODE), "usage_error");
  assert.equal(classifyExitCode(124), "timeout");
  for (const code of [69, 74, 75, 78, 79, 80, 126, 127, 3221225786, 3221225794]) {
    assert.equal(classifyExitCode(code), "infrastructure", `code ${code}`);
    assert.ok(isInfrastructureExitCode(code), `code ${code}`);
  }
  assert.ok(isInfrastructureExitCode(124), "timeout counts as infrastructure for abort routing");
  assert.equal(classifyExitCode(1), "task_failure");
  assert.ok(isUsageErrorExitCode(2));
  assert.ok(!isUsageErrorExitCode(1));
});

test("errno infrastructure detection requires errno/syscall, not just a code string", () => {
  assert.ok(isInfrastructureErrno({ code: "EBUSY", syscall: "open" }));
  assert.ok(isInfrastructureErrno({ code: "EPERM", errno: -4048 }));
  assert.ok(!isInfrastructureErrno({ code: "EBUSY" }), "a bare code string is a domain error, not the OS");
  assert.ok(!isInfrastructureErrno({ code: "EINVAL", syscall: "open" }));
  assert.equal(infrastructureExitCodeForError({ code: "ENOENT", syscall: "stat" }), 74);
  assert.equal(infrastructureExitCodeForError(new Error("x")), undefined);
});
