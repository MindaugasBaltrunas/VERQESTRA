import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { DirectAgentTerminalPort } from "../application/ports/direct-agent-terminal-port.js";
import type { GitRunnerPort } from "../application/ports/git-runner-port.js";
import { ProjectRegistry } from "../application/project-registry.js";
import {
  TERMINAL_STREAM_CLIENT_MESSAGE_TYPES,
  TERMINAL_STREAM_SERVER_MESSAGE_TYPES,
} from "../application/terminal-stream-service.js";
import {
  TerminalSupervisor,
  type WorktreeAllocationPort,
} from "../application/terminal-supervisor.js";
import type { TerminalSequencedEvent } from "../domain/terminal-replay-buffer.js";
import {
  TerminalWebSocketProtocol,
  type TerminalWebSocketPeer,
} from "../interfaces/websocket/terminal-websocket-gateway.js";

/**
 * NUKRYPIMAS (vieta, ne turinys): etalone kontraktas gyveno
 * `AG/openspec/changes/ag-mobile-voice-terminal/` ir buvo pasiekiamas per `process.cwd()`.
 *
 * VERQESTRA'oje `AG/openspec/changes/` laiko VERQESTRA SAVO pakeitimus, tad etalono keitimo
 * aplanko įkėlimas ten meluotų apie tai, kieno tas įrašas. Kontraktas — paketo kontraktas,
 * todėl guli paketo viduje, o kelias skaičiuojamas nuo modulio, ne nuo `process.cwd()`: kitame
 * workspace pakete paleistas bėgimas kitaip tyliai perskaitytų svetimą failą arba nieko.
 *
 * Pats YAML perkeltas BAITAS Į BAITĄ (`git diff --no-index` tuščias).
 */
const CONTRACT_PATH = resolve(
  fileURLToPath(import.meta.url),
  "../../../",
  "contracts",
  "asyncapi-contract.yaml",
);

const PROJECT_ID = "123e4567-e89b-42d3-a456-426614174080";

/** Message names declared under `components.messages`. */
function declaredMessageNames(contract: string): string[] {
  return [...contract.matchAll(/^ {6}name: (\S+)$/gm)].map((match) => match[1] as string);
}

test("declared AsyncAPI messages and produced stream messages stay identical", async () => {
  const contract = await readFile(CONTRACT_PATH, "utf8");
  const declared = declaredMessageNames(contract);
  assert.ok(declared.length > 0, "asyncapi-contract.yaml must declare messages");
  assert.deepEqual(
    [...declared].sort(),
    [
      ...TERMINAL_STREAM_SERVER_MESSAGE_TYPES,
      ...TERMINAL_STREAM_CLIENT_MESSAGE_TYPES,
    ].sort(),
  );
});

