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
import { leaseClaimOf, type WorkerLease } from "../domain/scheduling/worker-lease-rules.js";
import { readScopeLockRegistry } from "../application/scheduling/scope-lock-store.js";
import { releaseWorkerLease } from "../application/scheduling/worker-lease-store.js";
import type { TaskGraph } from "../domain/tasks/graph/model.js";
import { memorySchedulingFs as memorySchedulingFsHelper } from "./helpers/memory-scheduling-fs.js";

const NOW = new Date("2026-08-21T12:00:00.000Z");
const ROOT = "D:/tmp/vq-wave-provisioning";

function memorySchedulingFs(): { files: Map<string, string>; port: SchedulingFileSystemPort } {
  return memorySchedulingFsHelper(NOW.getTime());
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

// P2 (2026-08-24, operatoriaus radinys): scope lock registrą skaitė pre-write hook'as, bet
// PRODUKCIJOJE jo niekas nepildė — `acquireScopeLocksInStore` turėjo tik testinius kvietėjus, tad
// antras izoliacijos sluoksnis realiame worker cikle neveikė. Šie trys testai pin'ina, kad
// registras dabar pildomas prieš dispatch'ą, kad persidengiantis scope BLOKUOJA, ir kad lease'o
// atlaisvinimas lock'us nuima.
function graphWithScope(scopes: Record<string, string[]>): () => TaskGraph {
  const graph = {
    nodes: Object.entries(scopes).map(([taskId, scope]) => ({ task_id: taskId, scope })),
  } as unknown as TaskGraph;
  return () => graph;
}

test("aprūpinimas UŽPILDO scope lock registrą prieš dispatch'ą", async () => {
  const w = world();
  w.deps.graph = graphWithScope({ "0002": ["src/moduleA"] });

  assert.equal(await createWaveProvisioningCoordinator(w.deps).provisionSlotLease({ task_id: "0002", worker_index: 2 }), true);

  const registry = await readScopeLockRegistry(w.fs, ROOT);
  assert.deepEqual(
    registry.locks.map((lock) => lock.scope),
    ["src/moduleA"],
    "registras nebėra amžinai tuščias — būtent tai ir buvo P2",
  );
  assert.equal(registry.locks[0]?.owner.task_id, "0002", "savininkas yra LEASE tapatybė, ne procesas");
});

test("persidengiantis scope NEGAUNA slot'o, o lease grąžinamas", async () => {
  const w = world();
  w.deps.graph = graphWithScope({ "0002": ["src/moduleA"], "0003": ["src/moduleA/deep"] });
  const coordinator = createWaveProvisioningCoordinator(w.deps);

  assert.equal(await coordinator.provisionSlotLease({ task_id: "0002", worker_index: 2 }), true);
  assert.equal(
    await coordinator.provisionSlotLease({ task_id: "0003", worker_index: 1 }),
    false,
    "antras workeris NEGALI gauti kelio, kurį jau laiko pirmas",
  );

  assert.ok(
    w.logs.some((line) => line.startsWith("SLOT SCOPE LOCK CONFLICT:")),
    "konfliktas įvardijamas, o ne tyliai praleidžiamas",
  );
  // Lease NEGALI likti užimtas dėl scope konflikto — kitaip slot'as kabo iki TTL.
  const leases = await listWorkerLeases(w.fs, ROOT);
  assert.equal(leases.find((lease) => lease.worker_id === "w1")?.status, "released");
});

test("lease'o atlaisvinimas NUIMA jo scope lock'us", async () => {
  const w = world();
  w.deps.graph = graphWithScope({ "0002": ["src/moduleA"] });
  await createWaveProvisioningCoordinator(w.deps).provisionSlotLease({ task_id: "0002", worker_index: 2 });

  const lease = (await listWorkerLeases(w.fs, ROOT)).find((entry) => entry.worker_id === "w2");
  assert.ok(lease);
  await releaseWorkerLease({
    deps: { fs: w.fs, clock: { now: () => NOW, sleep: () => Promise.resolve() } },
    projectRoot: ROOT,
    workerId: "w2",
    claim: leaseClaimOf(lease),
  });

  assert.deepEqual(
    (await readScopeLockRegistry(w.fs, ROOT)).locks,
    [],
    "netekus lease'o krenta ir visi jo lock'ai (ScopeLockOwner taisyklė)",
  );
});

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
  const result = await createWaveProvisioningCoordinator(w.deps).provisionMissingSlotLeases(
    pool({ granted: ["0001"], missingLease: ["0002"] }),
    [candidate("0001", ["src/a.ts"]), candidate("0002", ["src/b.ts"])],
  );

  assert.deepEqual(result.provisioned, []);
  assert.ok(w.logs.some((line) => line.includes("task jau dispatch'intas")));
});

