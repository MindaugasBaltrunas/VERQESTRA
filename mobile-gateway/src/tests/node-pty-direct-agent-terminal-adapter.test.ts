import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import {
  NodePtyDirectAgentTerminalAdapter,
  type NodePtyModule,
} from "../infrastructure/node-pty-direct-agent-terminal-adapter.js";

type FakePty = {
  readonly process: ReturnType<NodePtyModule["spawn"]>;
  emitData(data: string): void;
  emitExit(exitCode: number): void;
  readonly writes: string[];
  readonly resizes: Array<[number, number]>;
  readonly killCount: number;
};

function fakePty(): FakePty {
  let dataListener: ((data: string) => void) | undefined;
  let exitListener: ((event: { exitCode: number }) => void) | undefined;
  let killCount = 0;
  const writes: string[] = [];
  const resizes: Array<[number, number]> = [];
  return {
    process: {
      pid: 4242,
      onData(listener) {
        dataListener = listener;
        return { dispose: () => { dataListener = undefined; } };
      },
      onExit(listener) {
        exitListener = listener;
        return { dispose: () => { exitListener = undefined; } };
      },
      write(data) {
        writes.push(data);
      },
      resize(cols, rows) {
        resizes.push([cols, rows]);
      },
      kill() {
        killCount += 1;
      },
    },
    emitData(data) {
      dataListener?.(data);
    },
    emitExit(exitCode) {
      exitListener?.({ exitCode });
    },
    writes,
    resizes,
    get killCount() {
      return killCount;
    },
  };
}

for (const provider of ["claude-code", "codex"] as const) {
  test(`${provider} PTY uses a fixed executable, empty args and the supplied isolated cwd`, async () => {
    const fake = fakePty();
    const starts: Array<{
      executable: string;
      args: readonly string[];
      options: Parameters<NodePtyModule["spawn"]>[2];
    }> = [];
    const module: NodePtyModule = {
      spawn(executable, args, options) {
        starts.push({ executable, args, options });
        return fake.process;
      },
    };
    const output: string[] = [];
    const exits: Array<number | null> = [];
    const cwd = resolve("test-worktrees", provider);
    const adapter = new NodePtyDirectAgentTerminalAdapter(
      async () => module,
      { "claude-code": "host-claude", codex: "host-codex" },
      { PATH: "safe-path", OMITTED: undefined },
      async (executable) => resolve("host-bin", executable),
    );
    const handle = await adapter.start({
      sessionId: `session-${provider}`,
      provider,
      cwd,
      cols: 100,
      rows: 30,
      onOutput: (data) => output.push(data),
      onExit: (exitCode) => exits.push(exitCode),
    });

    assert.equal(starts.length, 1);
    assert.equal(
      starts[0]?.executable,
      resolve("host-bin", provider === "claude-code" ? "host-claude" : "host-codex"),
    );
    assert.deepEqual(starts[0]?.args, []);
    assert.equal(starts[0]?.options.cwd, cwd);
    assert.equal(starts[0]?.options.handleFlowControl, true);
    assert.deepEqual(starts[0]?.options.env, { PATH: "safe-path" });
    assert.equal("shell" in (starts[0]?.options ?? {}), false);

    await handle.write("pataisyk testus ✓\r");
    await handle.resize(120, 40);
    await handle.interrupt();
    fake.emitData("provider output");
    assert.deepEqual(fake.writes, ["pataisyk testus ✓\r", "\x03"]);
    assert.deepEqual(fake.resizes, [[120, 40]]);
    assert.deepEqual(output, ["provider output"]);

    // Force-close kills the PTY object this adapter spawned and nothing else.
    // That it reaches no foreign process is proven by the runtime recorders in
    // "the whole PTY lifecycle …" below, not by inspecting a local object the
    // adapter never sees.
    await handle.terminate();
    assert.equal(fake.killCount, 1);
    fake.emitExit(0);
    fake.emitExit(1);
    assert.deepEqual(exits, [0]);
    await assert.rejects(handle.write("late"), /not live/);
  });
}

test("adapter rejects arbitrary cwd, invalid dimensions and duplicate live session ids", async () => {
  const fake = fakePty();
  const module: NodePtyModule = { spawn: () => fake.process };
  const adapter = new NodePtyDirectAgentTerminalAdapter(
    async () => module,
    undefined,
    undefined,
    async (executable) => resolve("host-bin", executable),
  );
  const request = {
    sessionId: "fixed-session",
    provider: "codex" as const,
    cwd: resolve("test-worktrees", "fixed-session"),
    cols: 80,
    rows: 24,
    onOutput: () => undefined,
    onExit: () => undefined,
  };
  await adapter.start(request);
  await assert.rejects(adapter.start(request), /already active/);
  await assert.rejects(
    adapter.start({ ...request, sessionId: "relative", cwd: "relative/path" }),
    /start request is invalid/,
  );
  await assert.rejects(
    adapter.start({ ...request, sessionId: "dimensions", cols: 10 }),
    /start request is invalid/,
  );
});

