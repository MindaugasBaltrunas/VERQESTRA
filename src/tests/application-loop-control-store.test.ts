// VQ-503 (4/5-a) testai — loop valdiklio ir workerių prašymo saugyklos. Svarbiausia, ką jie
// pin'ina: fail-soft kryptis VISADA `run` pusėn (sugadintas failas negali tyliai sustabdyti eilės),
// bet gedimas pažymimas `invalid`; nežinomas slot'as yra `run`, ne draudimas; netinkamas kūnas
// META ir failo NEKEIČIA; o aplinkos šiukšlė nėra override.

import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import {
  InvalidLoopControlError,
  LOOP_CONTROL_SCHEMA_VERSION,
  LOOP_SLOT_KEYS,
  drainAllSlots,
  loopControlFile,
  readLoopControl,
  resetLoopControl,
  resolveSlotMode,
  setSlotMode,
  type LoopControlDeps,
} from "../application/scheduling/loop-control-store.js";
import {
  InvalidWorkerRequestError,
  REQUESTED_WORKERS_ENV,
  readWorkerRequest,
  setRequestedWorkers,
  workerRequestFile,
  type WorkerRequestDeps,
} from "../application/scheduling/worker-request-store.js";
import { RUNTIME_MAX_WORKERS } from "../application/scheduling/worker-limits.js";

const STATE = path.resolve("/repo/vq/state");
const CONTROL = loopControlFile(STATE);
const REQUEST = workerRequestFile(STATE);
const NOW = new Date("2026-08-21T12:00:00.000Z");

type StoreWorld = {
  store: Map<string, string>;
  unreadable: Set<string>;
  loop: LoopControlDeps;
  workers: WorkerRequestDeps;
  env: Map<string, string>;
};

function storeWorld(files: Record<string, string> = {}): StoreWorld {
  const store = new Map(Object.entries(files));
  const unreadable = new Set<string>();
  const env = new Map<string, string>();
  const fs = {
    readTextFileIfExists: (p: string): Promise<string | undefined> =>
      unreadable.has(p) ? Promise.reject(new Error("EACCES")) : Promise.resolve(store.get(p)),
    listDirectoryIfExists: (): Promise<string[] | undefined> => Promise.resolve(undefined),
    writeTextFileAtomic: (p: string, content: string): Promise<void> => {
      store.set(p, content);
      return Promise.resolve();
    },
    makeDirectory: (): Promise<void> => Promise.resolve(),
    exists: (p: string): Promise<boolean> => Promise.resolve(store.has(p)),
    createLockDirectory: (): Promise<"created" | "exists"> => Promise.resolve("created"),
    removeDirectory: (): Promise<void> => Promise.resolve(),
    directoryModifiedAtMs: (): Promise<number | undefined> => Promise.resolve(undefined),
    // `loop-control-store` nesirakina — laukas yra tik dėl porto tipo (žr. `loop-lifecycle`).
    renamePath: (): Promise<void> => Promise.resolve(),
    removeIfExists: (): Promise<void> => Promise.resolve(),
  };
  return {
    store,
    unreadable,
    env,
    loop: { fs, now: () => NOW },
    workers: { fs, env: (name) => env.get(name) },
  };
}

function control(slots: Record<string, unknown>): string {
  return JSON.stringify({ schema_version: LOOP_CONTROL_SCHEMA_VERSION, updated_at: NOW.toISOString(), slots });
}

// ---------------------------------------------------------------------------
// loop control
// ---------------------------------------------------------------------------

test("LOOP_SLOT_KEYS: raktų kiekis sutampa su runtime workerių riba", () => {
  // Literalai saugykloje sąmoningi (jokio pool'o importo), tad sutapimą prikala testas.
  assert.equal(LOOP_SLOT_KEYS.length, RUNTIME_MAX_WORKERS);
});

test("readLoopControl: nesamas failas yra numatytoji būsena, o gedimas — pažymimas", async () => {
  const empty = storeWorld();
  const state = await readLoopControl(empty.loop, STATE);
  assert.deepEqual(state, { slots: { w1: { mode: "run" }, w2: { mode: "run" } } });
  assert.equal(state.invalid, undefined, "trūkstamas failas nėra klaida");

  // Fail-soft VISADA `run` pusėn: sugadintas failas negali tyliai sustabdyti eilės, nes „loop'as
  // nieko nedaro ir niekas nesako kodėl" yra blogesnė būsena už „valdiklis neveikė".
  const malformed = storeWorld({ [CONTROL]: "{ nebaigtas" });
  assert.equal((await readLoopControl(malformed.loop, STATE)).invalid, "malformed");

  const schema = storeWorld({ [CONTROL]: JSON.stringify({ schema_version: 99, slots: {} }) });
  const schemaState = await readLoopControl(schema.loop, STATE);
  assert.equal(schemaState.invalid, "schema");
  assert.equal(schemaState.slots.w1.mode, "run");

  const unreadable = storeWorld();
  unreadable.unreadable.add(CONTROL);
  assert.equal((await readLoopControl(unreadable.loop, STATE)).invalid, "unreadable");
});

test("readLoopControl: trūkstamas slot'o įrašas yra `run`, ne tuščia būsena", async () => {
  const world = storeWorld({ [CONTROL]: control({ w2: { mode: "drain" } }) });
  const state = await readLoopControl(world.loop, STATE);

  assert.equal(state.slots.w1.mode, "run", "trūkstamas įrašas ir prašomas run yra ta pati būsena");
  assert.equal(state.slots.w2.mode, "drain");
});

