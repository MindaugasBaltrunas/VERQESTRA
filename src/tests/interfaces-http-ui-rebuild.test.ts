// Task 058-3 testai — `POST /api/ui/rebuild`. Svarbiausia, ką jie pin'ina: fiksuota komanda, VIENAS
// vienalaikis build'as (antras paspaudimas gauna `already-running`, ne antrą spawn'ą), gedimas
// virsta `failed`, ne išimtimi, o būsenos užklausa po nesėkmingo vaiko grąžina `failed` SU
// išvesties uodega. Router pusėje: portas OPTIONAL — kol composition jo neriša, maršrutas atsako
// `disabled`, o ne 500.

import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import {
  UI_REBUILD_ARGS,
  UI_REBUILD_COMMAND,
  UI_REBUILD_OUTPUT_TAIL_MAX_CHARS,
  ensureUiRebuildRunning,
  resetUiRebuildStateForTests,
  uiRebuildStatus,
  type UiRebuildDeps,
  type UiRebuildExit,
  type UiRebuildProcess,
  type UiRebuildProcessPorts,
} from "../interfaces/http/ui-rebuild.js";
import { uiRebuildRecordFile } from "../interfaces/http/ui-port-store.js";
import { handlePost } from "../interfaces/http/ui-router-mutations.js";
import type { UiRouteRequest, UiRouterDeps, UiRouterPorts } from "../interfaces/http/ui-router-model.js";

const ROOT = path.resolve("/repo");
const RUNTIME = path.join(ROOT, "vq");
const STATE = path.join(RUNTIME, "state");
const NOW = new Date("2026-08-28T12:00:00.000Z");

type World = {
  ports: UiRebuildProcessPorts;
  store: Map<string, string>;
  alivePids: Set<number>;
  spawned: number;
  spawnFails: boolean;
  spawnPid: number | undefined;
  exitCallbacks: Array<(exit: UiRebuildExit) => void | Promise<void>>;
};

function world(files: Record<string, string> = {}): World {
  const store = new Map(Object.entries(files));
  const w: World = {
    store,
    alivePids: new Set<number>(),
    spawned: 0,
    spawnFails: false,
    spawnPid: 4242,
    exitCallbacks: [],
    ports: undefined as unknown as UiRebuildProcessPorts,
  };

  const fs = {
    readTextFileIfExists: (p: string): Promise<string | undefined> => Promise.resolve(store.get(p)),
    writeTextFileAtomic: (p: string, content: string): Promise<void> => {
      store.set(p, content);
      return Promise.resolve();
    },
    makeDirectory: (): Promise<void> => Promise.resolve(),
  };

  w.ports = {
    fs,
    spawnUiRebuild: (): Promise<UiRebuildProcess> => {
      if (w.spawnFails) return Promise.reject(new Error("spawn nepavyko"));
      w.spawned += 1;
      const pid = w.spawnPid;
      if (pid !== undefined) w.alivePids.add(pid);
      const child: UiRebuildProcess = {
        pid,
        isRunning: () => (pid === undefined ? false : w.alivePids.has(pid)),
        detach: () => {},
        onExit: (callback) => w.exitCallbacks.push(callback),
      };
      return Promise.resolve(child);
    },
    processIsAlive: (pid) => w.alivePids.has(pid),
    now: () => NOW,
  };

  return w;
}

const deps = (w: World): UiRebuildDeps => ({ ports: w.ports, runtimeRoot: RUNTIME });

async function finishBuild(w: World, exit: UiRebuildExit): Promise<void> {
  const pid = w.spawnPid;
  if (pid !== undefined) w.alivePids.delete(pid);
  await Promise.all(w.exitCallbacks.map((callback) => Promise.resolve(callback(exit))));
}

test("UI_REBUILD_COMMAND/UI_REBUILD_ARGS: fiksuota komanda — joks kliento laukas jos nekeičia", () => {
  assert.equal(UI_REBUILD_COMMAND, "pnpm");
  assert.deepEqual(UI_REBUILD_ARGS, ["--dir", "ui-app", "build"]);
});

