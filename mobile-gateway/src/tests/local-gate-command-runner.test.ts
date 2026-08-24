import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  GATE_ENVIRONMENT_ALLOWLIST,
  NodeGateCommandRunner,
} from "../infrastructure/node-gate-command-runner.js";

/**
 * The quality gate runner, exercised against real child processes.
 *
 * `process.execPath` with `-e` is the only program a test can be certain exists
 * on every host that can run this suite, and it is local, immediate and free of
 * network access — the same reasoning the PTY adapter's tests use. A double
 * could not show what the adapter hands the operating system, which is the whole
 * subject here.
 *
 * SKAIDYMAS (VERQESTRA ≤500 eil. vartas): iškelta iš `local-host-adapters.test.ts`. Ten likę
 * adapteriai liečia tik failų sistemą ir atsako „ką hostas gali įrodyti"; šis vienintelis
 * KURIA procesą, tad jo rizikos profilis, fikstūra ir net tai, ką reiškia „uždaras
 * numatytasis", yra kiti.
 */

async function gateWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "ag-gate-runner-"));
}

test("a gate that exits reports its code and nothing else", async () => {
  const root = await gateWorkspace();
  try {
    const runner = new NodeGateCommandRunner();
    for (const [label, code] of [["a clean exit", 0], ["a failing exit", 3]] as const) {
      const outcome = await runner.run({
        cwd: root,
        executable: process.execPath,
        args: ["-e", `process.exit(${code})`],
        timeoutMs: 30_000,
      });
      assert.equal(outcome.exitCode, code, label);
      assert.equal(outcome.timedOut, false, label);
      assert.equal(outcome.startFailed, false, label);
      assert.equal(typeof outcome.durationMs, "number", label);
      assert.ok(outcome.durationMs >= 0, label);
      // The port carries facts only; terminal output must not have a way out.
      assert.deepEqual(
        Object.keys(outcome).sort(),
        ["durationMs", "exitCode", "startFailed", "timedOut"],
        label,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a gate that outlives its time budget is stopped and reported as timed out", async () => {
  const root = await gateWorkspace();
  try {
    const outcome = await new NodeGateCommandRunner().run({
      cwd: root,
      // Far longer than the budget: the adapter has to end this, not the child.
      executable: process.execPath,
      args: ["-e", "setTimeout(() => undefined, 600000)"],
      timeoutMs: 1_000,
    });
    assert.equal(outcome.timedOut, true);
    assert.equal(outcome.startFailed, false);
    assert.ok(outcome.durationMs >= 1_000, `budget was not waited out: ${outcome.durationMs}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a gate that never started is a host fact, not a rejected promise", async () => {
  const root = await gateWorkspace();
  try {
    // Failure to start says nothing about the code under test, so the caller
    // records it as `errored` rather than as a red gate — and it must be able to
    // do that from an outcome, not from a catch block.
    const outcome = await new NodeGateCommandRunner().run({
      cwd: root,
      executable: join(root, "no-such-gate-program"),
      args: [],
      timeoutMs: 30_000,
    });
    assert.equal(outcome.startFailed, true);
    assert.equal(outcome.timedOut, false);
    assert.equal(outcome.exitCode, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the runner refuses to launch anything the operating system would resolve for it", async () => {
  const root = await gateWorkspace();
  try {
    const runner = new NodeGateCommandRunner();
    const refusals: ReadonlyArray<readonly [string, { cwd: string; executable: string }]> = [
      ["a bare program name", { cwd: root, executable: "node" }],
      ["a relative program path", { cwd: root, executable: join(".", "node") }],
      ["a relative working directory", { cwd: ".", executable: process.execPath }],
    ];
    for (const [label, request] of refusals) {
      await assert.rejects(
        runner.run({ ...request, args: ["-e", "process.exit(0)"], timeoutMs: 30_000 }),
        (error: unknown) => error instanceof Error && /absolute path/.test(error.message),
        label,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a gate inherits the toolchain variables and none of the operator's secrets", async () => {
  const root = await gateWorkspace();
  try {
    const allowed = process.platform === "win32"
      ? GATE_ENVIRONMENT_ALLOWLIST.win32
      : GATE_ENVIRONMENT_ALLOWLIST.posix;
    const inherited: Record<string, string> = {};
    for (const name of allowed) {
      const value = process.env[name];
      if (typeof value === "string") inherited[name] = value;
    }
    const runner = new NodeGateCommandRunner({
      env: {
        ...inherited,
        SECRET_TOKEN: "an api token the repository must never see",
        // Deliberately not shaped like a real token: the test asserts the
        // variable is absent, so a lifelike prefix would only teach the repo's
        // secret scanner that this file contains a credential.
        GITHUB_TOKEN: "a host credential the repository must never see",
        NODE_OPTIONS: "--throw-deprecation",
      },
    });
    // The child itself is the witness: it exits 0 only when every credential is
    // absent AND the one variable a toolchain genuinely needs is present.
    const outcome = await runner.run({
      cwd: root,
      executable: process.execPath,
      args: [
        "-e",
        "process.exit(process.env.SECRET_TOKEN === undefined"
        + " && process.env.GITHUB_TOKEN === undefined"
        + " && process.env.NODE_OPTIONS === undefined"
        + " && typeof process.env.PATH === 'string' && process.env.PATH.length > 0 ? 0 : 7)",
      ],
      timeoutMs: 30_000,
    });
    assert.equal(outcome.startFailed, false);
    assert.equal(
      outcome.exitCode,
      0,
      "the child saw a credential it must not have, or lost the PATH it needs",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
