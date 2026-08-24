import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type {
  DirectAgentTerminalHandle,
  DirectAgentTerminalPort,
} from "../application/ports/direct-agent-terminal-port.js";
import type { GitRunnerPort } from "../application/ports/git-runner-port.js";
import { ProjectRegistry } from "../application/project-registry.js";
import {
  TerminalSupervisor,
  TerminalSupervisorError,
  type WorktreeAllocationPort,
} from "../application/terminal-supervisor.js";
import { TerminalStreamService } from "../application/terminal-stream-service.js";
import type { TerminalStreamSink } from "../application/terminal-stream-service.js";
import type { AgentProvider } from "../domain/terminal-session.js";

/**
 * `verification-matrix.md`: "The same suite runs against Claude Code and Codex
 * fake and real-smoke adapters. Real-smoke tests may be skipped when a provider
 * is unavailable, but fake adapter contract tests are mandatory in CI."
 *
 * The two invariants proven here are the ones the rest of the
 * `DirectAgentTerminalPort` suites leave to the runtime rather than to a test:
 *
 * - PTY-09, client disconnect: closing a stream subscription must free the
 *   subscription and nothing else. Every other disconnect test asserts on a fake
 *   stream port, whose `close()` counter cannot distinguish "the subscription
 *   ended" from "the PTY was closed". Here the port under the stream is the real
 *   supervisor, so a `close()` that reached the provider handle is observable.
 * - PTY-12, provider exits: the exit arrives on the adapter's `onExit` callback,
 *   not through any caller, so nothing outside the supervisor can normalize it.
 *
 * Both run against a fake adapter for both providers, with no host, provider or
 * environment precondition — that is what "mandatory in CI" means, and the last
 * test in this file holds that line for the workflow as well.
 */

const projectId = "123e4567-e89b-42d3-a456-426614174100";
const ownerDeviceId = "123e4567-e89b-42d3-a456-426614174101";
const now = new Date("2026-08-11T09:00:00.000Z");

type ProviderHost = Readonly<{
  supervisor: TerminalSupervisor;
  /** Feeds provider output through the adapter callback the supervisor wired. */
  emitOutput: (data: string) => void;
  /** Delivers the provider's own exit, the way node-pty's `onExit` would. */
  emitExit: (exitCode: number | null) => void;
  /** How often the supervisor asked the provider handle to stop. */
  stops: () => Readonly<{ terminate: number; close: number }>;
  dispose: () => Promise<void>;
}>;

async function fakeProviderHost(provider: AgentProvider): Promise<ProviderHost> {
  const directory = await mkdtemp(join(tmpdir(), `ag-fake-provider-${provider}-`));
  const workspace = join(directory, "workspace");
  const repository = join(workspace, "repo");
  const sessionRoot = join(directory, "sessions");
  await mkdir(join(repository, ".git"), { recursive: true });
  await mkdir(sessionRoot, { recursive: true });

  const projects = await ProjectRegistry.create({ personal: workspace });
  await projects.registerExisting({
    projectId,
    name: "Repo",
    rootId: "personal",
    relativePath: "repo",
    branch: "main",
  });

  const git: GitRunnerPort = {
    async run() {
      return { exitCode: 0, stdout: `${"a".repeat(40)}\n`, stderr: "" };
    },
  };
  const worktrees: WorktreeAllocationPort = {
    async allocate(input) {
      const worktreeRoot = join(sessionRoot, input.sessionId);
      await mkdir(worktreeRoot, { recursive: true });
      return {
        sessionId: input.sessionId,
        branch: `mobile/${input.sessionId}`,
        baseCommit: input.baseCommit,
        worktreeRoot,
      };
    },
  };

  let terminateCount = 0;
  let closeCount = 0;
  let emitOutput: ((data: string) => void) | undefined;
  let emitExit: ((exitCode: number | null) => void) | undefined;
  const handle: DirectAgentTerminalHandle = {
    pid: 5150,
    executable: provider === "codex" ? "C:/tools/codex.cmd" : "C:/tools/claude.exe",
    async write() {
      // The write path is proven by the supervisor's own idempotency suite.
    },
    async resize() {
      return undefined;
    },
    async interrupt() {
      return undefined;
    },
    async terminate() {
      terminateCount += 1;
    },
    async close() {
      closeCount += 1;
    },
  };
  const terminals: DirectAgentTerminalPort = {
    async start(input) {
      assert.equal(input.provider, provider, "the supervisor must start the provider it was asked for");
      emitOutput = input.onOutput;
      emitExit = input.onExit;
      return handle;
    },
  };

  return {
    supervisor: new TerminalSupervisor({
      projects,
      git,
      worktrees,
      terminals,
      clock: () => now,
      leaseTtlMs: 60_000,
    }),
    emitOutput: (data) => {
      assert.ok(emitOutput, "no session has been started yet");
      emitOutput(data);
    },
    emitExit: (exitCode) => {
      assert.ok(emitExit, "no session has been started yet");
      emitExit(exitCode);
    },
    stops: () => Object.freeze({ terminate: terminateCount, close: closeCount }),
    dispose: () => rm(directory, { recursive: true, force: true }),
  };
}

