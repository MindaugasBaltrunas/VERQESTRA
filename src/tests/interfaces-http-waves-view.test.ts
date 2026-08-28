// VQ-503 (3/5-b) testai — bangų vaizdas. Svarbiausia, ką jie pin'ina: vieno šaltinio lūžis
// NENUVERČIA vaizdo, bet ir NENUTYLA (`degraded`); neperskaityti įvykiai neverčia slot'o
// `provisioned` melo; sugadintas snapshot'as skiriasi nuo nesamo; wire lease'as neneša worktree
// kelio; o `?limit` apkarpo TIK rodomą sąrašą, ne slot'ų būsenos įrodymus.

import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import {
  DEFAULT_WAVE_EVENT_LIMIT,
  MAX_WAVE_EVENT_LIMIT,
  buildWavesView,
  normalizeEventLimit,
  projectWaveEvent,
  type WavesViewLease,
  type WavesViewPorts,
  type WavesViewSnapshot,
} from "../interfaces/http/ui-waves-view.js";
import { SLOT_FAILURE_PREFIX } from "../interfaces/ui-model/wave-slot-model.js";

const ROOT = path.resolve("/repo");
const RUNTIME = path.join(ROOT, "vq");
const EVENTS = path.join(RUNTIME, "logs", "wave-events.jsonl");
const ORCHESTRATOR_LOG = path.join(RUNTIME, "logs", "orchestrator.log");
const WORKTREE_POLICY_FILE = path.join(RUNTIME, "config", "worktree-policy.json");
const NOW = new Date("2026-08-21T12:00:00.000Z");

type WavesWorld = {
  ports: WavesViewPorts;
  files: Map<string, string[]>;
  leases: WavesViewLease[];
  snapshot?: WavesViewSnapshot;
  snapshotExists: boolean;
  worktreePolicyEnabled: boolean;
  errors: string[];
  failing: Set<string>;
};

function wavesWorld(): WavesWorld {
  const files = new Map<string, string[]>();
  const errors: string[] = [];
  const world: WavesWorld = {
    files,
    errors,
    leases: [],
    snapshotExists: false,
    worktreePolicyEnabled: false,
    failing: new Set<string>(),
    ports: {
      readTailLines: (file) =>
        world.failing.has(file) ? Promise.reject(new Error("neperskaitoma")) : Promise.resolve(files.get(file) ?? []),
      listWorkerLeases: () =>
        world.failing.has("leases") ? Promise.reject(new Error("lease store down")) : Promise.resolve(world.leases),
      readWaveSnapshot: () => Promise.resolve(world.snapshot),
      waveSnapshotExists: () => Promise.resolve(world.snapshotExists),
      homeDir: () => "/home/ana",
      readWorktreePolicyEnabled: (absoluteConfigFile) =>
        world.failing.has(absoluteConfigFile)
          ? Promise.reject(new Error("neperskaitoma politika"))
          : Promise.resolve(world.worktreePolicyEnabled),
      now: () => NOW,
      logError: (message) => errors.push(message),
    },
  };
  return world;
}

// Lease store'as saugo worktree_path JAU projekto-reliatyviu keliu (žr. wave-provisioning.ts
// `created.relativePath`) — fixture atspindi tą formą, ne absoliutų kelią.
const lease = {
  worker_id: "w1",
  task_id: "890",
  status: "held",
  acquired_at: "2026-08-21T11:00:00.000Z",
  heartbeat_at: "2026-08-21T11:59:00.000Z",
  expires_at: "2026-08-21T12:30:00.000Z",
  worktree_path: ".worktrees/w1",
};

test("normalizeEventLimit: netinkama reikšmė krenta į numatytąją", () => {
  assert.equal(normalizeEventLimit(null), DEFAULT_WAVE_EVENT_LIMIT);
  assert.equal(normalizeEventLimit("abc"), DEFAULT_WAVE_EVENT_LIMIT);
  assert.equal(normalizeEventLimit("0"), DEFAULT_WAVE_EVENT_LIMIT);
  assert.equal(normalizeEventLimit("-5"), DEFAULT_WAVE_EVENT_LIMIT);
  assert.equal(normalizeEventLimit("7"), 7);
});

test("projectWaveEvent: sugadinta eilutė ir įvykis be vardo praleidžiami", () => {
  assert.equal(projectWaveEvent("{ nebaigtas", (t) => t), undefined);
  assert.equal(projectWaveEvent("[]", (t) => t), undefined);
  assert.equal(projectWaveEvent(JSON.stringify({ ts: "x" }), (t) => t), undefined);

  const event = projectWaveEvent(
    JSON.stringify({ ts: "2026-08-21T11:00:00.000Z", event: "task_started", task_id: "890", reason: "/home/ana/x" }),
    (text) => text.replace("/home/ana/x", "<path>"),
  );
  assert.deepEqual(event, {
    ts: "2026-08-21T11:00:00.000Z",
    event: "task_started",
    task_id: "890",
    reason: "<path>",
  });
});

