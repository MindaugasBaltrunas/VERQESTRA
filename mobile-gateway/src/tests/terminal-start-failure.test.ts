// 2026-08-24 (operatoriaus radinys): klaida PO PTY paleidimo palikdavo gyvą, bet nevaldomą terminalą.
//
// `terminals.start` gali PAVYKTI, o kristi tai, kas eina po jo — `processes.identify`. Iki taisymo
// `catch` nuimdavo tik `activeSessionId`: handle likdavo neuždarytas, lease galiojantis, ir kitas
// kvietimas paleisdavo ANTRĄ seansą. Operatoriaus reprodukcija: `starts=2, closes=0`, nors hostui
// deklaruotas vienas seansas.
//
// Testas skaičiuoja PORTO kvietimus, o ne žiūri į vidinę būseną: būtent porto pusėje matomas
// procesas, kurio niekas nebeuždarė.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { GitRunnerPort } from "../application/ports/git-runner-port.js";
import type { ProcessIdentityPort } from "../application/ports/process-identity-port.js";
import { ProjectRegistry } from "../application/project-registry.js";
import {
  TerminalSupervisor,
  type WorktreeAllocationPort,
} from "../application/terminal-supervisor.js";
import type { DirectAgentTerminalPort } from "../application/ports/direct-agent-terminal-port.js";
import { AtomicJsonSessionRegistryStore } from "../infrastructure/atomic-json-session-registry-store.js";

const PROJECT_ID = "123e4567-e89b-42d3-a456-426614174000";
const OWNER_DEVICE_ID = "123e4567-e89b-42d3-a456-426614174081";
const GATEWAY_INSTANCE = "123e4567-e89b-42d3-a456-4266141740a0";
const NOW = new Date("2026-08-24T10:00:00.000Z");

async function world(): Promise<{
  supervisor: TerminalSupervisor;
  counters: { starts: number; closes: number; terminates: number; allocations: number };
  cleanup: () => Promise<void>;
}> {
  const directory = await mkdtemp(join(tmpdir(), "vq-terminal-start-fail-"));
  const workspace = join(directory, "workspace");
  // `.git` privalomas: `registerExisting` tikrina, ar kelias tikrai yra repozitorija.
  await mkdir(join(workspace, "repository", ".git"), { recursive: true });

  const registry = await ProjectRegistry.create({ personal: workspace });
  await registry.registerExisting({
    projectId: PROJECT_ID,
    name: "Start failure project",
    rootId: "personal",
    relativePath: "repository",
    branch: "main",
  });

  const counters = { starts: 0, closes: 0, terminates: 0, allocations: 0 };

  const git: GitRunnerPort = {
    async run() {
      return { exitCode: 0, stdout: "abcdef1234567890\n", stderr: "" };
    },
  };

  const worktrees: WorktreeAllocationPort = {
    async allocate(input) {
      counters.allocations += 1;
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

  // PTY paleidžiamas SĖKMINGAI — būtent tai daro radinį pavojingą.
  const terminals: DirectAgentTerminalPort = {
    async start() {
      counters.starts += 1;
      return {
        pid: 4321,
        executable: "C:/tools/codex.cmd",
        async write() {},
        async resize() {},
        async interrupt() {},
        async terminate() {
          counters.terminates += 1;
        },
        async close() {
          counters.closes += 1;
        },
      };
    },
  };

  // …o krinta ŽINGSNIS PO JO.
  const processes: ProcessIdentityPort = {
    async identify() {
      throw new Error("host refused to identify the pid");
    },
  };

  // `registry`, `processes` ir `gatewayInstanceId` paduodami KARTU — prižiūrėtojas dalinės
  // konfigūracijos nepriima (fail-closed), o `processes` čia ir yra viso testo esmė.
  const supervisor = new TerminalSupervisor({
    projects: registry,
    git,
    worktrees,
    terminals,
    processes,
    registry: new AtomicJsonSessionRegistryStore(join(directory, "sessions.json"), GATEWAY_INSTANCE),
    gatewayInstanceId: GATEWAY_INSTANCE,
    clock: () => NOW,
    leaseTtlMs: 60_000,
  });

  return { supervisor, counters, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

test("klaida PO `terminals.start` uždaro handle — nelieka nevaldomo PTY", async () => {
  const { supervisor, counters, cleanup } = await world();
  try {
    await assert.rejects(
      () =>
        supervisor.createSession({
          projectId: PROJECT_ID,
          ownerDeviceId: OWNER_DEVICE_ID,
          requestId: "req-1",
          provider: "codex",
          workspaceMode: "isolated-worktree",
          cols: 80,
          rows: 24,
        }),
      /terminal/i,
    );

    assert.equal(counters.starts, 1, "PTY buvo paleistas");
    assert.equal(counters.closes, 1, "…ir uždarytas: kitaip liktų procesas be valdytojo");
  } finally {
    await cleanup();
  }
});

test("pakartotinis bandymas nepalieka DVIEJŲ gyvų PTY", async () => {
  const { supervisor, counters, cleanup } = await world();
  try {
    for (const requestId of ["req-1", "req-2"]) {
      await assert.rejects(
        () =>
          supervisor.createSession({
            projectId: PROJECT_ID,
            ownerDeviceId: OWNER_DEVICE_ID,
            requestId,
            provider: "codex",
            workspaceMode: "isolated-worktree",
            cols: 80,
            rows: 24,
          }),
        /terminal/i,
      );
    }

    // Operatoriaus reprodukcija buvo `starts=2, closes=0`. Startų vis dar du — pakartotinis
    // bandymas teisėtas, — bet nė vienas jų nebelieka atviras.
    assert.equal(counters.starts, 2);
    assert.equal(counters.closes, 2, `nevaldomų PTY: ${counters.starts - counters.closes}`);
  } finally {
    await cleanup();
  }
});
