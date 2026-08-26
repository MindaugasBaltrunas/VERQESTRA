// VQ-503 (4/5-c) testai — loop ir UI proceso gyvavimo ciklas plius bucket'ų vaizdas. Svarbiausia,
// ką jie pin'ina: gyvumą sprendžia TIK runtime įrašas (PID + šviežias heartbeat), „Start" po „Stop"
// išvalo ABI stabdymo būsenas, „stop" be gyvo proceso nesiskelbia sėkme, o starto malonės langas
// neleidžia paleisti antro to paties projekto UI.

import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import {
  clearStaleLoopStopState,
  consumeLoopStopRequest,
  ensureLoopRunning,
  loopPidFile,
  loopStopFile,
  requestLoopStop,
  type LoopLifecycleDeps,
} from "../interfaces/http/loop-lifecycle.js";
import {
  UI_AUTOSTART_ENV,
  UI_STARTUP_GRACE_MS,
  ensureUiRunning,
  resetUiLifecycleStateForTests,
  uiPidFile,
  type UiLifecycleDeps,
} from "../interfaces/http/ui-lifecycle.js";
import type { ProcessLifecyclePorts, SpawnedProcess } from "../interfaces/http/process-lifecycle-ports.js";
import { loopRuntimeRecordPath } from "../interfaces/hooks/loop-runtime-store.js";
import { UI_SERVER_RECORD_SCHEMA_VERSION, uiServerRecordFile } from "../interfaces/http/ui-port-store.js";
import type { UiPortPorts } from "../interfaces/http/ui-port-store.js";
import { projectFingerprint, uiUrl, type UiPortProbeResult } from "../interfaces/http/ui-port-rules.js";
import {
  UnknownTaskBucketError,
  VISIBLE_TASK_LIMIT,
  loadWorkflowBucketTasks,
  loadWorkflowBuckets,
  openTaskBucketFolder,
  resolveTaskBucketDir,
  type WorkflowBucketPorts,
} from "../interfaces/http/workflow-buckets.js";
import { loopControlFile } from "../application/scheduling/loop-control-store.js";

const ROOT = path.resolve("/repo");
const RUNTIME = path.join(ROOT, "vq");
const STATE = path.join(RUNTIME, "state");
const AG_ROOT = path.join(ROOT, "AG");
const NOW = new Date("2026-08-21T12:00:00.000Z");
const FINGERPRINT = projectFingerprint(ROOT, "linux");

type LifecycleWorld = {
  ports: ProcessLifecyclePorts;
  portPorts: UiPortPorts;
  store: Map<string, string>;
  alivePids: Set<number>;
  env: Map<string, string>;
  spawned: string[];
  spawnFails: boolean;
  spawnPid: number | undefined;
  probes: Map<number, UiPortProbeResult>;
  out: string[];
};

function lifecycleWorld(files: Record<string, string> = {}): LifecycleWorld {
  const store = new Map(Object.entries(files));
  const out: string[] = [];
  const world: LifecycleWorld = {
    store,
    out,
    alivePids: new Set<number>(),
    env: new Map<string, string>(),
    spawned: [],
    spawnFails: false,
    spawnPid: 4242,
    probes: new Map<number, UiPortProbeResult>(),
    ports: undefined as unknown as ProcessLifecyclePorts,
    portPorts: undefined as unknown as UiPortPorts,
  };

  const child = (): SpawnedProcess => {
    if (world.spawnFails) throw new Error("spawn nepavyko");
    const pid = world.spawnPid;
    if (pid !== undefined) world.alivePids.add(pid);
    return { pid, isRunning: () => (pid === undefined ? false : world.alivePids.has(pid)), detach: () => {} };
  };

  const fs = {
    readTextFileIfExists: (p: string): Promise<string | undefined> => Promise.resolve(store.get(p)),
    writeTextFile: (p: string, content: string): Promise<void> => {
      store.set(p, content);
      return Promise.resolve();
    },
    writeTextFileAtomic: (p: string, content: string): Promise<void> => {
      store.set(p, content);
      return Promise.resolve();
    },
    makeDirectory: (): Promise<void> => Promise.resolve(),
    removeFileIfExists: (p: string): Promise<boolean> => Promise.resolve(store.delete(p)),
  };

  world.ports = {
    fs,
    runtime: {
      fs: {
        exists: (p) => Promise.resolve(store.has(p)),
        readTextFileIfExists: (p) => Promise.resolve(store.get(p)),
        writeTextFile: (p, content) => {
          store.set(p, content);
          return Promise.resolve();
        },
        makeDirectory: () => Promise.resolve(),
        fileMtimeMs: (p) => Promise.resolve(store.has(p) ? NOW.getTime() : undefined),
        removeIfExists: (p) => {
          store.delete(p);
          return Promise.resolve();
        },
      },
      processIsAlive: (pid) => world.alivePids.has(pid),
      now: () => NOW,
    },
    spawnLoop: () => {
      world.spawned.push("loop");
      return Promise.resolve(child());
    },
    spawnUi: (port) => {
      world.spawned.push(`ui:${port}`);
      return Promise.resolve(child());
    },
    processIsAlive: (pid) => world.alivePids.has(pid),
    env: (name) => world.env.get(name),
    now: () => NOW,
    io: { out: (line) => out.push(line), error: (line) => out.push(line) },
  };

  world.portPorts = {
    fs: {
      readTextFileIfExists: (p) => Promise.resolve(store.get(p)),
      writeTextFileAtomic: (p, content) => {
        store.set(p, content);
        return Promise.resolve();
      },
      makeDirectory: () => Promise.resolve(),
    },
    env: (name) => world.env.get(name),
    probe: (port) => Promise.resolve(world.probes.get(port) ?? { state: "free" }),
    now: () => NOW,
    platform: "linux",
  };

  return world;
}

