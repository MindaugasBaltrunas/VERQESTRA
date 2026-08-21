// VQ-504 (45/N) testai — bangos slot'ų aprūpinimas.
//
// Prikalama tai, kas tyliausiai lūžta: vartų TVARKA prieš lease'o išdavimą (politika ir
// gitignore tikrinami PRIEŠ lease'ą, kad neliktų kabančio lease'o kopijai, kurios nebus),
// write-set konflikto pakaitalas ir tai, kad aprūpinimas niekada nemeta.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createWaveProvisioningCoordinator,
  type WaveProvisioningDeps,
  type WaveWorktreePort,
  type WorktreeProvisionOutcome,
} from "../application/scheduling/wave-provisioning.js";
import { computeTaskWriteSet } from "../application/scheduling/conflict-detector.js";
import { createWorkerLease, listWorkerLeases, type SchedulingFileSystemPort } from "../application/scheduling/index.js";
import type { WorkerCandidate } from "../application/scheduling/worker-pool-admission.js";
import type { WorkerPoolPlan } from "../application/scheduling/worker-pool-plan.js";
import type { WorkerLease } from "../domain/scheduling/worker-lease-rules.js";

const NOW = new Date("2026-08-21T12:00:00.000Z");
const ROOT = "D:/tmp/vq-wave-provisioning";

function memorySchedulingFs(): { files: Map<string, string>; port: SchedulingFileSystemPort } {
  const files = new Map<string, string>();
  const dirs = new Set<string>();
  const norm = (value: string): string => value.replace(/\\/g, "/");
  const port: SchedulingFileSystemPort = {
    readTextFileIfExists: async (p) => files.get(norm(p)),
    listDirectoryIfExists: async (dir) => {
      const prefix = `${norm(dir)}/`;
      const names = [...files.keys()]
        .filter((key) => key.startsWith(prefix))
        .map((key) => key.slice(prefix.length))
        .filter((name) => !name.includes("/"));
      if (names.length === 0 && !dirs.has(norm(dir))) return undefined;
      return names;
    },
    writeTextFileAtomic: async (p, content) => {
      files.set(norm(p), content);
    },
    makeDirectory: async (dir) => {
      dirs.add(norm(dir));
    },
    exists: async (p) => files.has(norm(p)) || dirs.has(norm(p)) || [...files.keys()].some((key) => key.startsWith(`${norm(p)}/`)),
    createLockDirectory: async (dir) => {
      const key = norm(dir);
      if (dirs.has(key)) return "exists";
      dirs.add(key);
      return "created";
    },
    removeDirectory: async (dir) => {
      dirs.delete(norm(dir));
    },
    directoryModifiedAtMs: async (dir) => (dirs.has(norm(dir)) ? NOW.getTime() : undefined),
  };
  return { files, port };
}

type World = {
  deps: WaveProvisioningDeps;
  logs: string[];
  created: string[];
  fs: SchedulingFileSystemPort;
};

function world(options: {
  policyEnabled?: boolean;
  rootIgnored?: boolean;
  create?: (taskId: string) => WorktreeProvisionOutcome | Promise<WorktreeProvisionOutcome>;
  running?: string[];
  started?: string[];
  fs?: SchedulingFileSystemPort;
} = {}): World {
  const logs: string[] = [];
  const created: string[] = [];
  const fs = options.fs ?? memorySchedulingFs().port;

  const worktree: WaveWorktreePort = {
    policyEnabled: () => Promise.resolve(options.policyEnabled ?? true),
    rootIsIgnored: () => Promise.resolve(options.rootIgnored ?? true),
    create: async ({ identity }) => {
      created.push(identity.task_id);
      return options.create === undefined
        ? { status: "created", relativePath: `.worktrees/${identity.worker_id}` }
        : await options.create(identity.task_id);
    },
  };

  const deps: WaveProvisioningDeps = {
    workspaceRoot: ROOT,
    runId: "r1",
    ownerId: "loop-4242",
    leaseStore: { fs, clock: { now: () => NOW, sleep: () => Promise.resolve() } },
    worktree,
    now: () => NOW.toISOString(),
    log: (message) => {
      logs.push(message);
      return Promise.resolve();
    },
    graph: () => undefined,
    isRunning: (taskId) => (options.running ?? []).includes(taskId),
    hasStarted: (taskId) => (options.started ?? []).includes(taskId),
  };

  return { deps, logs, created, fs };
}