test("spawn failure releases the adapter reservation and loader failure is explicit", async () => {
  const request = {
    sessionId: "retryable-session",
    provider: "claude-code" as const,
    cwd: resolve("test-worktrees", "retryable-session"),
    cols: 80,
    rows: 24,
    onOutput: () => undefined,
    onExit: () => undefined,
  };
  let attempts = 0;
  const adapter = new NodePtyDirectAgentTerminalAdapter(async () => ({
    spawn() {
      attempts += 1;
      throw new Error("spawn unavailable");
    },
  }), undefined, undefined, async (executable) => resolve("host-bin", executable));
  await assert.rejects(adapter.start(request), /spawn unavailable/);
  await assert.rejects(adapter.start(request), /spawn unavailable/);
  assert.equal(attempts, 2);

  const unavailable = new NodePtyDirectAgentTerminalAdapter(async () => {
    throw new Error("node-pty unavailable");
  }, undefined, undefined, async (executable) => resolve("host-bin", executable));
  await assert.rejects(unavailable.start({ ...request, sessionId: "missing" }), /node-pty unavailable/);
});

type HostProcessProbe = Readonly<{
  signals: ReadonlyArray<Readonly<{ pid: number; signal: string | number | undefined }>>;
  stdinWrites: readonly string[];
  pidBefore: number;
  pidAfter: number;
}>;

/**
 * Runs `body` with `process.kill` and this host process's stdin replaced by
 * recorders, and restores both even when `body` throws.
 *
 * The test host stands in for the AG Loop process: a process the gateway did not
 * spawn. Signalling a foreign pid or feeding a foreign stdin has to go through
 * one of these two functions, so a recorder with any entry is the violation
 * itself — an assertion on a local stand-in object could never show that.
 *
 * Deliberately duplicated in `terminal-supervisor.test.ts`: the PTY adapter and
 * the supervisor are proven independently, and a shared helper module is not
 * among the files this proof may add. Keep the two copies identical.
 *
 * Safe under `node --test`, which runs each file in its own process and the
 * tests within a file one at a time, so no other test observes the patched
 * globals.
 */
async function withoutTouchingTheHostProcess(body: () => Promise<void>): Promise<HostProcessProbe> {
  const signals: Array<Readonly<{ pid: number; signal: string | number | undefined }>> = [];
  const stdinWrites: string[] = [];
  const pidBefore = process.pid;
  // Resolved once: `process.stdin` is a lazy getter, and the object it creates
  // on first access is the one every later access returns — patch that object,
  // not a fresh one.
  const hostStdin = process.stdin;
  const originalKill = process.kill;
  const originalStdinWrite = hostStdin.write;
  process.kill = (pid: number, signal?: string | number): true => {
    signals.push({ pid, signal });
    return true;
  };
  hostStdin.write = (chunk: unknown): boolean => {
    stdinWrites.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  };
  try {
    await body();
  } finally {
    process.kill = originalKill;
    hostStdin.write = originalStdinWrite;
  }
  return { signals, stdinWrites, pidBefore, pidAfter: process.pid };
}

test("the non-interference recorders observe a signal and a foreign stdin write", async () => {
  // Control for the two tests below: an empty recorder only means something if
  // a violation would fill it. Inside the probe `process.kill` and the host
  // stdin are the recorders themselves, so nothing is signalled for real.
  const probe = await withoutTouchingTheHostProcess(async () => {
    process.kill(process.pid, "SIGTERM");
    process.stdin.write("takeover");
  });
  assert.deepEqual(probe.signals, [{ pid: process.pid, signal: "SIGTERM" }]);
  assert.deepEqual(probe.stdinWrites, ["takeover"]);
  assert.equal(probe.pidAfter, probe.pidBefore);
});

for (const stop of ["terminate", "close"] as const) {
  test(`the whole PTY lifecycle ending in ${stop} signals nothing outside its own PTY`, async () => {
    const fake = fakePty();
    const module: NodePtyModule = { spawn: () => fake.process };
    const adapter = new NodePtyDirectAgentTerminalAdapter(
      async () => module,
      undefined,
      { PATH: "safe-path" },
      async (executable) => resolve("host-bin", executable),
    );

    const probe = await withoutTouchingTheHostProcess(async () => {
      const handle = await adapter.start({
        sessionId: `non-interference-${stop}`,
        provider: "codex",
        cwd: resolve("test-worktrees", `non-interference-${stop}`),
        cols: 80,
        rows: 24,
        onOutput: () => undefined,
        onExit: () => undefined,
      });
      await handle.write("run the tests\r");
      await handle.resize(120, 40);
      await handle.interrupt();
      await handle[stop]();
    });

    // No signal was delivered to any pid, and nothing was written to the stdin
    // of the process that stands in for AG Loop.
    assert.deepEqual(probe.signals, []);
    assert.deepEqual(probe.stdinWrites, []);
    assert.equal(probe.pidAfter, probe.pidBefore);
    // The only process stopped is the PTY this adapter spawned, exactly once.
    assert.equal(fake.killCount, 1);
    // Interrupt is an in-band control character on that PTY, never a SIGINT.
    assert.deepEqual(fake.writes, ["run the tests\r", "\x03"]);
    assert.deepEqual(fake.resizes, [[120, 40]]);
  });
}