const loopDeps = (world: LifecycleWorld): LoopLifecycleDeps => ({ ports: world.ports, runtimeRoot: RUNTIME });

const uiDeps = (world: LifecycleWorld): UiLifecycleDeps => ({
  ports: world.ports,
  portPorts: world.portPorts,
  projectRoot: ROOT,
  runtimeRoot: RUNTIME,
});

function runtimeRecord(pid: number, heartbeat: Date = NOW): string {
  return JSON.stringify({ pid, started_at: heartbeat.toISOString(), heartbeat_at: heartbeat.toISOString() });
}

// ---------------------------------------------------------------------------
// loop
// ---------------------------------------------------------------------------

test("ensureLoopRunning: gyvas įrašas neleidžia antro loop'o IR išvalo stabdymo būsenas", async () => {
  const world = lifecycleWorld({
    [loopRuntimeRecordPath(loopPidFile(STATE))]: runtimeRecord(777),
    [loopStopFile(STATE)]: "2026-08-21T11:00:00.000Z\n",
  });
  world.alivePids.add(777);

  const result = await ensureLoopRunning(loopDeps(world));
  assert.deepEqual(result, { status: "already-running", pid: 777 });
  assert.deepEqual(world.spawned, [], "antras orkestratorius nepaleidžiamas");
  // „Start" po „Stop": be vėliavos valymo loop'as vis tiek sustotų, o UI rodytų „jau veikia".
  assert.equal(world.store.has(loopStopFile(STATE)), false);
  assert.match(world.store.get(loopControlFile(STATE)) ?? "", /"mode": "run"/);
});

test("ensureLoopRunning: pasenęs įrašas (miręs PID) nestabdo naujo starto", async () => {
  const world = lifecycleWorld({ [loopRuntimeRecordPath(loopPidFile(STATE))]: runtimeRecord(999) });
  // PID nebegyvas — heartbeat šviežumas vienas nieko neįrodo.
  const result = await ensureLoopRunning(loopDeps(world));

  assert.deepEqual(result, { status: "started", pid: 4242 });
  assert.deepEqual(world.spawned, ["loop"]);
  assert.match(world.store.get(loopRuntimeRecordPath(loopPidFile(STATE))) ?? "", /"pid": 4242/);
});

test("ensureLoopRunning: ŠVIEŽIAS startas išvalo lipnų `drain` PRIEŠ spawn'ą", async () => {
  // 2026-08-26 defektas: `clearStaleLoopStopState` buvo kviečiama TIK `already-running` šakoje,
  // t. y. kai naujas ciklas net nepaleidžiamas. O `drain` lieka diske po kiekvieno „Stop", tad jį
  // pamato būtent šviežias startas: UI grąžindavo `started`, vaikas pakildavo ir mirdavo per
  // sekundę ties „no slot dispatched". Operatoriui mygtukas atrodė neveikiantis.
  const world = lifecycleWorld({
    [loopControlFile(STATE)]: JSON.stringify({
      schema_version: 1,
      updated_at: "2026-08-25T21:02:11.663Z",
      slots: { w1: { mode: "drain", requested_at: "2026-08-25T21:02:11.662Z" } },
    }),
    [loopStopFile(STATE)]: "2026-08-25T21:02:11.663Z\n",
  });

  const result = await ensureLoopRunning(loopDeps(world));
  assert.deepEqual(result, { status: "started", pid: 4242 });
  assert.deepEqual(world.spawned, ["loop"], "vaikas paleistas");

  assert.equal(world.store.has(loopStopFile(STATE)), false, "stop vėliava suvartota");
  assert.match(
    world.store.get(loopControlFile(STATE)) ?? "",
    /"mode": "run"/,
    "lipnus drain privalo būti atstatytas, kitaip vaikas mirs prieš pirmą dispatch'ą",
  );
});