function candidate(taskId: string, paths: string[], lease?: WorkerLease): WorkerCandidate {
  return {
    task_id: taskId,
    file: `AG/tasks/queue/${taskId}.md`,
    write_set: computeTaskWriteSet({ task_id: taskId, allowed_paths: paths }),
    ...(lease === undefined ? {} : { lease }),
  };
}

function pool(input: { granted: string[]; missingLease: string[] }): WorkerPoolPlan {
  return {
    run_id: "r1",
    requested_workers: 2,
    max_workers: 2,
    mode: "parallel",
    slots: input.granted.map((taskId, index) => ({
      worker_index: index + 1,
      worker_id: `w${index + 1}`,
      task_id: taskId,
      attempt: 1,
    })),
    rejected: input.missingLease.map((taskId) => ({ task_id: taskId, reason: "missing-lease", detail: "reikia lease" })),
    verdicts: [],
    conflicts: [],
    plan_hash: "ph",
  } as unknown as WorkerPoolPlan;
}

test("išjungta politika lease'o NEIŠDUODA ir kopijos nekuria", async () => {
  const w = world({ policyEnabled: false });
  const ok = await createWaveProvisioningCoordinator(w.deps).provisionSlotLease({ task_id: "0002", worker_index: 2 });

  assert.equal(ok, false);
  assert.deepEqual(w.created, [], "iki kopijos kūrimo net neprieita");
  assert.equal(await listWorkerLeases(w.fs, ROOT).then((leases) => leases.length), 0, "lease nekabo");
  assert.ok(w.logs[0]?.includes("worktree politika išjungta"));
});

test("neignoruojama worktree šaknis sustabdo PRIEŠ lease'ą", async () => {
  const w = world({ rootIgnored: false });
  const ok = await createWaveProvisioningCoordinator(w.deps).provisionSlotLease({ task_id: "0002", worker_index: 2 });

  assert.equal(ok, false);
  // Vartų tvarka yra kontraktas: lease, išduotas kopijai, kuri nebus sukurta, kabotų visą TTL.
  assert.equal(await listWorkerLeases(w.fs, ROOT).then((leases) => leases.length), 0);
  assert.ok(w.logs[0]?.includes("gitignore"));
});

test("sėkmingas aprūpinimas įrašo kelią į lease TIK po kopijos sukūrimo", async () => {
  const w = world();
  const ok = await createWaveProvisioningCoordinator(w.deps).provisionSlotLease({ task_id: "0002", worker_index: 2 });

  assert.equal(ok, true);
  const leases = await listWorkerLeases(w.fs, ROOT);
  assert.equal(leases.length, 1);
  assert.equal(leases[0]?.task_id, "0002");
  assert.equal(leases[0]?.worktree_path, ".worktrees/w2");
  assert.equal(leases[0]?.owner_id, "loop-4242", "proceso tapatybė ateina iš išorės");
});

test("karantinas ir infrastruktūros klaida žurnale ATSKIRIAMI", async () => {
  const quarantined = world({ create: () => ({ status: "quarantined", reason: "dirty-tree" }) });
  assert.equal(
    await createWaveProvisioningCoordinator(quarantined.deps).provisionSlotLease({ task_id: "0002", worker_index: 2 }),
    false,
  );
  assert.ok(quarantined.logs.some((line) => line.includes("SLOT WORKTREE QUARANTINED")));

  const broken = world({ create: () => ({ status: "infrastructure", message: "not a git repository" }) });
  assert.equal(
    await createWaveProvisioningCoordinator(broken.deps).provisionSlotLease({ task_id: "0002", worker_index: 2 }),
    false,
  );
  assert.ok(broken.logs.some((line) => line.includes("SLOT WORKTREE FAILED")));
});

test("aprūpinimas NIEKADA nemeta — mesta klaida virsta tyliu `ne`", async () => {
  const w = world({
    create: () => {
      throw new Error("git nukrito");
    },
  });
  const ok = await createWaveProvisioningCoordinator(w.deps).provisionSlotLease({ task_id: "0002", worker_index: 2 });

  // Viena nesusikūrusi kopija reiškia vienu slot'u mažiau, o ne kritusią bangą.
  assert.equal(ok, false);
  assert.ok(w.logs.some((line) => line.includes("SLOT PROVISION FAILED: git nukrito")));
});

test("vieno slot'o banga lease store'o net NESKAITO", async () => {
  let reads = 0;
  const memory = memorySchedulingFs();
  const spy: SchedulingFileSystemPort = {
    ...memory.port,
    listDirectoryIfExists: async (dir) => {
      reads += 1;
      return await memory.port.listDirectoryIfExists(dir);
    },
  };
  const w = world({ fs: spy });
  const result = await createWaveProvisioningCoordinator(w.deps).readIsolationInputs(1);

  assert.deepEqual(result.leases, []);
  assert.equal(reads, 0);
});

