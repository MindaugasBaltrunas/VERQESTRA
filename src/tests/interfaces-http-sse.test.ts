// VQ-503 (5/5-b) testai — SSE srautas. Svarbiausia, ką jie pin'ina: naujas klientas gauna ŠVIEŽIĄ
// būseną iš karto (ne kešuotą valandos senumo), praėjimai NEPERSIDENGIA, transliuojama tik
// pasikeitus stebimam failui, keepalive teka net kai nieko nevyksta, o paskutiniam klientui
// išėjus taimeriai sustabdomi.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SSE_KEEPALIVE_INTERVAL_MS,
  SSE_POLL_INTERVAL_MS,
  createSseHub,
  type SseActiveAttempt,
  type SseClient,
  type SseLiveSlotSource,
  type SsePorts,
} from "../interfaces/http/sse-service.js";
import type { AgentActivity } from "../interfaces/ui-model/agent-activity.js";

const NOW = "2026-08-21T12:00:00.000Z";

function activity(over: Partial<AgentActivity> = {}): AgentActivity {
  return {
    chain: ["architect"],
    statuses: { architect: "active" },
    currentAgent: "architect",
    currentActivity: "Read: a.ts",
    taskId: "890",
    claudeStatus: "started",
    mode: "inline",
    updatedAt: NOW,
    ...over,
  };
}

type SseWorld = {
  ports: SsePorts;
  mtimes: Map<string, number>;
  slots: SseLiveSlotSource[];
  attempt?: SseActiveAttempt;
  timers: { handler: () => void; ms: number; cleared: boolean }[];
  globalReads: number;
  slotReads: string[];
  /** Leidžia sulaikyti globalų skaitymą — persidengiančių praėjimų testui. */
  gate?: { promise: Promise<void>; release: () => void };
};

function sseWorld(): SseWorld {
  const world: SseWorld = {
    mtimes: new Map<string, number>(),
    slots: [],
    timers: [],
    globalReads: 0,
    slotReads: [],
    ports: undefined as unknown as SsePorts,
  };

  world.ports = {
    fileMtimeMs: (file) => Promise.resolve(world.mtimes.get(file) ?? 0),
    readGlobalActivity: async () => {
      world.globalReads += 1;
      if (world.gate) await world.gate.promise;
      return activity();
    },
    readSlotActivity: (source) => {
      world.slotReads.push(source.worker_id);
      return Promise.resolve(activity({ taskId: source.task_id }));
    },
    readLiveSlotSources: () => Promise.resolve(world.slots),
    readActiveAttempt: () => Promise.resolve(world.attempt),
    legacyWatchFiles: () => ["/vq/logs/claude-last.log", "/vq/state/wave-snapshot.json"],
    setInterval: (handler, ms) => {
      const timer = { handler, ms, cleared: false };
      world.timers.push(timer);
      return { clear: () => void (timer.cleared = true) };
    },
  };
  return world;
}

function fakeClient(): { client: SseClient; written: string[]; close(): void; fail?: boolean } {
  const written: string[] = [];
  const listeners: Record<string, (() => void)[]> = { close: [], error: [] };
  const handle = {
    written,
    client: {
      write: (chunk: string) => {
        if (handle.fail) throw new Error("socket sunaikintas");
        written.push(chunk);
      },
      on: (event: "close" | "error", listener: () => void) => {
        listeners[event]?.push(listener);
      },
    },
    fail: false,
    close: () => listeners["close"]?.forEach((listener) => listener()),
  };
  return handle;
}

test("addClient: naujas klientas gauna ŠVIEŽIĄ būseną iš karto", async () => {
  const world = sseWorld();
  const hub = createSseHub(world.ports);
  const first = fakeClient();

  await hub.addClient(first.client);
  assert.equal(first.written.length, 1);
  const payload = JSON.parse(first.written[0]?.replace(/^data: /, "") ?? "null") as Record<string, unknown>;
  assert.equal(payload["mode"], "inline");
  // Be bandymo kopijos rodomas globalus veidrodis.
  assert.equal(payload["stopStatusSource"], "legacy");
  assert.equal(payload["slots"], undefined, "tuščias slot'ų masyvas nieko nepasakytų");
});

test("addClient: taimeriai paleidžiami vieną kartą ir sustabdomi paskutiniam klientui išėjus", async () => {
  const world = sseWorld();
  const hub = createSseHub(world.ports);
  const first = fakeClient();
  const second = fakeClient();

  await hub.addClient(first.client);
  await hub.addClient(second.client);
  assert.deepEqual(
    world.timers.map((timer) => timer.ms),
    [SSE_POLL_INTERVAL_MS, SSE_KEEPALIVE_INTERVAL_MS],
  );

  first.close();
  assert.equal(hub.clientCount(), 1);
  assert.deepEqual(world.timers.map((timer) => timer.cleared), [false, false]);

  second.close();
  assert.equal(hub.clientCount(), 0);
  assert.deepEqual(world.timers.map((timer) => timer.cleared), [true, true]);
});