test("ensureLoopRunning: paleidimo gedimas virsta `failed`, ne išimtimi", async () => {
  const failing = lifecycleWorld();
  failing.spawnFails = true;
  const failed = await ensureLoopRunning(loopDeps(failing));
  assert.equal(failed.status, "failed");

  const noPid = lifecycleWorld();
  noPid.spawnPid = undefined;
  const withoutPid = await ensureLoopRunning(loopDeps(noPid));
  assert.deepEqual(withoutPid, { status: "failed", reason: "loop process started without a PID" });
});

test("requestLoopStop: vėliava rašoma visada, bet sėkmė skelbiama tik su gyvu procesu", async () => {
  const unknown = lifecycleWorld();
  const withoutProcess = await requestLoopStop(loopDeps(unknown));
  assert.deepEqual(withoutProcess, { status: "stop-requested-no-known-process" });
  // Loop'as gali būti paleistas kitoje sesijoje — vėliava vis tiek turi gulėti diske.
  assert.equal(unknown.store.has(loopStopFile(STATE)), true);

  const live = lifecycleWorld({ [loopRuntimeRecordPath(loopPidFile(STATE))]: runtimeRecord(555) });
  live.alivePids.add(555);
  assert.deepEqual(await requestLoopStop(loopDeps(live)), { status: "stop-requested", pid: 555 });
});

test("consumeLoopStopRequest: vėliava suvartojama vieną kartą", async () => {
  const world = lifecycleWorld({ [loopStopFile(STATE)]: "x" });
  assert.equal(await consumeLoopStopRequest(loopDeps(world)), true);
  assert.equal(await consumeLoopStopRequest(loopDeps(world)), false);
});

test("clearStaleLoopStopState: išvalo IR vėliavą, IR lipnų slot'ų valdiklį", async () => {
  const world = lifecycleWorld({
    [loopStopFile(STATE)]: "x",
    [loopControlFile(STATE)]: JSON.stringify({
      schema_version: 1,
      updated_at: NOW.toISOString(),
      slots: { w1: { mode: "drain" }, w2: { mode: "abort" } },
    }),
  });

  await clearStaleLoopStopState(loopDeps(world));
  assert.equal(world.store.has(loopStopFile(STATE)), false);
  // Valdiklis lipnus: be atstatymo ką tik paleistas loop'as pamatytų `drain` ir iškart baigtųsi.
  const control = JSON.parse(world.store.get(loopControlFile(STATE)) ?? "null") as {
    slots: Record<string, { mode: string }>;
  };
  assert.deepEqual([control.slots["w1"]?.mode, control.slots["w2"]?.mode], ["run", "run"]);
});

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

test("ensureUiRunning: autostart išjungtas duoda `disabled`", async () => {
  resetUiLifecycleStateForTests();
  const world = lifecycleWorld();
  world.env.set(UI_AUTOSTART_ENV, "0");

  assert.deepEqual(await ensureUiRunning(uiDeps(world)), { status: "disabled" });
  assert.deepEqual(world.spawned, []);
});

