import assert from "node:assert/strict";
import test from "node:test";

import {
  CheckCommandRefusedError,
  ProcessCheckRunner,
  assertSafeCheckCommand,
} from "../infrastructure/checks/process-check-runner.js";
import { FakeProcessPort, WORKTREE_PATH, processResult } from "./execution-fixtures.js";
import { SYNTHETIC_SECRETS } from "./secret-samples.js";

/**
 * The spawn surface a declared check gets (BENCH-6).
 *
 * The rule worth a test of its own is the program guard. A scenario ships both
 * the command that grades a run and the fixture the run may write into, so a
 * check allowed to name a path could be answered by a file the agent under test
 * had just created. Everything else here states that a check is handed nothing
 * an agent is handed: no credential, no standard input, no unbounded runtime.
 */

function runner(result = processResult({ stdout: "", stderr: "" })): {
  readonly processes: FakeProcessPort;
  readonly checks: ProcessCheckRunner;
} {
  const processes = new FakeProcessPort(result);
  return { processes, checks: new ProcessCheckRunner(processes) };
}

const CHECK = { command: "node", args: ["--test", "test/store.mjs"], cwd: WORKTREE_PATH } as const;

test("a check must name a program on PATH, never a location", () => {
  for (const command of ["./tools/check", "tools\\check.cmd", "C:\\Windows\\system32\\cmd.exe", ".."]) {
    assert.throws(
      () => assertSafeCheckCommand(command, []),
      CheckCommandRefusedError,
      `"${command}" should have been refused`,
    );
  }
  assert.doesNotThrow(() => assertSafeCheckCommand("node", ["--test"]));
});

test("a check with no program, or an argument carrying a NUL byte, is refused", () => {
  assert.throws(() => assertSafeCheckCommand("  ", []), CheckCommandRefusedError);
  assert.throws(() => assertSafeCheckCommand("node", ["--test\0--eval"]), CheckCommandRefusedError);
});

test("a check is spawned with no credential, no standard input and the declared bound", async () => {
  const { processes, checks } = runner();
  await checks.run({ ...CHECK, timeoutMs: 60_000 });

  const spawn = processes.spawns[0];
  assert.ok(spawn !== undefined, "no process was started");
  assert.deepEqual(spawn.args, ["--test", "test/store.mjs"]);
  assert.deepEqual(spawn.env, {});
  assert.equal(spawn.stdin, "");
  assert.equal(spawn.cwd, WORKTREE_PATH);
  assert.equal(spawn.timeoutMs, 60_000);
});

test("a check without a checkout or without a usable bound is refused before anything starts", async () => {
  const { processes, checks } = runner();
  await assert.rejects(
    () => checks.run({ ...CHECK, cwd: "  ", timeoutMs: 1_000 }),
    CheckCommandRefusedError,
  );
  await assert.rejects(
    () => checks.run({ ...CHECK, timeoutMs: 0 }),
    CheckCommandRefusedError,
  );
  assert.deepEqual(processes.spawns, [], "a refused check still started a process");
});

test("the process outcome is reported as it happened, not interpreted", async () => {
  const passed = runner(processResult({ exitCode: 0, stdout: "ok", stderr: "" }));
  assert.deepEqual(await passed.checks.run({ ...CHECK, timeoutMs: 1_000 }), {
    exitCode: 0,
    signal: null,
    timedOut: false,
    output: "ok",
  });

  const killed = runner(
    processResult({ exitCode: null, signal: "SIGTERM", timedOut: true, stdout: "", stderr: "" }),
  );
  const result = await killed.checks.run({ ...CHECK, timeoutMs: 1_000 });
  assert.equal(result.timedOut, true);
  assert.equal(result.signal, "SIGTERM");
  assert.equal(result.exitCode, null);
});

test("recorded output keeps both streams, redacted and bounded to its tail", async () => {
  const noisy = runner(
    processResult({
      exitCode: 1,
      stdout: `${"x".repeat(10_000)}\nlast line of stdout`,
      stderr: `CLAUDE_API_KEY=${SYNTHETIC_SECRETS.anthropicApiKey}`,
    }),
  );
  const { output } = await noisy.checks.run({ ...CHECK, timeoutMs: 1_000 });

  assert.ok(output.length < 5_000, "the recorded output was not bounded");
  assert.ok(output.startsWith("…"), "a truncated output does not say that it was cut");
  assert.ok(
    !output.includes(SYNTHETIC_SECRETS.anthropicApiKey),
    "a credential a check printed reached the recorded output",
  );
  assert.match(output, /CLAUDE_API_KEY=\[redacted\]/);
});