test("checkAndBroadcast: transliuoja TIK pasikeitus stebimam failui", async () => {
  const world = sseWorld();
  const hub = createSseHub(world.ports);
  const client = fakeClient();
  await hub.addClient(client.client);
  const afterHello = client.written.length;

  await hub.checkAndBroadcast();
  assert.equal(client.written.length, afterHello, "pirmas praėjimas užfiksuoja žymes");

  world.mtimes.set("/vq/logs/claude-last.log", 111);
  await hub.checkAndBroadcast();
  assert.equal(client.written.length, afterHello + 1);

  // Nepasikeitus — tyla; kitaip 1,5 s intervalas spamintų nepakitusią būseną.
  await hub.checkAndBroadcast();
  assert.equal(client.written.length, afterHello + 1);
});

test("checkAndBroadcast: be klientų nieko neskaito", async () => {
  const world = sseWorld();
  const hub = createSseHub(world.ports);

  await hub.checkAndBroadcast();
  assert.equal(world.globalReads, 0);
});

test("checkAndBroadcast: praėjimai NEPERSIDENGIA", async () => {
  const world = sseWorld();
  const hub = createSseHub(world.ports);
  const client = fakeClient();
  await hub.addClient(client.client);
  const baseline = world.globalReads;

  let release = (): void => {};
  world.gate = { promise: new Promise<void>((resolve) => (release = resolve)), release: () => release() };
  world.mtimes.set("/vq/logs/claude-last.log", 1);

  const firstPass = hub.checkAndBroadcast();
  // Antras praėjimas ateina dar nebaigus pirmojo — jis privalo grįžti iš karto.
  await hub.checkAndBroadcast();
  world.gate.release();
  await firstPass;

  assert.equal(world.globalReads, baseline + 1, "log'as išparsinamas vieną kartą, ne dukart");
});

test("gyvi slot'ai virsta atskirais įrašais, kiekvienas iš SAVO bandymo", async () => {
  const world = sseWorld();
  world.slots = [
    {
      worker_id: "w1",
      task_id: "890",
      attempt: 1,
      log_path: "vq/runtime/w1/claude-last.log",
      logPath: "/repo/vq/runtime/w1/claude-last.log",
      taskFilePath: "/repo/vq/runtime/w1/task.md",
    },
    {
      worker_id: "w2",
      task_id: "891",
      attempt: 2,
      log_path: "vq/runtime/w2/claude-last.log",
      logPath: "/repo/vq/runtime/w2/claude-last.log",
      taskFilePath: "/repo/vq/runtime/w2/task.md",
    },
  ];
  world.attempt = { taskId: "890", watchFiles: ["/repo/vq/runtime/w1/stop.json"], stopStatusSource: "attempt" };

  const hub = createSseHub(world.ports);
  const client = fakeClient();
  await hub.addClient(client.client);

  const payload = JSON.parse(client.written[0]?.replace(/^data: /, "") ?? "null") as {
    slots: { worker_id: string; task_id: string; log_path: string }[];
    stopStatusSource: string;
  };
  assert.deepEqual(payload.slots.map((slot) => slot.worker_id), ["w1", "w2"]);
  assert.equal(payload.slots[1]?.task_id, "891");
  // Kilmė rodoma, o ne nutylima.
  assert.equal(payload.slots[0]?.log_path, "vq/runtime/w1/claude-last.log");
  assert.equal(payload.stopStatusSource, "attempt");
  assert.deepEqual(world.slotReads, ["w1", "w2"]);
});

test("miręs klientas išmetamas, o keepalive teka net be pokyčių", async () => {
  const world = sseWorld();
  const hub = createSseHub(world.ports);
  const client = fakeClient();
  await hub.addClient(client.client);

  const keepalive = world.timers.find((timer) => timer.ms === SSE_KEEPALIVE_INTERVAL_MS);
  keepalive?.handler();
  assert.equal(client.written.at(-1), ": keepalive\n\n");

  // Rašymas į sunaikintą socket'ą Node'e nemeta sinchroniškai visur — bet kai meta, klientas
  // privalo iškristi iš rinkinio, o ne likti amžinai.
  client.fail = true;
  keepalive?.handler();
  assert.equal(hub.clientCount(), 0);
});
