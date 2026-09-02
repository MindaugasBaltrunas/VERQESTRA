// VQ-504 (54/N) testai — loop'o surišimas kompozicijoje.
//
// Surišimo testas negali (ir neturi) sukti tikros bangos: jo darbas — patikrinti, kad portai
// SUJUNGTI teisingai ir kad sprendimai, kurie gimsta būtent čia, yra tie patys, kuriuos aprašo
// application pusė. Prikalama: remonto užduotis atpažįstama pagal bucket'ą IR failą, keliai
// sudedami prieš projekto šaknį, o startas kviečia reaper'ius.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { buildLoopCyclePorts, runLoopCommand, type LoopCommandDeps } from "../composition/loop/command.js";
import type { EmptyQueuePorts } from "../application/scheduling/loop-empty-queue.js";
import type { WaveDispatchSlot } from "../application/scheduling/wave-dispatch-model.js";
import { acquireWorkerLease } from "../application/scheduling/worker-lease-store.js";
import { schedulingFs } from "../composition/loop/adapters.js";

async function deps(): Promise<{ deps: LoopCommandDeps; root: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "vq-504-loop-"));
  const emptyQueue = {
    detectBootstrapEligibility: () => Promise.resolve({ bootstrapEligible: false }),
    runBootstrap: () => Promise.resolve({ status: "skipped", render: "" }),
    resolveModel: () => Promise.resolve("model"),
    synthesizeWave: () => Promise.resolve({ created: 0, already_implemented: 0, external_satisfied: 0 } as never),
    runQualityGates: () => Promise.resolve(0),
    dispatchAuditRepair: () => Promise.resolve(),
    runConverge: () => Promise.resolve({ issues: [] }),
    log: () => Promise.resolve(),
    out: () => {},
    env: {},
  } as unknown as EmptyQueuePorts;

  return {
    root,
    deps: {
      roots: {
        projectRoot: root,
        agRoot: path.join(root, "AG"),
        runtimeRoot: path.join(root, "vq"),
      },
      log: () => Promise.resolve(),
      out: () => {},
      emptyQueue,
      preconditions: { gitStatusPorcelain: () => Promise.resolve([]) } as never,
      taskSelection: {
        listMarkdownFilePaths: () => Promise.resolve([]),
        liveLeaseTaskIds: () => Promise.resolve(new Set<string>()),
      },
      consumeStopRequest: () => Promise.resolve(false),
      resumeTask: () => Promise.resolve(true),
      processAuditRepairTask: () => Promise.resolve(),
      env: {},
    },
  };
}

test("remonto užduotis atpažįstama pagal bucket'ą IR failą", async () => {
  const world = await deps();
  try {
    const ports = buildLoopCyclePorts(world.deps);

    assert.equal(ports.isAuditRepairTask({ bucket: "error", file: "AG/tasks/error/claude-audit-repair.md" }), true);
    // Tas pats failas kitame bucket'e nėra remonto kelias: `error` yra jo tapatybės dalis.
    assert.equal(ports.isAuditRepairTask({ bucket: "active", file: "AG/tasks/active/claude-audit-repair.md" }), false);
    assert.equal(ports.isAuditRepairTask({ bucket: "error", file: "AG/tasks/error/0042.md" }), false);
  } finally {
    await rm(world.root, { recursive: true, force: true });
  }
});

test("keliai sudedami prieš projekto šaknį", async () => {
  const world = await deps();
  try {
    const ports = buildLoopCyclePorts(world.deps);
    assert.equal(ports.absolutePath("AG/tasks/queue/0001.md"), path.join(world.root, "AG/tasks/queue/0001.md"));
  } finally {
    await rm(world.root, { recursive: true, force: true });
  }
});

test("higienos žingsniai NIEKADA nemeta, net tuščiame kataloge", async () => {
  const world = await deps();
  try {
    const ports = buildLoopCyclePorts(world.deps);
    // Nei lease store, nei git medžio čia nėra — abu turi grąžinti eilutes, o ne kristi.
    assert.ok(Array.isArray(await ports.reapDeadLeases()));
    assert.ok(Array.isArray(await ports.reapOrphanWorktrees()));
  } finally {
    await rm(world.root, { recursive: true, force: true });
  }
});