test("write-set konfliktas slot'o NEPRARANDA — jį gauna švarus pakaitalas", async () => {
  const w = world();
  const result = await createWaveProvisioningCoordinator(w.deps).provisionMissingSlotLeases(
    pool({ granted: ["0001"], missingLease: ["0002", "0003"] }),
    [
      candidate("0001", ["src/a.ts"]),
      // 0002 rašo tą patį failą kaip užimtasis 0001 — jam slot'as neduodamas.
      candidate("0002", ["src/a.ts"]),
      candidate("0003", ["src/c.ts"]),
    ],
  );

  assert.deepEqual(
    result.provisioned.map((target) => target.task_id),
    ["0003"],
  );
  assert.ok(w.logs.some((line) => line.includes("write-set-conflict")));
});

// P2 (2026-09-01, W1/w2 slot'ų auditas): pakaitalą turėjo TIK write-set konflikto šaka, o
// `provisionSlotLease` nesėkmė darydavo `continue` — kandidatui specifinė klaida sudegindavo
// vienintelį laisvą indeksą, ir kita banga ta pačia deterministine tvarka vėl imdavo tą patį
// kritusį kandidatą. Šie du testai prikala pakaitalą nesėkmės šakoje ir raundo baigtinumą.
test("aprūpinimo NESĖKMĖ slot'o nepraranda — jį gauna kitas kandidatas tame pačiame raunde", async () => {
  const w = world({
    // Kandidatui SPECIFINĖ nesėkmė: 0002 kopija karantinuota, 0003 sveikas.
    create: (taskId) =>
      taskId === "0002" ? { status: "quarantined", reason: "dirty-tree" } : { status: "created", relativePath: ".worktrees/w2" },
  });
  const result = await createWaveProvisioningCoordinator(w.deps).provisionMissingSlotLeases(
    pool({ granted: ["0001"], missingLease: ["0002", "0003"] }),
    [candidate("0001", ["src/a.ts"]), candidate("0002", ["src/b.ts"]), candidate("0003", ["src/c.ts"])],
  );

  assert.deepEqual(
    result.provisioned,
    [{ task_id: "0003", worker_index: 2 }],
    "laisvas indeksas lieka bangoje, o ne sudega",
  );
  // Operatorius turi matyti GRANDINĘ, ne tik galutinį rezultatą.
  assert.ok(
    w.logs.some((line) => line.includes("SLOT PROVISION RETRY:") && line.includes("task=0002") && line.includes("task=0003")),
    "žurnale matyti, kuris kandidatas krito ir kas bandomas vietoje jo",
  );
  // 116: kritusio kandidato priežastis lieka prieinama kvietėjui — pool eilutė ją įpina prie
  // `missing-lease` įrašo, o ne vien lease store'o statinį tekstą.
  assert.equal(result.lastOutcomeByTask.get("0002"), "dirty-tree");
});

test("visiems kandidatams kritus raundas BAIGIASI — kiekvienas bandomas daugiausia kartą", async () => {
  const w = world({ create: () => ({ status: "quarantined", reason: "dirty-tree" }) });
  const result = await createWaveProvisioningCoordinator(w.deps).provisionMissingSlotLeases(
    pool({ granted: ["0001"], missingLease: ["0002", "0003"] }),
    [candidate("0001", ["src/a.ts"]), candidate("0002", ["src/b.ts"]), candidate("0003", ["src/c.ts"])],
  );

  assert.deepEqual(result.provisioned, []);
  // `claimed` daro aibę baigtinę: be jo pakaitalo ciklas suktųsi amžinai.
  assert.deepEqual(w.created, ["0002", "0003"], "kiekvienas kandidatas bandytas lygiai kartą");
  assert.ok(w.logs.some((line) => line.includes("SLOT PROVISION EXHAUSTED:")), "pabaiga įvardijama, o ne tyli");
});

test("nepavykęs išdavimas į rezultatą NEPATENKA, bet priežastis lieka lastOutcomeByTask", async () => {
  const w = world({ create: () => ({ status: "infrastructure", message: "no git" }) });
  const result = await createWaveProvisioningCoordinator(w.deps).provisionMissingSlotLeases(
    pool({ granted: ["0001"], missingLease: ["0002"] }),
    [candidate("0001", ["src/a.ts"]), candidate("0002", ["src/b.ts"])],
  );

  // Kitaip perplanavimas laukdamas lease'o „matytų" izoliaciją, kurios nėra.
  assert.deepEqual(result.provisioned, []);
  assert.equal(result.lastOutcomeByTask.get("0002"), "no git");
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