/** A sink that records what the phone would have received. */
function recordingSink(): Readonly<{ sink: TerminalStreamSink; sequences: number[] }> {
  const sequences: number[] = [];
  return {
    sink: {
      async send(event) {
        if (event.type === "server.output") sequences.push(event.sequence);
      },
      bufferedBytes() {
        return 0;
      },
      close() {
        return undefined;
      },
    },
    sequences,
  };
}

/** Lets the supervisor's serialized operation queue drain. */
async function settle(host: ProviderHost, sessionId: string): Promise<void> {
  // `getSession` goes through the same FIFO queue as the exit handler, so
  // awaiting it is enough — no timer, and nothing to make the suite flaky.
  await host.supervisor.getSession(projectId, sessionId).catch(() => undefined);
}

for (const provider of ["claude-code", "codex"] as const) {
  test(`PTY-09 ${provider}: a client disconnect leaves the provider live and replay continues`, async () => {
    const host = await fakeProviderHost(provider);
    try {
      const session = await host.supervisor.createSession({
        projectId,
        ownerDeviceId,
        requestId: `pty-09-${provider}`,
        provider,
        workspaceMode: "isolated-worktree",
        cols: 100,
        rows: 30,
      });

      const first = recordingSink();
      const stream = new TerminalStreamService(host.supervisor, () => now);
      const connection = await stream.connect(
        { projectId, sessionId: session.sessionId, lastAckSequence: 0 },
        first.sink,
      );
      host.emitOutput("before the phone dropped\n");
      await settle(host, session.sessionId);
      assert.ok(first.sequences.length > 0, "the attached client received live output");
      const lastSeen = first.sequences[first.sequences.length - 1] as number;

      // The phone goes away. This is the whole scenario: nothing else is called.
      await connection.close();
      await settle(host, session.sessionId);

      host.emitOutput("produced while nobody was attached\n");
      await settle(host, session.sessionId);

      // The provider was neither stopped nor closed by the disconnect.
      assert.deepEqual(host.stops(), { terminate: 0, close: 0 });
      assert.equal((await host.supervisor.getSession(projectId, session.sessionId)).state, "live");

      // And the output produced while detached is still replayable, in order,
      // from the last sequence the client acknowledged seeing.
      const replay = await host.supervisor.replayAfter(projectId, session.sessionId, lastSeen);
      const replayed = replay.events.flatMap((event) => (
        event.type === "server.output" ? [event.data] : []
      ));
      assert.deepEqual(replayed, ["produced while nobody was attached\n"]);
      assert.equal(replay.historyTruncated, false);

      // A reconnect resumes from that sequence without re-sending what was seen.
      const second = recordingSink();
      const resumed = await stream.connect(
        { projectId, sessionId: session.sessionId, lastAckSequence: lastSeen },
        second.sink,
      );
      await settle(host, session.sessionId);
      assert.ok(
        second.sequences.every((sequence) => sequence > lastSeen),
        `reconnect replayed an already acknowledged sequence: ${second.sequences.join(",")}`,
      );
      await resumed.close();
    } finally {
      await host.dispose();
    }
  });

  test(`PTY-12 ${provider}: a provider exit is normalized once and frees the host`, async () => {
    const host = await fakeProviderHost(provider);
    try {
      const session = await host.supervisor.createSession({
        projectId,
        ownerDeviceId,
        requestId: `pty-12-${provider}`,
        provider,
        workspaceMode: "isolated-worktree",
        cols: 100,
        rows: 30,
      });
      assert.equal(session.state, "live");

      // A second session is refused while the first one holds the host, so the
      // release asserted below is caused by the exit and by nothing else.
      await assert.rejects(
        host.supervisor.createSession({
          projectId,
          ownerDeviceId,
          requestId: `pty-12-${provider}-busy`,
          provider,
          workspaceMode: "isolated-worktree",
          cols: 100,
          rows: 30,
        }),
        (error: unknown) => error instanceof TerminalSupervisorError && error.code === "host_busy",
      );

      host.emitOutput("goodbye\n");
      host.emitExit(1);
      // A provider that exits twice — node-pty can deliver a late duplicate — is
      // still one lifecycle transition.
      host.emitExit(1);
      await settle(host, session.sessionId);

      const ended = await host.supervisor.getSession(projectId, session.sessionId);
      assert.equal(ended.state, "failed", "an unrequested exit is a failure, not a clean end");
      // The supervisor never asked the handle to stop: the provider stopped itself.
      assert.deepEqual(host.stops(), { terminate: 0, close: 0 });

      const replay = await host.supervisor.replayAfter(projectId, session.sessionId, 0);
      const sessionEvents = replay.events.filter((event) => event.type === "server.session");
      assert.deepEqual(
        sessionEvents.map((event) => (event.type === "server.session" ? event.state : undefined)),
        ["live", "failed"],
        "the exit produced exactly one further session transition",
      );
      // Output buffered when the provider exited is flushed before the transition.
      const outputIndex = replay.events.findIndex((event) => event.type === "server.output");
      const failedIndex = replay.events.findIndex(
        (event) => event.type === "server.session" && event.state === "failed",
      );
      assert.ok(outputIndex >= 0 && outputIndex < failedIndex, "final output is flushed before the exit");
      // The lease dies with the provider, so no fenced mutation can follow it.
      assert.equal(ended.lease.generation > session.lease.generation, true);

      // The host is free again: the exit released the single-session reservation.
      const next = await host.supervisor.createSession({
        projectId,
        ownerDeviceId,
        requestId: `pty-12-${provider}-after-exit`,
        provider,
        workspaceMode: "isolated-worktree",
        cols: 100,
        rows: 30,
      });
      assert.notEqual(next.sessionId, session.sessionId);
      assert.equal(next.state, "live");
    } finally {
      await host.dispose();
    }
  });
}

