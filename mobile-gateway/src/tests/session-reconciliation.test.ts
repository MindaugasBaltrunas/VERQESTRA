import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { GitRunnerPort } from "../application/ports/git-runner-port.js";
import type { ProcessIdentityPort } from "../application/ports/process-identity-port.js";
import { ProjectRegistry } from "../application/project-registry.js";
import { SessionReconciliationService } from "../application/session-reconciliation-service.js";
import { TerminalSupervisor } from "../application/terminal-supervisor.js";
import type {
  PersistedSessionRecord,
  ProcessIdentity,
} from "../domain/session-registry.js";
import {
  AtomicJsonSessionRegistryStore,
  SessionRegistryIntegrityError,
} from "../infrastructure/atomic-json-session-registry-store.js";

const INSTANCE = "123e4567-e89b-42d3-a456-426614174090";
const SESSION = "123e4567-e89b-42d3-a456-426614174091";
const PROCESS: ProcessIdentity = {
  pid: 4242,
  startedAt: "2026-07-28T09:59:00.000Z",
  executable: "C:/tools/codex.cmd",
};

function record(
  sessionRoot: string,
  overrides: Partial<PersistedSessionRecord> = {},
): PersistedSessionRecord {
  return {
    sessionId: SESSION,
    projectId: "123e4567-e89b-42d3-a456-426614174092",
    provider: "codex",
    worktreeRoot: join(sessionRoot, SESSION),
    branch: `mobile/${SESSION}`,
    baseCommit: "abcdef1234567890",
    state: "live",
    lease: {
      leaseId: "123e4567-e89b-42d3-a456-426614174093",
      ownerDeviceId: "123e4567-e89b-42d3-a456-426614174094",
      generation: 3,
      expiresAt: "2026-07-28T11:00:00.000Z",
      status: "active",
    },
    process: PROCESS,
    gatewayInstanceId: INSTANCE,
    ...overrides,
  };
}

/**
 * The same record with no captured process identity.
 *
 * NUKRYPIMAS (formos, ne elgesio): etalonas išreiškė šį atvejį kaip
 * `{ process: undefined }`. `exactOptionalPropertyTypes` skiria „lauko nėra" nuo „laukas yra,
 * bet neapibrėžtas", o `PersistedSessionRecord.process` deklaruotas kaip `process?:
 * ProcessIdentity` — tad scenarijus išreiškiamas RAKTO PRALEIDIMU. Tai net tiksliau: testas
 * tikrina įrašą, kuriame proceso tapatybė niekada nebuvo užfiksuota, o ne įrašą su tuščiu lauku.
 */
function withoutProcess(base: PersistedSessionRecord): PersistedSessionRecord {
  const { process: unusedProcess, ...rest } = base;
  void unusedProcess;
  return rest;
}

function processes(identity?: ProcessIdentity): ProcessIdentityPort {
  return {
    async identify(pid) {
      return identity && identity.pid === pid ? identity : undefined;
    },
  };
}

function git(topLevel?: string): GitRunnerPort {
  return {
    async run(cwd) {
      if (topLevel === undefined) {
        return { exitCode: 128, stdout: "", stderr: "not a work tree" };
      }
      return { exitCode: 0, stdout: `${topLevel ?? cwd}\n`, stderr: "" };
    },
  };
}

async function seed(
  directory: string,
  seededRecord: PersistedSessionRecord,
): Promise<AtomicJsonSessionRegistryStore> {
  const store = new AtomicJsonSessionRegistryStore(join(directory, "sessions.json"), INSTANCE);
  await store.update((snapshot) => ({
    snapshot: {
      ...snapshot,
      revision: snapshot.revision + 1,
      sessions: { [seededRecord.sessionId]: seededRecord },
    },
    result: undefined,
  }));
  return store;
}