test("buildWavesView: wire lease neneša worktree kelio, o slot'ai gauna vykdymo įrodymą", async () => {
  const world = wavesWorld();
  world.leases = [lease];
  world.files.set(EVENTS, [
    JSON.stringify({ ts: "2026-08-21T11:05:00.000Z", event: "task_started", task_id: "890" }),
  ]);

  const view = await buildWavesView({ ports: world.ports, projectRoot: ROOT, runtimeRoot: RUNTIME });
  assert.deepEqual(view.leases, [
    { worker_id: "w1", task_id: "890", status: "held", expires_at: "2026-08-21T12:30:00.000Z", has_worktree: true },
  ]);
  assert.equal(view.slots[0]?.state, "running");
  assert.equal(view.slots[0]?.phase, "delegated");
  assert.equal(view.slots[0]?.worktree_path, ".worktrees/w1");
  assert.deepEqual(view.slots[0]?.last_event, {
    ts: "2026-08-21T11:05:00.000Z",
    event: "task_started",
    task_id: "890",
  });
  assert.deepEqual(view.degraded, []);
});

test("buildWavesView: worktree kelias, vedantis už projekto ribų, į slot'ą nepatenka", async () => {
  const world = wavesWorld();
  world.leases = [{ ...lease, worktree_path: "/etc/passwd" }];

  const view = await buildWavesView({ ports: world.ports, projectRoot: ROOT, runtimeRoot: RUNTIME });
  assert.equal(view.slots[0]?.worktree_path, null);
  assert.equal(view.slots[0]?.has_worktree, true, "has_worktree lieka true — worktree yra, tik jo kelias nerodomas");
});

test("buildWavesView: neperskaityti įvykiai pažymimi degraded IR neverčia provisioned melo", async () => {
  const world = wavesWorld();
  world.leases = [lease];
  world.failing.add(EVENTS);

  const view = await buildWavesView({ ports: world.ports, projectRoot: ROOT, runtimeRoot: RUNTIME });
  assert.deepEqual(view.degraded, ["events"]);
  assert.equal(view.slots[0]?.state, "running", "įrodymų nebuvimas nėra įrodymas");
  assert.match(world.errors.join("\n"), /waves view source 'events' failed/);
});

test("buildWavesView: sugadintas snapshot'as skiriasi nuo nesamo", async () => {
  const missing = wavesWorld();
  const emptyView = await buildWavesView({ ports: missing.ports, projectRoot: ROOT, runtimeRoot: RUNTIME });
  assert.deepEqual(emptyView.last_rejections, []);
  assert.deepEqual(emptyView.degraded, [], "nesamas snapshot'as nėra gedimas");

  // Failas YRA, bet skaitytojas jo neperskaitė: tylėti čia reikštų meluoti „atmetimų nebuvo".
  const broken = wavesWorld();
  broken.snapshotExists = true;
  const brokenView = await buildWavesView({ ports: broken.ports, projectRoot: ROOT, runtimeRoot: RUNTIME });
  assert.deepEqual(brokenView.degraded, ["rejections"]);
});

test("buildWavesView: atmetimai suliejami ir dedublikuojami, o sprendimai lieka atskiri", async () => {
  const world = wavesWorld();
  world.snapshot = {
    worker_pool: { rejected: [{ task_id: "891", reason: "write-set", detail: "src/a.ts" }] },
    refill: {
      decisions: [
        {
          episode: 1,
          worker_id: "w2",
          task_id: "891",
          granted: false,
          reason: "konfliktas /home/ana/repo",
          // SKAIČIUS, ne vėliava: kiek kandidatų nukirsta vien dėl užpildyto limito.
          hard_capped: 2,
          decided_at: "2026-08-21T11:10:00.000Z",
          rejected: [{ task_id: "891", reason: "write-set", detail: "src/a.ts" }],
        },
        {
          episode: 2,
          worker_id: "w3",
          task_id: "892",
          granted: true,
          reason: "",
          hard_capped: 0,
          decided_at: "2026-08-21T11:20:00.000Z",
          rejected: [],
        },
      ],
    },
  };

  const view = await buildWavesView({ ports: world.ports, projectRoot: ROOT, runtimeRoot: RUNTIME });
  // Tas pats atmetimas iš dviejų šaltinių lieka vienas.
  assert.equal(view.last_rejections.length, 1);
  // Epizodas, kuris nieko neatmetė, VIS TIEK matomas: tai atsakymas „ką nusprendė kiekvienas".
  assert.deepEqual(
    view.refill_decisions.map((decision) => decision.episode),
    [1, 2],
  );
  // Laisvas tekstas išvalytas ir sprendimuose.
  assert.equal(view.refill_decisions[0]?.reason.includes("/home/ana"), false);
  // `hard_capped` yra SKAIČIUS: iki 2026-08-23 audito serverio tipas jį skelbė `boolean`, tad
  // „nukirsta 2" ir „nukirsta 1" būtų tapę ta pačia reikšme kiekvienam būsimam kvietėjui.
  assert.equal(view.refill_decisions[0]?.hard_capped, 2);
  assert.equal(view.refill_decisions[1]?.hard_capped, 0);
});