// mandate-scan boundary (this file only)

/**
 * The mandate itself. A contract suite that CI is free to skip proves nothing,
 * and the failure mode is silent: a provider guard or a `continue-on-error` step
 * turns a red suite into a green run without ever changing an assertion.
 */

const packageRoot = resolve(fileURLToPath(import.meta.url), "../../../");
const repositoryRoot = resolve(packageRoot, "..");
const workflowFile = resolve(repositoryRoot, ".github", "workflows", "ci.yml");
const mobileAppSource = resolve(repositoryRoot, "mobile-app", "src");

/** Everything that would make a test conditional on the host or on an env var. */
const CONDITIONAL_MARKERS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\btest\.skip\s*\(/, "test.skip()"],
  [/\bt\.skip\s*\(/, "t.skip()"],
  [/\bskip\s*:/, "a skip option"],
  [/\btodo\s*:/, "a todo option"],
  [/\bprocess\.env\b/, "process.env"],
];

/**
 * Everything after this marker in THIS file states the forbidden markers
 * verbatim — as regex literals, as their human-readable names, and as the
 * fixtures that prove they still fire — so scanning it would report this proof
 * as the violation it exists to catch. Every contract test lives above the
 * marker and is scanned.
 *
 * Built from two pieces so the constant's own text is not the marker: the only
 * contiguous occurrence in the file is the comment line, and that is the cut.
 */
const SELF_SCAN_MARKER = "// mandate-scan boundary" + " (this file only)";

test("the fake-provider contract suites are unconditional", async () => {
  // The real-smoke checks live outside this suite by design: the matrix allows
  // them to be skipped, these may not be.
  //
  // PAPILDYMAS (VERQESTRA): sąraše yra ir abu skaidymo metu atsiradę failai
  // (`terminal-supervisor-noninterference`, `agent-provider-host-probe`). Be jų pusę privalomo
  // įrodymo būtų galima padaryti sąlygine, o mandatas to nepamatytų — skaidymas būtų tyliai
  // susiaurinęs vartus, kuriuos pats turėjo išsaugoti.
  const mandatory = [
    "fake-provider-contract.test.ts",
    "node-pty-direct-agent-terminal-adapter.test.ts",
    "agent-provider-connection.test.ts",
    "agent-provider-host-probe.test.ts",
    "terminal-supervisor.test.ts",
    "terminal-supervisor-noninterference.test.ts",
  ];
  for (const name of mandatory) {
    const source = await readFile(join(packageRoot, "src", "tests", name), "utf8");
    let scanned = source;
    if (name === "fake-provider-contract.test.ts") {
      const boundary = source.indexOf(SELF_SCAN_MARKER);
      assert.ok(boundary > 0, "this file lost its own scan boundary marker");
      scanned = source.slice(0, boundary);
      // The exempt tail must never grow to cover a real contract test.
      assert.ok(scanned.includes("PTY-09"), "the contract tests fell outside the scanned region");
      assert.ok(scanned.includes("PTY-12"), "the contract tests fell outside the scanned region");
    }
    for (const [marker, description] of CONDITIONAL_MARKERS) {
      assert.doesNotMatch(scanned, marker, `${name} makes a mandatory contract test conditional via ${description}`);
    }
  }
});

