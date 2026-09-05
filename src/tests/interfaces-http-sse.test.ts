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
  errors: string[];
  /** Įjungus — `readActiveAttempt` meta, kaip mestų Windows EBUSY ties `claude-last.log`. */
  sourceFailure?: Error | undefined;
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
    errors: [],
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
    readActiveAttempt: () =>
      world.sourceFailure ? Promise.reject(world.sourceFailure) : Promise.resolve(world.attempt),
    legacyWatchFiles: () => ["/vq/logs/claude-last.log", "/vq/state/wave-snapshot.json"],
    setInterval: (handler, ms) => {
      const timer = { handler, ms, cleared: false };
      world.timers.push(timer);
      return { clear: () => void (timer.cleared = true) };
    },
    logError: (message) => world.errors.push(message),
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

test("kiekvieno gyvo slot'o stop įrodymas stebimas, ne tik pirmo (`readActiveAttempt`)", async () => {
  const world = sseWorld();
  world.slots = [
    {
      worker_id: "w1",
      task_id: "890",
      attempt: 1,
      log_path: "vq/runtime/w1/claude-last.log",
      logPath: "/repo/vq/runtime/w1/claude-last.log",
      taskFilePath: "/repo/vq/runtime/w1/task.md",
      stopStatePath: "/repo/vq/runtime/w1/stop-state.json",
    },
    {
      worker_id: "w2",
      task_id: "891",
      attempt: 1,
      log_path: "vq/runtime/w2/claude-last.log",
      logPath: "/repo/vq/runtime/w2/claude-last.log",
      taskFilePath: "/repo/vq/runtime/w2/task.md",
      stopStatePath: "/repo/vq/runtime/w2/stop-state.json",
    },
  ];
  // Einamasis bandymas seka TIK w1 — w2 stop įrodymas į jo watchFiles nepatenka.
  world.attempt = { taskId: "890", watchFiles: ["/repo/vq/runtime/w1/stop-state.json"], stopStatusSource: "attempt" };

  const hub = createSseHub(world.ports);
  const client = fakeClient();
  await hub.addClient(client.client);
  const afterSnapshot = client.written.length;

  await hub.checkAndBroadcast();
  assert.equal(client.written.length, afterSnapshot, "be pokyčio transliacijos nėra");

  // w2 baigė — atsirado JO stop įrodymas. Iki 2026-09-02 tai srauto nepasiekdavo.
  world.mtimes.set("/repo/vq/runtime/w2/stop-state.json", 5);
  await hub.checkAndBroadcast();
  assert.equal(client.written.length, afterSnapshot + 1, "w2 stop įrodymo pokytis transliuojamas");
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
  // Task 232 (auditas 2026-09-05, P3): numestas klientas gali būti PASKUTINIS. `close`/`error`
  // įvykis ateina tik tada, kai socket'as apie save praneša, tad sinchroniškai metęs `write` be šio
  // varto palikdavo abu taimerius suktis su 0 klientų — 1,5 s `stat` praėjimai iki kito
  // prisijungimo.
  assert.deepEqual(world.timers.map((timer) => timer.cleared), [true, true]);
});

test("paskutiniam klientui numirus per `write`, naujas klientas taimerius atstato", async () => {
  const world = sseWorld();
  const hub = createSseHub(world.ports);
  const dying = fakeClient();
  await hub.addClient(dying.client);

  dying.fail = true;
  world.timers.find((timer) => timer.ms === SSE_KEEPALIVE_INTERVAL_MS)?.handler();
  assert.equal(hub.clientCount(), 0);

  // Sustabdymas negali būti negrįžtamas: `ensureTimers` naudoja `??=`, tad išvalyti taimeriai
  // privalo būti ir NUNULINTI — kitaip antras operatoriaus langas gautų tik pirmą snapshot'ą ir
  // amžiną tylą.
  const revived = fakeClient();
  await hub.addClient(revived.client);
  assert.deepEqual(
    world.timers.filter((timer) => !timer.cleared).map((timer) => timer.ms),
    [SSE_POLL_INTERVAL_MS, SSE_KEEPALIVE_INTERVAL_MS],
  );

  world.mtimes.set("/vq/logs/claude-last.log", 7);
  await hub.checkAndBroadcast();
  assert.equal(revived.written.length, 2, "atgijęs srautas transliuoja pokytį");
});