test("tuščia eilė be task'ų duoda `empty`, o ne kritimą", async () => {
  const world = await deps();
  try {
    const ports = buildLoopCyclePorts(world.deps);
    const selection = await ports.scheduler.nextTask();
    assert.equal(selection.kind, "empty");
  } finally {
    await rm(world.root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// gyvybės žymė: ciklas atnaujina SAVO heartbeat'ą ir atlaisvina įrašą pabaigoje
// ---------------------------------------------------------------------------

/**
 * 2026-08-25 defektas: `heartbeat_at` amžinai lygdavosi `started_at`, tad `loopRuntimeIsAlive`
 * po 5 min TTL veikiantį ciklą laikydavo sustojusiu. UI atrakindavo „Paleisti", o `startLoop` prie
 * „negyvo" įrašo paleisdavo ANTRĄ orkestratorių ant tos pačios eilės.
 *
 * Įrašas stebimas BĖGIMO metu: `runLoopCycle` pirmiausia kviečia `consumeStopRequest`, tad būtent
 * ten matomas tas pats failas, kurį skaito UI. `true` grąžinimas iškart ir tvarkingai baigia ciklą.
 */
test("runLoopCommand: heartbeat šviežias bėgimo metu, o įrašas atlaisvinamas pabaigoje", async () => {
  const world = await deps();
  const stateDir = path.join(world.root, "vq", "state");
  const recordPath = path.join(stateDir, "ui-loop.runtime.json");
  const STARTED_AT = "2026-08-25T10:00:00.000Z";

  try {
    // Ankstesnio bandymo įrašas TUO PAČIU pid: `started_at` privalo išlikti, heartbeat — atsinaujinti.
    await mkdir(stateDir, { recursive: true });
    await writeFile(
      recordPath,
      JSON.stringify({ pid: process.pid, started_at: STARTED_AT, heartbeat_at: STARTED_AT }),
      "utf8",
    );

    let seen: { pid?: number; started_at?: string; heartbeat_at?: string } | undefined;
    const before = Date.now();

    const code = await runLoopCommand({
      ...world.deps,
      consumeStopRequest: async () => {
        seen = JSON.parse(await readFile(recordPath, "utf8")) as typeof seen;
        return true;
      },
    });
    assert.equal(code, 0, "stop-requested yra tvarkinga pabaiga");

    assert.equal(seen?.pid, process.pid, "įrašas priklauso ŠIAM procesui");
    assert.equal(seen?.started_at, STARTED_AT, "started_at paveldimas, o ne perrašomas");
    assert.notEqual(seen?.heartbeat_at, STARTED_AT, "heartbeat privalo būti atnaujintas");
    assert.ok(
      Date.parse(seen?.heartbeat_at ?? "") >= before,
      `heartbeat turi būti šviežias: ${String(seen?.heartbeat_at)}`,
    );

    // Švariai sustojęs ciklas savo įrašą ištrina — kitaip UI dar TTL laiką rodytų jį gyvą.
    assert.equal(existsSync(recordPath), false, "įrašas privalo būti atlaisvintas");
    assert.equal(existsSync(path.join(stateDir, "ui-loop.pid")), false, "legacy pid failas irgi");
  } finally {
    await rm(world.root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// ensureTaskFileInWorktree (146-a-02): FS↔git lenktynių vartas
// ---------------------------------------------------------------------------

/**
 * Nuosavybės vartai (`verifyOwnership` slot-task-runner.ts viduje) turi eiti PIRM negu vartas
 * čia testuojamas — be laikino, bet realaus `held` lease slot'as niekada nepasiektų
 * `ensureTaskFileInWorktree` iškvietimo.
 */
async function heldLease(root: string, workerId: string, taskId: string): Promise<string> {
  const result = await acquireWorkerLease({
    deps: { fs: schedulingFs },
    projectRoot: root,
    identity: { owner_id: "test-owner", run_id: "test-run", worker_id: workerId, task_id: taskId, attempt: 1 },
  });
  assert.equal(result.status, "acquired");
  return result.status === "acquired" ? result.lease.lease_id : "";
}

test("ensureTaskFileInWorktree: trūkstamas task failas kopijoje atkuriamas iš pirminio medžio", async () => {
  const world = await deps();
  try {
    const relativeFile = "AG/tasks/queue/146-a-02-test.md";
    const absoluteFile = path.join(world.root, relativeFile);
    await mkdir(path.dirname(absoluteFile), { recursive: true });
    await writeFile(absoluteFile, "PIRMINIS TURINYS\n", "utf8");

    const leaseId = await heldLease(world.root, "w-restore", "146-a-02-test");
    const ports = buildLoopCyclePorts(world.deps);
    const slot: WaveDispatchSlot = {
      worker_id: "w-restore",
      task_id: "146-a-02-test",
      file: relativeFile,
      absoluteFile,
      worktree_path: ".ag-worktree-restore",
      lease_id: leaseId,
    };

    // Kopijos dist nėra — `prepareWorktree` toliau nulūš, bet task failo vartai kviečiami PRIEŠ jį,
    // tad atkūrimas jau įvyksta net kai visa slot'o baigtis lieka `task-failed`.
    const outcome = await ports.runSlotTask(slot);
    // 148-c-04: kompozicija baigtį perduoda STRUKTŪRINĘ, ne suplotą į `boolean`.
    assert.equal(outcome.status, "task-failed");

    const worktreeFile = path.join(world.root, ".ag-worktree-restore", relativeFile);
    assert.equal(await readFile(worktreeFile, "utf8"), "PIRMINIS TURINYS\n");
  } finally {
    await rm(world.root, { recursive: true, force: true });
  }
});

test("ensureTaskFileInWorktree: esamos kopijos task failo NELIEČIA", async () => {
  const world = await deps();
  try {
    const relativeFile = "AG/tasks/queue/146-a-02-test.md";
    const absoluteFile = path.join(world.root, relativeFile);
    await mkdir(path.dirname(absoluteFile), { recursive: true });
    await writeFile(absoluteFile, "PIRMINIS TURINYS\n", "utf8");

    const worktreeFile = path.join(world.root, ".ag-worktree-existing", relativeFile);
    await mkdir(path.dirname(worktreeFile), { recursive: true });
    await writeFile(worktreeFile, "JAU KOPIJOJE\n", "utf8");

    const leaseId = await heldLease(world.root, "w-existing", "146-a-02-test");
    const ports = buildLoopCyclePorts(world.deps);
    const slot: WaveDispatchSlot = {
      worker_id: "w-existing",
      task_id: "146-a-02-test",
      file: relativeFile,
      absoluteFile,
      worktree_path: ".ag-worktree-existing",
      lease_id: leaseId,
    };

    await ports.runSlotTask(slot);

    assert.equal(await readFile(worktreeFile, "utf8"), "JAU KOPIJOJE\n");
  } finally {
    await rm(world.root, { recursive: true, force: true });
  }
});