test("resolveSlotMode: nežinomas worker id yra `run`, o ne tylus draudimas", () => {
  const state = { slots: { w1: { mode: "abort" as const }, w2: { mode: "drain" as const } } };
  assert.equal(resolveSlotMode(state, "w1"), "abort");
  assert.equal(resolveSlotMode(state, "w2"), "drain");
  // Valdiklis gali tik SUMAŽINTI: būsimas trečias slot'as negali būti tyliai užblokuotas.
  assert.equal(resolveSlotMode(state, "w3"), "run");
  assert.equal(resolveSlotMode(state, ""), "run");
});

test("setSlotMode: netinkamas slot'as ar kūnas META ir failo NEKEIČIA", async () => {
  const world = storeWorld();

  await assert.rejects(() => setSlotMode(world.loop, STATE, "w9", { mode: "drain" }), InvalidLoopControlError);
  // Papildomi laukai atmetami: `.strict()` gina kontraktą tik kai paduodamas VISAS kūnas.
  await assert.rejects(
    () => setSlotMode(world.loop, STATE, "w1", { mode: "drain", requested_at: "2020-01-01" }),
    InvalidLoopControlError,
  );
  await assert.rejects(() => setSlotMode(world.loop, STATE, "w1", null), InvalidLoopControlError);
  await assert.rejects(() => setSlotMode(world.loop, STATE, "w1", { mode: "kitas" }), InvalidLoopControlError);
  assert.equal(world.store.has(CONTROL), false, "atmestas prašymas nieko nerašo");
});

test("setSlotMode: laiko žymą stato serveris, o kitas slot'as lieka nepaliestas", async () => {
  const world = storeWorld({ [CONTROL]: control({ w2: { mode: "abort", reason: "senas" } }) });

  const state = await setSlotMode(world.loop, STATE, "w1", { mode: "drain", reason: "operatorius" });
  assert.deepEqual(state.slots.w1, {
    mode: "drain",
    requested_at: NOW.toISOString(),
    reason: "operatorius",
  });
  assert.equal(state.slots.w2.mode, "abort", "kito slot'o būsena nekeičiama");
});

test("resetLoopControl ir drainAllSlots: visi slot'ai vienu ėjimu", async () => {
  const world = storeWorld({ [CONTROL]: control({ w1: { mode: "abort" } }) });

  const drained = await drainAllSlots(world.loop, STATE);
  assert.deepEqual(
    LOOP_SLOT_KEYS.map((key) => drained.slots[key].mode),
    ["drain", "drain"],
  );

  // Likusi `drain` vėliava priverstų ką tik paleistą loop'ą atsisakyti pirmo task'o.
  const reset = await resetLoopControl(world.loop, STATE);
  assert.deepEqual(
    LOOP_SLOT_KEYS.map((key) => reset.slots[key].mode),
    ["run", "run"],
  );
});

// ---------------------------------------------------------------------------
// workerių prašymas
// ---------------------------------------------------------------------------

test("readWorkerRequest: aplinka nugali failą, bet šiukšlė NĖRA override", async () => {
  const world = storeWorld({ [REQUEST]: JSON.stringify({ requested: 2 }) });

  assert.deepEqual(await readWorkerRequest(world.workers, STATE), {
    requested: 2,
    source: "state",
    envOverride: false,
  });

  world.env.set(REQUESTED_WORKERS_ENV, "2");
  assert.deepEqual(await readWorkerRequest(world.workers, STATE), {
    requested: 2,
    source: "env",
    envOverride: true,
  });

  // Rašybos klaida nėra prašymas: laikyti ją override'u reikštų tyliai užrakinti valdiklį ir rodyti
  // „reikšmę valdo aplinka", nors realiai nevaldo niekas.
  world.env.set(REQUESTED_WORKERS_ENV, "nope");
  assert.equal((await readWorkerRequest(world.workers, STATE)).source, "state");
});

test("readWorkerRequest: sugadintas failas krenta į numatytąjį, bet pažymi kodėl", async () => {
  const malformed = storeWorld({ [REQUEST]: "{ nebaigtas" });
  const state = await readWorkerRequest(malformed.workers, STATE);
  assert.deepEqual({ requested: state.requested, source: state.source, invalid: state.invalid }, {
    requested: 1,
    source: "default",
    invalid: "malformed",
  });

  const schema = storeWorld({ [REQUEST]: JSON.stringify({ requested: 9 }) });
  assert.equal((await readWorkerRequest(schema.workers, STATE)).invalid, "schema");

  const missing = storeWorld();
  assert.equal((await readWorkerRequest(missing.workers, STATE)).invalid, undefined);
});

test("setRequestedWorkers: už ribų esantis prašymas META, o ne tyliai apkerpamas", async () => {
  const world = storeWorld();

  // Apkirptas „5" atrodytų kaip priimtas prašymas — todėl klaida, ne tylus apkirpimas.
  await assert.rejects(() => setRequestedWorkers(world.workers, STATE, { requested: 5 }), InvalidWorkerRequestError);
  await assert.rejects(() => setRequestedWorkers(world.workers, STATE, { requested: 1.5 }), InvalidWorkerRequestError);
  await assert.rejects(
    () => setRequestedWorkers(world.workers, STATE, { requested: 2, kitas: true }),
    InvalidWorkerRequestError,
  );
  await assert.rejects(() => setRequestedWorkers(world.workers, STATE, [2]), InvalidWorkerRequestError);
  assert.equal(world.store.has(REQUEST), false);

  const state = await setRequestedWorkers(world.workers, STATE, { requested: 2 });
  assert.deepEqual(state, { requested: 2, source: "state", envOverride: false });
});