test("ensureUiRebuildRunning: laisva būsena paleidžia rebuild'ą ir įrašo `running`", async () => {
  resetUiRebuildStateForTests();
  const w = world();

  const result = await ensureUiRebuildRunning(deps(w));
  assert.deepEqual(result, { status: "started", pid: 4242 });
  assert.equal(w.spawned, 1);
  assert.match(w.store.get(uiRebuildRecordFile(STATE)) ?? "", /"status": "running"/);
});

test("ensureUiRebuildRunning: gyvas rebuild'as neleidžia antro spawn'o", async () => {
  resetUiRebuildStateForTests();
  const w = world();
  await ensureUiRebuildRunning(deps(w));

  const second = await ensureUiRebuildRunning(deps(w));
  assert.deepEqual(second, { status: "already-running", pid: 4242 });
  assert.equal(w.spawned, 1, "antras spawn'as neįvyko");
});

test("ensureUiRebuildRunning: pasenęs `running` įrašas (miręs PID) nestabdo naujo starto", async () => {
  resetUiRebuildStateForTests();
  const w = world({
    [uiRebuildRecordFile(STATE)]: JSON.stringify({
      schema_version: 1,
      pid: 999,
      status: "running",
      started_at: NOW.toISOString(),
    }),
  });

  const result = await ensureUiRebuildRunning(deps(w));
  assert.deepEqual(result, { status: "started", pid: 4242 });
  assert.equal(w.spawned, 1);
});

test("ensureUiRebuildRunning: paleidimo gedimas virsta `failed`, ne išimtimi", async () => {
  resetUiRebuildStateForTests();
  const failing = world();
  failing.spawnFails = true;
  const failed = await ensureUiRebuildRunning(deps(failing));
  assert.equal(failed.status, "failed");

  resetUiRebuildStateForTests();
  const noPid = world();
  noPid.spawnPid = undefined;
  const withoutPid = await ensureUiRebuildRunning(deps(noPid));
  assert.deepEqual(withoutPid, { status: "failed", reason: "ui rebuild process started without a PID" });
});

test("uiRebuildStatus: įrašo nėra → `ok` (rebuild dar nepaleistas nėra klaida)", async () => {
  const w = world();
  assert.deepEqual(await uiRebuildStatus(deps(w)), { status: "ok" });
});

test("uiRebuildStatus: gyvas vaikas → `running`", async () => {
  resetUiRebuildStateForTests();
  const w = world();
  await ensureUiRebuildRunning(deps(w));
  assert.deepEqual(await uiRebuildStatus(deps(w)), { status: "running", pid: 4242 });
});

test("uiRebuildStatus: sėkmingas išėjimas → `ok`", async () => {
  resetUiRebuildStateForTests();
  const w = world();
  await ensureUiRebuildRunning(deps(w));
  await finishBuild(w, { code: 0, tail: "build ok" });

  assert.deepEqual(await uiRebuildStatus(deps(w)), { status: "ok" });
});

test("uiRebuildStatus: nesėkmingas išėjimas → `failed` SU išvesties uodega", async () => {
  resetUiRebuildStateForTests();
  const w = world();
  await ensureUiRebuildRunning(deps(w));
  await finishBuild(w, { code: 1, tail: "TypeError: kažkas sudužo" });

  assert.deepEqual(await uiRebuildStatus(deps(w)), { status: "failed", tail: "TypeError: kažkas sudužo" });
});

test("uiRebuildStatus: ilga uodega apkarpoma iki paskutinių N simbolių", async () => {
  resetUiRebuildStateForTests();
  const w = world();
  await ensureUiRebuildRunning(deps(w));
  const longTail = "x".repeat(UI_REBUILD_OUTPUT_TAIL_MAX_CHARS + 500) + "PASKUTINIS";
  await finishBuild(w, { code: 1, tail: longTail });

  const status = await uiRebuildStatus(deps(w));
  assert.equal(status.status, "failed");
  const tail = status.status === "failed" ? status.tail : "";
  assert.equal(tail.length, UI_REBUILD_OUTPUT_TAIL_MAX_CHARS);
  assert.ok(tail.endsWith("PASKUTINIS"));
});