test("every declared server message is referenced by the receive operation", async () => {
  const contract = await readFile(CONTRACT_PATH, "utf8");
  const receiveBlock = /receiveTerminalEvents:[\s\S]*?messages:\n((?:\s+- \$ref:.*\n)+)/.exec(contract);
  assert.ok(receiveBlock?.[1], "receiveTerminalEvents must list its messages");
  const referenced = [...receiveBlock[1].matchAll(/messages\/(\w+)"/g)].map((match) => match[1] as string);
  assert.deepEqual(
    referenced.map((name) => name.replace(/^server/, "server.").toLowerCase()).sort(),
    [...TERMINAL_STREAM_SERVER_MESSAGE_TYPES].sort(),
  );
});

test("session lifecycle, input and lease events share one monotonic sequence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ag-mobile-asyncapi-"));
  try {
    const now = new Date("2026-07-28T10:00:00.000Z");
    const workspace = join(directory, "workspace");
    await mkdir(join(workspace, "repository", ".git"), { recursive: true });
    const registry = await ProjectRegistry.create({ personal: workspace });
    await registry.registerExisting({
      projectId: PROJECT_ID,
      name: "Stream project",
      rootId: "personal",
      relativePath: "repository",
      branch: "main",
    });
    const git: GitRunnerPort = {
      async run() {
        return { exitCode: 0, stdout: "abcdef1234567890\n", stderr: "" };
      },
    };
    const worktrees: WorktreeAllocationPort = {
      async allocate(input) {
        const worktreeRoot = join(directory, "sessions", input.sessionId);
        await mkdir(worktreeRoot, { recursive: true });
        return {
          sessionId: input.sessionId,
          branch: `mobile/${input.sessionId}`,
          baseCommit: input.baseCommit,
          worktreeRoot,
        };
      },
    };
    let pushOutput: ((data: string) => void) | undefined;
    const terminals: DirectAgentTerminalPort = {
      async start(request) {
        pushOutput = request.onOutput;
        return {
          pid: 1234,
          executable: "C:/tools/codex.cmd",
          async write() {},
          async resize() {},
          async interrupt() {},
          async terminate() {},
          async close() {},
        };
      },
    };
    const supervisor = new TerminalSupervisor({
      projects: registry,
      git,
      worktrees,
      terminals,
      clock: () => now,
      leaseTtlMs: 60_000,
    });
    const ownerDeviceId = "123e4567-e89b-42d3-a456-426614174081";
    const session = await supervisor.createSession({
      projectId: PROJECT_ID,
      ownerDeviceId,
      requestId: "asyncapi-create-1",
      provider: "codex",
      workspaceMode: "isolated-worktree",
      cols: 100,
      rows: 30,
    });

    const live: TerminalSequencedEvent[] = [];
    const stream = await supervisor.openOutputStream({
      projectId: PROJECT_ID,
      sessionId: session.sessionId,
      lastAckSequence: 0,
      onEvent: (event) => live.push(event),
    });

    // Events emitted before the client attached are replayed, not lost.
    assert.deepEqual(
      stream.replay.events.map((event) => event.type),
      ["server.session", "server.lease"],
    );

    const fence = {
      projectId: PROJECT_ID,
      sessionId: session.sessionId,
      ownerDeviceId,
      leaseId: session.lease.leaseId,
      leaseGeneration: session.lease.generation,
    };
    await supervisor.writeInput({
      ...fence,
      inputId: "123e4567-e89b-42d3-a456-426614174082",
      source: "voice",
      text: "run tests",
    });
    pushOutput?.("output line");
    await new Promise((resolve) => setImmediate(resolve));
    await supervisor.interrupt(fence);
    await supervisor.close(fence);

    // Output reaches the client in causal order, immediately after the input
    // that produced it — not deferred to the close flush.
    assert.deepEqual(live.map((event) => event.type), [
      "server.input",
      "server.input",
      "server.output",
      "server.session",
      "server.session",
      "server.session",
      "server.session",
      "server.lease",
    ]);

    // One sequence space, strictly increasing and contiguous, so a single
    // `client.ack` is unambiguous across every event kind.
    const sequences = [...stream.replay.events, ...live].map((event) => event.sequence);
    assert.deepEqual(sequences, sequences.map((_, index) => index + 1));

    await stream.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the stream sends a server.error frame before closing on a protocol violation", async () => {
  const sent: string[] = [];
  let closeCode: number | undefined;
  let messageListener: ((data: Buffer, isBinary: boolean) => void) | undefined;
  const peer: TerminalWebSocketPeer = {
    bufferedAmount: 0,
    send(text, callback) {
      sent.push(text);
      callback();
    },
    close(code) {
      closeCode = code;
    },
    onMessage(listener) {
      messageListener = listener;
    },
    onClose() {},
  };
  const protocol = new TerminalWebSocketProtocol(
    {} as never,
    { async canReadProject() { return false; }, async canControlTerminal() { return true; } },
  );
  protocol.accept("123e4567-e89b-42d3-a456-426614174083", peer);
  messageListener?.(Buffer.from("not json at all"), false);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(sent.length, 1);
  const frame = JSON.parse(sent[0] as string) as Record<string, unknown>;
  assert.deepEqual(Object.keys(frame).sort(), ["code", "correlationId", "recoverable", "type"]);
  assert.equal(frame["type"], "server.error");
  assert.equal(frame["code"], "invalid_message");
  assert.equal(frame["recoverable"], false);
  assert.match(String(frame["correlationId"]), /^[0-9a-f-]{36}$/);
  assert.equal(closeCode, 1008);
});