test("buildWavesView: slot'o nesėkmė ateina iš orchestrator.log ir yra išvalyta", async () => {
  const world = wavesWorld();
  world.leases = [lease];
  world.files.set(ORCHESTRATOR_LOG, [
    "[2026-08-21 11:00:00] kita eilutė",
    `[2026-08-21 11:30:00] ${SLOT_FAILURE_PREFIX} slot=w1 task=890 error=worktree /repo/.worktrees/w1 užimtas`,
  ]);

  const view = await buildWavesView({ ports: world.ports, projectRoot: ROOT, runtimeRoot: RUNTIME });
  assert.equal(view.slots[0]?.state, "failed");
  assert.equal(view.slots[0]?.last_failure?.reason.includes("/repo/.worktrees"), false);
  assert.match(view.slots[0]?.last_failure?.reason ?? "", /<path>/);
});

test("buildWavesView: limitas apkarpo TIK rodomus įvykius, ne būsenos įrodymus", async () => {
  const world = wavesWorld();
  world.leases = [lease];
  world.files.set(EVENTS, [
    JSON.stringify({ ts: "2026-08-21T11:05:00.000Z", event: "task_started", task_id: "890" }),
    JSON.stringify({ ts: "2026-08-21T11:06:00.000Z", event: "wave_planned" }),
    JSON.stringify({ ts: "2026-08-21T11:07:00.000Z", event: "wave_completed" }),
  ]);

  const view = await buildWavesView({ ports: world.ports, projectRoot: ROOT, runtimeRoot: RUNTIME, eventLimit: 1 });
  assert.deepEqual(
    view.events.map((event) => event.event),
    ["wave_completed"],
  );
  // Slot'as vis tiek mato `task_started`: būsena negali priklausyti nuo to, kiek eilučių paprašė
  // naršyklė.
  assert.equal(view.slots[0]?.state, "running");

  const capped = await buildWavesView({
    ports: world.ports,
    projectRoot: ROOT,
    runtimeRoot: RUNTIME,
    eventLimit: MAX_WAVE_EVENT_LIMIT + 1000,
  });
  assert.equal(capped.events.length, 3);
});

test("buildWavesView: lease'ų šaltinio lūžis palieka vaizdą su tuščiais slot'ais", async () => {
  const world = wavesWorld();
  world.failing.add("leases");

  const view = await buildWavesView({ ports: world.ports, projectRoot: ROOT, runtimeRoot: RUNTIME });
  assert.deepEqual(view.slots, []);
  assert.deepEqual(view.leases, []);
  assert.deepEqual(view.degraded, ["leases"]);
});

test("buildWavesView: worktree politika įjungta matoma vaizde su projektui reliatyviu keliu", async () => {
  const world = wavesWorld();
  world.worktreePolicyEnabled = true;

  const view = await buildWavesView({ ports: world.ports, projectRoot: ROOT, runtimeRoot: RUNTIME });
  assert.deepEqual(view.worktree_policy, { enabled: true, config_path: "vq/config/worktree-policy.json" });
  assert.deepEqual(view.degraded, []);
});

test("buildWavesView: worktree politika išjungta arba failo nėra irgi matoma, tik su enabled: false", async () => {
  const world = wavesWorld();

  const view = await buildWavesView({ ports: world.ports, projectRoot: ROOT, runtimeRoot: RUNTIME });
  assert.deepEqual(view.worktree_policy, { enabled: false, config_path: "vq/config/worktree-policy.json" });
  assert.deepEqual(view.degraded, []);
});

test("buildWavesView: neperskaitomas worktree politikos failas žymimas degraded, o laukas praleidžiamas", async () => {
  const world = wavesWorld();
  world.failing.add(WORKTREE_POLICY_FILE);

  const view = await buildWavesView({ ports: world.ports, projectRoot: ROOT, runtimeRoot: RUNTIME });
  assert.equal(view.worktree_policy, undefined);
  assert.deepEqual(view.degraded, ["worktree_policy"]);
  assert.match(world.errors.join("\n"), /waves view source 'worktree_policy' failed/);
});