test("uiRebuildStatus: `running` įrašas su mirusiu PID (vaikas nužudytas be pranešimo) → `failed`", async () => {
  resetUiRebuildStateForTests();
  const w = world();
  await ensureUiRebuildRunning(deps(w));
  // Vaikas dingsta NEPRANEŠDAMAS išėjimo (pvz. `kill -9`) — `onExit` niekada nekviečiamas.
  w.alivePids.delete(4242);

  assert.deepEqual(await uiRebuildStatus(deps(w)), { status: "failed", tail: "" });
});

// ---------------------------------------------------------------------------
// router: POST /api/ui/rebuild
// ---------------------------------------------------------------------------

function baseRouterPorts(overrides: Partial<UiRouterPorts> = {}): UiRouterPorts {
  const fail = (name: string) => () => Promise.reject(new Error(`unexpected call: ${name}`));
  return {
    dashboardData: fail("dashboardData"),
    listPolicyProposals: fail("listPolicyProposals"),
    proposePolicyChange: fail("proposePolicyChange"),
    decidePolicyProposal: fail("decidePolicyProposal"),
    tokenUsage: fail("tokenUsage"),
    logs: fail("logs"),
    tokenAnalytics: fail("tokenAnalytics"),
    reliabilityAnalytics: fail("reliabilityAnalytics"),
    benchmarkReport: fail("benchmarkReport"),
    compressionView: fail("compressionView"),
    setCompressionFeature: fail("setCompressionFeature"),
    workflowBuckets: fail("workflowBuckets"),
    workflowBucketTasks: fail("workflowBucketTasks"),
    wavesView: fail("wavesView"),
    decideLearningRecommendation: fail("decideLearningRecommendation"),
    openTaskBucketFolder: fail("openTaskBucketFolder"),
    uploadQueueFiles: fail("uploadQueueFiles"),
    ensureLoopRunning: fail("ensureLoopRunning"),
    requestLoopStop: fail("requestLoopStop"),
    drainAllSlots: fail("drainAllSlots"),
    resetLoopControl: fail("resetLoopControl"),
    setRequestedWorkers: fail("setRequestedWorkers"),
    setSlotMode: fail("setSlotMode"),
    applyTaskTriage: fail("applyTaskTriage"),
    hasStaticAssets: () => true,
    logError: () => {},
    ...overrides,
  };
}

function routerDeps(ports: UiRouterPorts): UiRouterDeps {
  return {
    ports,
    projectRoot: ROOT,
    uiToken: "token",
    eventLimitFromQuery: () => 50,
  };
}

function postRequest(): UiRouteRequest {
  return {
    method: "POST",
    url: "/api/ui/rebuild",
    headers: {},
    readJsonBody: () => Promise.reject(new Error("kūnas neturi būti skaitomas")),
    readRawBody: () => Promise.reject(new Error("kūnas neturi būti skaitomas")),
  };
}

test("POST /api/ui/rebuild: portas nesurištas (composition dar nesujungta) → `disabled`", async () => {
  const ports = baseRouterPorts();
  const response = await handlePost(routerDeps(ports), "/api/ui/rebuild", postRequest());
  assert.deepEqual(response, { kind: "json", status: 200, data: { status: "disabled" } });
});

test("POST /api/ui/rebuild: kūno NESKAITO ir persiunčia porto rezultatą", async () => {
  const ports = baseRouterPorts({ uiRebuild: { start: () => Promise.resolve({ status: "started", pid: 4242 }) } });
  const response = await handlePost(routerDeps(ports), "/api/ui/rebuild", postRequest());
  assert.deepEqual(response, { kind: "json", status: 200, data: { status: "started", pid: 4242 } });
});

test("POST /api/ui/rebuild: porto klaida virsta 500, ne neperimta išimtimi", async () => {
  const errors: string[] = [];
  const ports = baseRouterPorts({
    uiRebuild: { start: () => Promise.reject(new Error("boom")) },
    logError: (message) => errors.push(message),
  });
  const response = await handlePost(routerDeps(ports), "/api/ui/rebuild", postRequest());
  assert.deepEqual(response, { kind: "text", status: 500, text: "Internal server error" });
  assert.equal(errors.length, 1);
});