test("neperskaitomas lease store grąžina tuščią sąrašą, bet NE tyliai", async () => {
  const memory = memorySchedulingFs();
  const broken: SchedulingFileSystemPort = {
    ...memory.port,
    listDirectoryIfExists: () => Promise.reject(new Error("EIO")),
  };
  const w = world({ fs: broken });
  const result = await createWaveProvisioningCoordinator(w.deps).readIsolationInputs(2);

  assert.deepEqual(result.leases, []);
  // Tylus tuščias sąrašas paverstų sutrikimą normalia banga.
  assert.ok(w.logs.some((line) => line.includes("WORKER LEASE STORE UNREADABLE")));
});

test("PASIBAIGĘS lease kandidatui nepriskiriamas", async () => {
  const w = world();
  const expired = createWorkerLease(
    { owner_id: "loop-1", run_id: "r1", worker_id: "w2", task_id: "0002", attempt: 1 },
    { now: new Date(NOW.getTime() - 10 * 60 * 60 * 1000), fencingToken: 1 },
  );
  const [mapped] = createWaveProvisioningCoordinator(w.deps).toWorkerCandidates(
    [{ task_id: "0002", file: "AG/tasks/queue/0002.md", blocked_by: [], depth: 0 }],
    [expired],
  );

  // Pasibaigęs lease yra įrodymo NEBUVIMAS: vartai jį privalo matyti kaip trūkstamą.
  assert.equal(mapped?.lease, undefined);
});

test("jau dispatch'intas task'as lease'o NEGAUNA", async () => {
  const w = world({ running: ["0002"] });
  const provisioned = await createWaveProvisioningCoordinator(w.deps).provisionMissingSlotLeases(
    pool({ granted: ["0001"], missingLease: ["0002"] }),
    [candidate("0001", ["src/a.ts"]), candidate("0002", ["src/b.ts"])],
  );

  assert.deepEqual(provisioned, []);
  assert.ok(w.logs.some((line) => line.includes("task jau dispatch'intas")));
});

test("write-set konfliktas slot'o NEPRARANDA — jį gauna švarus pakaitalas", async () => {
  const w = world();
  const provisioned = await createWaveProvisioningCoordinator(w.deps).provisionMissingSlotLeases(
    pool({ granted: ["0001"], missingLease: ["0002", "0003"] }),
    [
      candidate("0001", ["src/a.ts"]),
      // 0002 rašo tą patį failą kaip užimtasis 0001 — jam slot'as neduodamas.
      candidate("0002", ["src/a.ts"]),
      candidate("0003", ["src/c.ts"]),
    ],
  );

  assert.deepEqual(
    provisioned.map((target) => target.task_id),
    ["0003"],
  );
  assert.ok(w.logs.some((line) => line.includes("write-set-conflict")));
});

test("nepavykęs išdavimas į rezultatą NEPATENKA", async () => {
  const w = world({ create: () => ({ status: "infrastructure", message: "no git" }) });
  const provisioned = await createWaveProvisioningCoordinator(w.deps).provisionMissingSlotLeases(
    pool({ granted: ["0001"], missingLease: ["0002"] }),
    [candidate("0001", ["src/a.ts"]), candidate("0002", ["src/b.ts"])],
  );

  // Kitaip perplanavimas laukdamas lease'o „matytų" izoliaciją, kurios nėra.
  assert.deepEqual(provisioned, []);
});

test("atlaisvinamas TIK to paties task'o held lease", async () => {
  const w = world();
  const provisioning = createWaveProvisioningCoordinator(w.deps);
  await provisioning.provisionSlotLease({ task_id: "0002", worker_index: 2 });

  // Svetimas task'as tame pačiame slot'e: atlaisvinimas nutrauktų svetimą izoliaciją.
  await provisioning.releaseWaveProvisionLease({ task_id: "0009", worker_index: 2 });
  assert.ok(w.logs.some((line) => line.includes("RELEASE SKIPPED")));
  assert.equal((await listWorkerLeases(w.fs, ROOT))[0]?.status, "held");

  await provisioning.releaseWaveProvisionLease({ task_id: "0002", worker_index: 2 });
  assert.ok(w.logs.some((line) => line.includes("WAVE PROVISION LEASE RELEASED")));
  assert.equal((await listWorkerLeases(w.fs, ROOT))[0]?.status, "released");
});