test("an exactly matching process is reattached and its pre-restart lease is still revoked", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ag-mobile-reconcile-"));
  try {
    const sessionRoot = join(directory, "sessions");
    const seeded = record(sessionRoot);
    const store = await seed(directory, seeded);
    const service = new SessionReconciliationService(
      store,
      processes(PROCESS),
      git(seeded.worktreeRoot),
      sessionRoot,
    );

    const report = await service.reconcile();
    assert.deepEqual(report.reattached, [SESSION]);
    assert.deepEqual(report.orphaned, []);
    assert.equal(report.outcomes[0]?.state, "live");
    // Step 6: even a reattached session cannot keep its old lease generation,
    // or a pre-restart writer could still fence a post-restart mutation.
    assert.equal(report.outcomes[0]?.leaseGeneration, 4);

    const persisted = await store.read();
    assert.equal(persisted.sessions[SESSION]?.state, "live");
    assert.equal(persisted.sessions[SESSION]?.lease.status, "revoked");
    assert.equal(persisted.revision > 2, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("any single mismatch keeps the session orphaned", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ag-mobile-reconcile-mismatch-"));
  try {
    const sessionRoot = join(directory, "sessions");
    const seeded = record(sessionRoot);
    const cases: Array<{ name: string; build: () => SessionReconciliationService }> = [];
    const make = async (
      name: string,
      seededRecord: PersistedSessionRecord,
      identity: ProcessIdentity | undefined,
      topLevel: string | undefined,
      root = sessionRoot,
    ) => {
      const caseDirectory = await mkdtemp(join(tmpdir(), "ag-mobile-case-"));
      const store = await seed(caseDirectory, seededRecord);
      cases.push({
        name,
        build: () => new SessionReconciliationService(store, processes(identity), git(topLevel), root),
      });
    };

    await make("process is gone", seeded, undefined, seeded.worktreeRoot);
    await make("pid was recycled by another process", seeded, {
      ...PROCESS,
      startedAt: "2026-07-28T10:30:00.000Z",
    }, seeded.worktreeRoot);
    await make("executable changed", seeded, {
      ...PROCESS,
      executable: "C:/tools/other.exe",
    }, seeded.worktreeRoot);
    await make("git does not report the worktree", seeded, PROCESS, undefined);
    await make("git reports a different worktree", seeded, PROCESS, join(sessionRoot, "elsewhere"));
    await make(
      "worktree escaped the session root",
      { ...seeded, worktreeRoot: join(directory, "outside", SESSION) },
      PROCESS,
      join(directory, "outside", SESSION),
    );
    await make(
      "record belongs to another gateway instance",
      { ...seeded, gatewayInstanceId: "123e4567-e89b-42d3-a456-426614174099" },
      PROCESS,
      seeded.worktreeRoot,
    );
    await make("no process identity was ever recorded", withoutProcess(seeded), PROCESS, seeded.worktreeRoot);

    for (const { name, build } of cases) {
      const report = await build().reconcile();
      assert.deepEqual(report.orphaned, [SESSION], name);
      assert.equal(report.outcomes[0]?.state, "orphaned", name);
      assert.equal(report.outcomes[0]?.leaseGeneration, 4, name);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("terminal sessions are left untouched by reconciliation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ag-mobile-reconcile-terminal-"));
  try {
    const sessionRoot = join(directory, "sessions");
    const seeded = record(sessionRoot, { state: "ended" });
    const store = await seed(directory, seeded);
    const report = await new SessionReconciliationService(
      store,
      processes(PROCESS),
      git(seeded.worktreeRoot),
      sessionRoot,
    ).reconcile();

    assert.deepEqual(report.outcomes.map((outcome) => outcome.verdict), ["already_terminal"]);
    const persisted = await store.read();
    assert.equal(persisted.sessions[SESSION]?.state, "ended");
    assert.equal(persisted.sessions[SESSION]?.lease.generation, 3);
    assert.equal(persisted.sessions[SESSION]?.lease.status, "active");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a tampered or rolled-back registry fails closed instead of reconciling", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ag-mobile-registry-integrity-"));
  const registryFile = join(directory, "sessions.json");
  try {
    const sessionRoot = join(directory, "sessions");
    await seed(directory, record(sessionRoot));

    const onDisk = JSON.parse(await readFile(registryFile, "utf8")) as {
      checksum: string;
      snapshot: { sessions: Record<string, { state: string }> };
    };
    onDisk.snapshot.sessions[SESSION]!.state = "live";
    onDisk.checksum = onDisk.checksum.replace(/^./, (character) => character === "a" ? "b" : "a");
    await writeFile(registryFile, JSON.stringify(onDisk), "utf8");

    await assert.rejects(
      () => new AtomicJsonSessionRegistryStore(registryFile, INSTANCE).read(),
      (error: unknown) => error instanceof SessionRegistryIntegrityError
        && error.reason === "checksum_mismatch",
    );

    await writeFile(registryFile, "{ not json", "utf8");
    await assert.rejects(
      () => new AtomicJsonSessionRegistryStore(registryFile, INSTANCE).read(),
      (error: unknown) => error instanceof SessionRegistryIntegrityError
        && error.reason === "malformed",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a supervisor-created session survives a restart and is reattached", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ag-mobile-registry-roundtrip-"));
  try {
    const now = new Date("2026-07-28T10:00:00.000Z");
    const sessionRoot = join(directory, "sessions");
    const workspace = join(directory, "workspace");
    await mkdir(join(workspace, "repository", ".git"), { recursive: true });
    const projects = await ProjectRegistry.create({ personal: workspace });
    const projectId = "123e4567-e89b-42d3-a456-426614174095";
    await projects.registerExisting({
      projectId,
      name: "Restart project",
      rootId: "personal",
      relativePath: "repository",
      branch: "main",
    });
    const liveProcess: ProcessIdentity = {
      pid: 7788,
      startedAt: "2026-07-28T09:58:00.000Z",
      executable: "C:/tools/codex.cmd",
    };
    const store = new AtomicJsonSessionRegistryStore(join(directory, "sessions.json"), INSTANCE);
    let worktreeRoot = "";
    const supervisor = new TerminalSupervisor({
      projects,
      git: { async run() { return { exitCode: 0, stdout: "abcdef1234567890\n", stderr: "" }; } },
      worktrees: {
        async allocate(input) {
          worktreeRoot = join(sessionRoot, input.sessionId);
          await mkdir(worktreeRoot, { recursive: true });
          return {
            sessionId: input.sessionId,
            branch: `mobile/${input.sessionId}`,
            baseCommit: input.baseCommit,
            worktreeRoot,
          };
        },
      },
      terminals: {
        async start() {
          return {
            pid: liveProcess.pid,
            executable: liveProcess.executable,
            async write() {},
            async resize() {},
            async interrupt() {},
            async terminate() {},
            async close() {},
          };
        },
      },
      clock: () => now,
      leaseTtlMs: 60_000,
      registry: store,
      processes: processes(liveProcess),
      gatewayInstanceId: INSTANCE,
    });

    const created = await supervisor.createSession({
      projectId,
      ownerDeviceId: "123e4567-e89b-42d3-a456-426614174096",
      requestId: "restart-create-1",
      provider: "codex",
      workspaceMode: "isolated-worktree",
      cols: 100,
      rows: 30,
    });

    const persisted = await store.read();
    const stored = persisted.sessions[created.sessionId];
    assert.equal(stored?.state, "live");
    assert.equal(stored?.process?.pid, liveProcess.pid);
    assert.equal(stored?.process?.startedAt, liveProcess.startedAt);
    assert.equal(stored?.lease.generation, created.lease.generation);

    // A fresh gateway process reads the same file and reattaches the session.
    const restarted = new AtomicJsonSessionRegistryStore(join(directory, "sessions.json"), INSTANCE);
    const report = await new SessionReconciliationService(
      restarted,
      processes(liveProcess),
      git(worktreeRoot),
      sessionRoot,
    ).reconcile();
    assert.deepEqual(report.reattached, [created.sessionId]);
    assert.equal(
      report.outcomes[0]?.leaseGeneration,
      created.lease.generation + 1,
      "the pre-restart lease must not remain usable",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the registry refuses a non-increasing revision", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ag-mobile-registry-revision-"));
  try {
    const store = new AtomicJsonSessionRegistryStore(join(directory, "sessions.json"), INSTANCE);
    await assert.rejects(
      () => store.update((snapshot) => ({ snapshot, result: undefined })),
      (error: unknown) => error instanceof SessionRegistryIntegrityError
        && error.reason === "revision_rollback",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