// 2026-08-24 auditas, P0. Šaltinių skaitymas krisdavo pro `checkAndBroadcast` į taimerio
// `void checkAndBroadcast()`, t. y. tapdavo NEPERIMTU atmetimu — o Node 15+ tokį verčia neperimta
// išimtimi ir NUTRAUKIA PROCESĄ. Procesas yra tas pats, kuris aptarnauja dashboard'ą ir valdo
// loop'ą, o krentantis šaltinis — `claude-last.log`, kurį lygiagrečiai rašo vykdytojas (Windows
// EBUSY ties juo šiame repo dokumentuotas). Vadinasi, dashboard'as mirdavo aktyvaus dispatch'o
// metu — tiksliai tada, kai jo labiausiai reikia.
test("šaltinio klaida praėjime NIEKADA neišeina iš hub'o — ji pavadinama, o srautas gyvena", async () => {
  const world = sseWorld();
  const hub = createSseHub(world.ports);
  const client = fakeClient();
  await hub.addClient(client.client);
  const delivered = client.written.length;

  world.sourceFailure = new Error("EBUSY: resource busy or locked, stat 'claude-last.log'");
  world.mtimes.set("/vq/logs/claude-last.log", 10);

  // Tiesioginis kvietimas: promise NEGALI atmesti.
  await assert.doesNotReject(() => hub.checkAndBroadcast());
  // Ir taimerio kelias — tas pats, kuriuo klaida keliaudavo į procesą.
  const poll = world.timers.find((timer) => timer.ms === SSE_POLL_INTERVAL_MS);
  poll?.handler();
  // Taimeris paleidžia praėjimą per `void`, tad jo pabaigos reikia palaukti: kitaip `checkInFlight`
  // dar būtų `true`, ir kitas kvietimas grįžtų iš karto — testas matuotų savo paties lenktynes.
  await new Promise<void>((resolve) => setTimeout(resolve, 0));

  assert.equal(hub.clientCount(), 1, "klientas lieka prijungtas");
  assert.equal(client.written.length, delivered, "sugadintas praėjimas nieko netransliuoja");
  assert.equal(
    world.errors.some((line) => line.includes("sse pass failed") && line.includes("EBUSY")),
    true,
    "tyli baigtis čia būtų defektas: gedimas privalo palikti pėdsaką",
  );

  // Šaltiniui atsigavus pokytis NEPRARASTAS: žymės nebuvo pažymėtos kaip matytos.
  world.sourceFailure = undefined;
  await hub.checkAndBroadcast();
  assert.equal(client.written.length, delivered + 1);
});

test("pirmo snapshot'o klaida palieka ryšį ATVIRĄ, o ne nutraukia jį nė neprasidėjus", async () => {
  const world = sseWorld();
  world.sourceFailure = new Error("EACCES: permission denied");
  const hub = createSseHub(world.ports);
  const client = fakeClient();

  // Antraštės (200 + text/event-stream) jau išsiųstos, tad išimtis čia reikštų srautą, kuris
  // niekada neatiduoda nė vieno kadro, o klientas kartotų jungtis su atsitraukimu.
  await assert.doesNotReject(() => hub.addClient(client.client));
  assert.equal(hub.clientCount(), 1);
  assert.equal(client.written.length, 0);
  assert.equal(world.errors.some((line) => line.includes("sse initial snapshot failed")), true);

  // Pirmą krovinį atneša artimiausias praėjimas — tam pollingas ir egzistuoja.
  world.sourceFailure = undefined;
  world.mtimes.set("/vq/logs/claude-last.log", 5);
  await hub.checkAndBroadcast();
  assert.equal(client.written.length, 1);
});
