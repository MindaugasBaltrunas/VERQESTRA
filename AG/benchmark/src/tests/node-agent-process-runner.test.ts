import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { NodeAgentProcessRunner } from "../infrastructure/adapters/node-agent-process-runner.js";

/**
 * The one behaviour of the real runner that cannot be stated behind the port: a
 * cell that has run out of time ends, whatever the child thinks about it.
 *
 * A measured agent spawns its own children, so the timeout kills a process group
 * (POSIX) or a process tree (`taskkill /T`, Windows) rather than a single pid.
 * The tree itself is the operating system's behaviour and is not asserted here.
 * What is asserted is the part a caller depends on and a regression would break:
 * a child that ignores `SIGTERM` still comes back as `timedOut`, and `run()`
 * resolves instead of hanging for as long as that child would have lived.
 *
 * Package root resolved from this module rather than from `process.cwd()`, as the
 * other tests in this package do, so the spawn has a directory that exists
 * wherever the suite was started from.
 */
const packageRoot = path.resolve(fileURLToPath(import.meta.url), "../../../");

/** Installs a `SIGTERM` handler and then stays alive; only an unignorable kill ends it. */
const IGNORES_SIGTERM = "process.on('SIGTERM', () => undefined); setInterval(() => undefined, 1000);";

/** Short enough that the test is decided by the grace period rather than by the wait for it. */
const TIMEOUT_MS = 250;

test("a child that ignores SIGTERM is still ended, and the run says it timed out", async () => {
  const result = await new NodeAgentProcessRunner().run({
    command: process.execPath,
    args: ["-e", IGNORES_SIGTERM],
    cwd: packageRoot,
    timeoutMs: TIMEOUT_MS,
    env: {},
    stdin: "",
  });

  assert.equal(result.timedOut, true, "the cell ran out of time and the result does not say so");
  assert.notEqual(
    result.exitCode,
    0,
    "a killed child must not be recorded as a process that completed successfully",
  );
});