// mandate-scan boundary (this file only)

test("the marker table recognises the conditions it forbids", () => {
  // Without this the scan above could go vacuous after a harmless-looking edit.
  const violations = [
    "test.skip('unavailable provider', () => {})",
    "test('x', async (t) => { t.skip('no provider'); })",
    "test('x', { skip: true }, () => {})",
    "test('x', { todo: true }, () => {})",
    "if (process.env.CLAUDE_CODE_PATH) test('x', () => {})",
  ];
  for (const violation of violations) {
    assert.ok(
      CONDITIONAL_MARKERS.some(([marker]) => marker.test(violation)),
      `no marker recognised: ${violation}`,
    );
  }
  for (const allowed of [
    "test('a fixed executable is used', () => {})",
    "assert.equal(methods.length, 2, 'must be parsed, not silently skipped')",
  ]) {
    assert.ok(
      !CONDITIONAL_MARKERS.some(([marker]) => marker.test(allowed)),
      `marker fired on legitimate source: ${allowed}`,
    );
  }
});

/**
 * NUKRYPIMAS (VERQESTRA keliai + savaime užsidarantis vartas).
 *
 * Etalonas reikalavo DVIEJŲ CI žingsnių: `pnpm --dir AG/mobile-gateway test` ir
 * `pnpm --dir AG/mobile-app test`. VERQESTRA'oje paketai guli šaknyje, o šliuzo žingsnis
 * vadinasi `pnpm test:mobile`.
 *
 * `mobile-app` žingsnio DAR NĖRA, ir tai sąmoninga: `mobile-app/src` neegzistuoja, tad `tsc`
 * grąžintų TS18003 ir žingsnis kristų dėl nepastatyto paketo, ne dėl regresijos. Bet „dar
 * nėra" negali virsti „taip ir liko": antrasis tikrinimas žemiau pats užsidaro — vos
 * `mobile-app/src` atsiranda turinys, CI žingsnio nebuvimas tampa raudonu testu.
 */
const MANDATORY_CI_COMMANDS: readonly string[] = ["pnpm test:mobile"];

async function workflowSteps(): Promise<readonly string[]> {
  const workflow = await readFile(workflowFile, "utf8");
  // Step blocks, split on the `- name:` / `- run:` list markers of the job's
  // `steps:` sequence. Parsing the whole YAML would need a dependency the
  // gateway does not carry; the sequence markers are unambiguous enough here.
  return workflow.split(/\n {6}- (?=name:|run:|uses:)/);
}

test("CI runs the gateway suite, and it may not fail without failing the job", async () => {
  const steps = await workflowSteps();
  for (const command of MANDATORY_CI_COMMANDS) {
    const step = steps.find((candidate) => candidate.includes(command));
    assert.ok(step, `${workflowFile} runs no step for: ${command}`);
    assert.doesNotMatch(
      step,
      /continue-on-error:\s*true/,
      `${command} is allowed to fail without failing CI`,
    );
    // A guard on anything but the platform would defeat the mandate as surely as
    // a skip. The platform gate is the one accepted condition: the mobile
    // packages depend on node-pty, whose Windows build toolchain this repository
    // does not validate, so they are a Linux job by design.
    const conditions = [...step.matchAll(/^\s*if:\s*(.+)$/gm)].map((match) => match[1]?.trim());
    for (const condition of conditions) {
      assert.equal(
        condition,
        "runner.os == 'Linux'",
        `${command} is gated on an unexpected workflow condition: ${condition}`,
      );
    }
  }
});

test("the moment mobile-app has sources, CI must run its suite too", async () => {
  const sources = await readdir(mobileAppSource).catch(() => undefined);
  if (sources === undefined || sources.length === 0) {
    // Nothing to run yet. This is the state the exemption above describes, and
    // the assertion below is what stops it from outliving that state.
    return;
  }
  const steps = await workflowSteps();
  const step = steps.find((candidate) => candidate.includes("test:mobile-app"));
  assert.ok(
    step,
    `mobile-app/src now has ${sources.length} entries, so ${workflowFile} must run its suite`,
  );
  assert.doesNotMatch(step, /continue-on-error:\s*true/, "the mobile-app suite may not fail silently");
});