test("ensureUiRunning: laisvas portas paleidžia serverį ir įrašo abu įrašus", async () => {
  resetUiLifecycleStateForTests();
  const world = lifecycleWorld();

  const result = await ensureUiRunning(uiDeps(world));
  assert.equal(result.status, "started");
  assert.equal(world.spawned.length, 1);
  assert.equal(world.store.get(uiPidFile(STATE)), "4242\n");
  // Įrašas rašomas NELAUKIANT vaiko: jei jis nepakiltų, diske negali likti įrašo į portą, kurio
  // niekas neklauso — tik su REALIU portu jį perrašo pakilęs serveris.
  assert.match(world.store.get(uiServerRecordFile(STATE)) ?? "", /"project_fingerprint": "/);
});

test("ensureUiRunning: starto malonės langas neleidžia antro to paties projekto UI", async () => {
  resetUiLifecycleStateForTests();
  const booting = (updatedAt: Date): string =>
    JSON.stringify({
      schema_version: UI_SERVER_RECORD_SCHEMA_VERSION,
      port: 4300,
      url: uiUrl(4300),
      project_fingerprint: FINGERPRINT,
      pid: 555,
      updated_at: updatedAt.toISOString(),
    });

  const fresh = lifecycleWorld({ [uiServerRecordFile(STATE)]: booting(NOW) });
  fresh.alivePids.add(555);
  assert.deepEqual(await ensureUiRunning(uiDeps(fresh)), { status: "already-running", pid: 555, port: 4300 });
  assert.deepEqual(fresh.spawned, [], "kylantis vaikas nedubliuojamas");

  // Pasibaigus malonės langui gyvumą vėl sprendžia tik zondas.
  resetUiLifecycleStateForTests();
  const stale = lifecycleWorld({
    [uiServerRecordFile(STATE)]: booting(new Date(NOW.getTime() - UI_STARTUP_GRACE_MS - 1)),
  });
  stale.alivePids.add(555);
  const started = await ensureUiRunning(uiDeps(stale));
  assert.equal(started.status, "started");
});

test("ensureUiRunning: neišsprendus porto grąžinamas `failed` ir tai PRANEŠAMA", async () => {
  resetUiLifecycleStateForTests();
  const world = lifecycleWorld();
  world.env.set("AG_UI_PORT", "nope");

  const result = await ensureUiRunning(uiDeps(world));
  assert.equal(result.status, "failed");
  assert.deepEqual(world.spawned, []);
  // Fail-fast, kurio niekas nemato, nėra fail-fast.
  assert.match(world.out.join("\n"), /cannot start/);
});

// ---------------------------------------------------------------------------
// bucket'ai
// ---------------------------------------------------------------------------

function bucketPorts(files: Record<string, string[]> = {}): { ports: WorkflowBucketPorts; opened: string[] } {
  const opened: string[] = [];
  return {
    opened,
    ports: {
      listTaskFiles: (dir) => Promise.resolve(files[dir] ?? []),
      openFolder: (dir) => {
        opened.push(dir);
        return Promise.resolve(true);
      },
    },
  };
}

test("resolveTaskBucketDir: nežinomas vardas NIEKADA netampa keliu", () => {
  assert.equal(resolveTaskBucketDir(AG_ROOT, "queue"), path.join(AG_ROOT, "tasks", "queue"));
  assert.equal(resolveTaskBucketDir(AG_ROOT, "../../etc"), undefined);
  assert.equal(resolveTaskBucketDir(AG_ROOT, ""), undefined);
});

test("loadWorkflowBuckets: kortelėje rodomos naujausios, bet kiekis — pilnas", async () => {
  const queue = Array.from({ length: VISIBLE_TASK_LIMIT + 5 }, (_unused, index) => `${index}.md`);
  const world = bucketPorts({ [path.join(AG_ROOT, "tasks", "queue")]: queue });

  const views = await loadWorkflowBuckets(world.ports, AG_ROOT);
  const queueView = views.find((view) => view.name === "queue");
  assert.equal(queueView?.totalCount, VISIBLE_TASK_LIMIT + 5);
  assert.equal(queueView?.tasks.length, VISIBLE_TASK_LIMIT);
  assert.equal(queueView?.tasks.at(-1), `${VISIBLE_TASK_LIMIT + 4}.md`);
  assert.equal(views.length, 7);
});

test("loadWorkflowBucketTasks ir openTaskBucketFolder: nežinomas bucket'as nėra tuščias sąrašas", async () => {
  const world = bucketPorts({ [path.join(AG_ROOT, "tasks", "done")]: ["0001.md"] });

  assert.deepEqual(await loadWorkflowBucketTasks(world.ports, AG_ROOT, "done"), {
    name: "done",
    tasks: ["0001.md"],
    totalCount: 1,
  });
  await assert.rejects(() => loadWorkflowBucketTasks(world.ports, AG_ROOT, "nope"), UnknownTaskBucketError);

  assert.equal(await openTaskBucketFolder(world.ports, AG_ROOT, "done"), true);
  assert.deepEqual(world.opened, [path.join(AG_ROOT, "tasks", "done")]);
  // Laisvos formos vardas niekada nepaduodamas OS.
  assert.equal(await openTaskBucketFolder(world.ports, AG_ROOT, "../secrets"), false);
  assert.equal(world.opened.length, 1);
});
