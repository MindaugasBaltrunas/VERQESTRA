// VQ-502 (6/6-a) testai — sesijos/loop runtime įrašas ir sesijos baseline taisyklės.
// Svarbiausia, ką jie pin'ina: vien PID NĖRA gyvumo įrodymas (pernaudotas svetimas PID praeina
// `kill(0)`, bet ne heartbeat'ą), `corrupt` niekada nevirsta spėjimu, „failo nėra" reiškia
// skirtingus dalykus savo įrašą valdančiam ir pasyviam indikatoriui, o į ATEITĮ datuotas
// checkpoint'as neatidaro gyvo dispatch'o vartų neribotam laikui.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  LOOP_HEARTBEAT_TTL_MS,
  classifyLoopRuntime,
  loopRuntimeIsAlive,
  parseLegacyLoopRuntimeRecord,
  parseLoopRuntimeRecord,
  resolveSessionOwnerPid,
  type LoopRuntimeRecord,
} from "../domain/scheduling/loop-runtime.js";
import {
  dispatchAttemptIsLive,
  sessionBaselineWasClean,
  sessionStartIsSameAttempt,
  sessionStartStatusPath,
} from "../application/task-execution/session-baseline.js";
import {
  type LoopRuntimePorts,
  inspectLoopRuntimeRecord,
  loopRuntimeRecordPath,
  readLoopRuntimeRecord,
  releaseLoopRuntimeRecord,
  removeStaleRuntimeRecord,
  writeLoopRuntimeRecord,
} from "../interfaces/hooks/loop-runtime-store.js";

const PID_FILE = "/repo/vq/state/user-claude.pid";
const RUNTIME_FILE = loopRuntimeRecordPath(PID_FILE);
const NOW = new Date("2026-08-21T12:00:00.000Z");

function record(overrides: Partial<LoopRuntimeRecord> = {}): LoopRuntimeRecord {
  return {
    pid: 4242,
    started_at: "2026-08-21T11:00:00.000Z",
    heartbeat_at: NOW.toISOString(),
    ...overrides,
  };
}

type RuntimeWorld = { ports: LoopRuntimePorts; store: Map<string, string>; mtimes: Map<string, number> };

function fakeRuntimeWorld(files: Record<string, string> = {}, alivePids: number[] = [4242]): RuntimeWorld {
  const store = new Map(Object.entries(files));
  const mtimes = new Map<string, number>();
  return {
    store,
    mtimes,
    ports: {
      processIsAlive: (pid) => alivePids.includes(pid),
      now: () => NOW,
      fs: {
        exists: async (p) => store.has(p),
        readTextFileIfExists: async (p) => store.get(p),
        writeTextFile: async (p, content) => void store.set(p, content),
        makeDirectory: async () => {},
        fileMtimeMs: async (p) => (store.has(p) ? (mtimes.get(p) ?? NOW.getTime()) : undefined),
        removeIfExists: async (p) => void store.delete(p),
      },
    },
  };
}

// ---------------------------------------------------------------------------
// domain: parsinimas ir gyvumas
// ---------------------------------------------------------------------------

test("parseLoopRuntimeRecord: neteisingas PID, trūkstami laukai ir ne-JSON duoda undefined", () => {
  assert.deepEqual(parseLoopRuntimeRecord(JSON.stringify(record())), record());

  // 0 ir neigiami POSIX'e reiškia procesų GRUPĘ, ne procesą — toks įrašas negali būti nuoroda.
  assert.equal(parseLoopRuntimeRecord(JSON.stringify(record({ pid: 0 }))), undefined);
  assert.equal(parseLoopRuntimeRecord(JSON.stringify(record({ pid: -1 }))), undefined);
  assert.equal(parseLoopRuntimeRecord('{"pid":4242,"started_at":"x"}'), undefined);
  assert.equal(parseLoopRuntimeRecord("{ nebaigtas"), undefined);

  // Dalinė supervizoriaus būsena atmetama VISA, o ne pildoma spėjimais.
  const partial = parseLoopRuntimeRecord(
    JSON.stringify({ ...record(), supervisor: { restarts_used: 1 } }),
  );
  assert.equal(partial?.supervisor, undefined);
  const full = parseLoopRuntimeRecord(
    JSON.stringify({ ...record(), supervisor: { restarts_used: 1, arrested: false, last_reason: "429" } }),
  );
  assert.deepEqual(full?.supervisor, { restarts_used: 1, arrested: false, last_reason: "429" });
});

test("parseLegacyLoopRuntimeRecord: skaičius + failo mtime; bet kas kita — undefined", () => {
  const mtime = "2026-08-21T10:00:00.000Z";
  assert.deepEqual(parseLegacyLoopRuntimeRecord("4242\n", mtime), {
    pid: 4242,
    started_at: mtime,
    heartbeat_at: mtime,
  });
  assert.equal(parseLegacyLoopRuntimeRecord("0", mtime), undefined);
  assert.equal(parseLegacyLoopRuntimeRecord("{}", mtime), undefined);
  assert.equal(parseLegacyLoopRuntimeRecord("pid=4242", mtime), undefined);
});

test("loopRuntimeIsAlive: PID vienas NEĮRODO gyvumo — reikia ir šviežio heartbeat'o", () => {
  const alive = (pid: number): boolean => pid === 4242;

  assert.equal(loopRuntimeIsAlive({ record: record(), processIsAlive: alive, now: NOW }), true);
  // Pernaudotas svetimas PID: procesas EGZISTUOJA, bet heartbeat'o niekas nebeatnaujina.
  const stale = record({ heartbeat_at: new Date(NOW.getTime() - LOOP_HEARTBEAT_TTL_MS - 1_000).toISOString() });
  assert.equal(loopRuntimeIsAlive({ record: stale, processIsAlive: alive, now: NOW }), false);
  // Miręs PID — nesvarbu, koks šviežias heartbeat'as.
  assert.equal(loopRuntimeIsAlive({ record: record({ pid: 999 }), processIsAlive: alive, now: NOW }), false);
  assert.equal(
    loopRuntimeIsAlive({ record: record({ heartbeat_at: "ne data" }), processIsAlive: alive, now: NOW }),
    false,
  );
  assert.equal(loopRuntimeIsAlive({ record: undefined, processIsAlive: alive, now: NOW }), false);
});

test("classifyLoopRuntime: corrupt visada unknown, o įrašo nebuvimas priklauso nuo savininko", () => {
  const alive = (pid: number): boolean => pid === 4242;

  // Failas yra, bet neperskaitomas — spėti draudžiama.
  assert.equal(classifyLoopRuntime({ inspection: { state: "corrupt" }, processIsAlive: alive }), "unknown");
  assert.equal(
    classifyLoopRuntime({ inspection: { state: "corrupt" }, processIsAlive: alive, selfRegistering: true }),
    "unknown",
  );

  // Savo įrašą valdantis procesas: nebuvimas yra ĮRODYMAS, kad jis neveikia.
  assert.equal(
    classifyLoopRuntime({ inspection: { state: "absent" }, processIsAlive: alive, selfRegistering: true }),
    "stopped",
  );
  // Pasyvus indikatorius: nebuvimas nieko neįrodo.
  assert.equal(classifyLoopRuntime({ inspection: { state: "absent" }, processIsAlive: alive }), "unknown");

  const stale = record({ heartbeat_at: new Date(NOW.getTime() - LOOP_HEARTBEAT_TTL_MS - 1).toISOString() });
  assert.equal(
    classifyLoopRuntime({
      inspection: { state: "ok", record: stale },
      processIsAlive: alive,
      selfRegistering: true,
      now: NOW,
    }),
    "stopped",
  );
  // Pasyviam indikatoriui heartbeat'o nėra kam atnaujinti — pakanka gyvo PID.
  assert.equal(
    classifyLoopRuntime({ inspection: { state: "ok", record: stale }, processIsAlive: alive, now: NOW }),
    "running",
  );
  // Sugadintas PID (grupės numeris) niekada neatrodo gyvas.
  assert.equal(
    classifyLoopRuntime({ inspection: { state: "ok", record: { ...stale, pid: 0 } }, processIsAlive: () => true }),
    "stopped",
  );
});

test("resolveSessionOwnerPid: init ir grupių numeriai atmetami, miręs tėvas — irgi", () => {
  const alive = (pid: number): boolean => pid === 4242;
  assert.equal(resolveSessionOwnerPid(4242, alive), 4242);
  assert.equal(resolveSessionOwnerPid(1, alive), undefined);
  assert.equal(resolveSessionOwnerPid(0, alive), undefined);
  assert.equal(resolveSessionOwnerPid(-9, alive), undefined);
  assert.equal(resolveSessionOwnerPid(777, alive), undefined);
});

// ---------------------------------------------------------------------------
// saugykla
// ---------------------------------------------------------------------------

test("inspectLoopRuntimeRecord: pilnas įrašas pirmiau, legacy — atsarginis kelias", async () => {
  const both = fakeRuntimeWorld({
    [RUNTIME_FILE]: JSON.stringify(record()),
    [PID_FILE]: "111\n",
  });
  assert.deepEqual(await readLoopRuntimeRecord(both.ports, PID_FILE), record());

  const legacyOnly = fakeRuntimeWorld({ [PID_FILE]: "4242\n" });
  legacyOnly.mtimes.set(PID_FILE, Date.parse("2026-08-21T10:00:00.000Z"));
  assert.deepEqual(await readLoopRuntimeRecord(legacyOnly.ports, PID_FILE), {
    pid: 4242,
    started_at: "2026-08-21T10:00:00.000Z",
    heartbeat_at: "2026-08-21T10:00:00.000Z",
  });

  // Runtime failas BUVO, bet neperskaitomas, o legacy nėra — tai `corrupt`, ne `absent`.
  const broken = fakeRuntimeWorld({ [RUNTIME_FILE]: "{ nebaigtas" });
  assert.deepEqual(await inspectLoopRuntimeRecord(broken.ports, PID_FILE), { state: "corrupt" });
  // Sugadintas legacy failas irgi `corrupt`.
  const brokenLegacy = fakeRuntimeWorld({ [PID_FILE]: "ne pid" });
  assert.deepEqual(await inspectLoopRuntimeRecord(brokenLegacy.ports, PID_FILE), { state: "corrupt" });
  // Nieko nėra — `absent`.
  assert.deepEqual(await inspectLoopRuntimeRecord(fakeRuntimeWorld().ports, PID_FILE), { state: "absent" });
});

test("writeLoopRuntimeRecord: rašomi ABU failai — legacy skaitytojas negali apakti", async () => {
  const world = fakeRuntimeWorld();
  const written = await writeLoopRuntimeRecord(world.ports, PID_FILE, 4242);

  assert.equal(written.heartbeat_at, NOW.toISOString());
  assert.deepEqual(JSON.parse(world.store.get(RUNTIME_FILE) ?? "null"), written);
  // Senas skaitytojas priima TIK `^\d+$` — formatas, kurio jis nesupranta, gyvena kitame faile.
  assert.equal(world.store.get(PID_FILE), "4242\n");
});

test("releaseLoopRuntimeRecord: trinamas TIK savas įrašas", async () => {
  const own = fakeRuntimeWorld({ [RUNTIME_FILE]: JSON.stringify(record()), [PID_FILE]: "4242\n" });
  assert.equal(await releaseLoopRuntimeRecord(own.ports, PID_FILE, 4242), true);
  assert.deepEqual([...own.store.keys()], []);

  // Failas dalijamasis: svetimo įrašo trynimas paslėptų dar gyvą sesiją.
  const foreign = fakeRuntimeWorld({ [RUNTIME_FILE]: JSON.stringify(record({ pid: 777 })) });
  assert.equal(await releaseLoopRuntimeRecord(foreign.ports, PID_FILE, 4242), false);
  assert.equal(foreign.store.has(RUNTIME_FILE), true);
});

test("removeStaleRuntimeRecord: gyvas įrašas paliekamas, negyvas — šalinamas su abiem failais", async () => {
  const live = fakeRuntimeWorld({ [RUNTIME_FILE]: JSON.stringify(record()), [PID_FILE]: "4242\n" });
  assert.equal(await removeStaleRuntimeRecord(live.ports, PID_FILE), false);
  assert.equal(live.store.size, 2);

  const dead = fakeRuntimeWorld({ [RUNTIME_FILE]: JSON.stringify(record({ pid: 999 })), [PID_FILE]: "999\n" });
  assert.equal(await removeStaleRuntimeRecord(dead.ports, PID_FILE), true);
  assert.deepEqual([...dead.store.keys()], []);
});

// ---------------------------------------------------------------------------
// sesijos baseline ir gyvas dispatch'as
// ---------------------------------------------------------------------------

test("sessionBaselineWasClean: svetimas nonce nesako nieko, o paaiškintas purvas neblokuoja", () => {
  const baseline = {
    dispatch_nonce: "nonce-1",
    baseline_valid: true,
    non_runtime_dirty_entries: [{ status: " M", path: "src/a.ts" }],
  };

  assert.equal(sessionBaselineWasClean(baseline, "nonce-1"), false, "nepaaiškintas purvas");
  assert.equal(sessionBaselineWasClean(baseline, "nonce-1", new Set(["src/a.ts"])), true);
  // Kito bandymo baseline nesako NIEKO — kvietėjas krenta į task lygio taisyklę.
  assert.equal(sessionBaselineWasClean(baseline, "nonce-2", new Set(["src/a.ts"])), false);
  assert.equal(sessionBaselineWasClean(baseline, "", new Set(["src/a.ts"])), false);
  // `git status` nepavyko — baseline negalioja, nors purvo sąrašas atrodo tuščias.
  assert.equal(sessionBaselineWasClean({ dispatch_nonce: "nonce-1", baseline_valid: false }, "nonce-1"), false);

  assert.equal(sessionStartIsSameAttempt(baseline, " nonce-1 "), true);
  assert.equal(sessionStartIsSameAttempt(baseline, ""), false);
  assert.match(sessionStartStatusPath("/repo/vq/state").replace(/\\/g, "/"), /session-start-status\.json$/);
});

test("dispatchAttemptIsLive: tik `dispatch`+`started` to paties task'o ir tik realiame lange", () => {
  const nowMs = Date.parse("2026-08-21T12:00:00.000Z");
  const live = {
    phase: "dispatch",
    status: "started",
    task_id: "890",
    updated_at: "2026-08-21T11:30:00.000Z",
  };

  assert.equal(dispatchAttemptIsLive(live, "890", nowMs), true);
  assert.equal(dispatchAttemptIsLive(live, "891", nowMs), false, "kito task'o dispatch'as");
  assert.equal(dispatchAttemptIsLive({ ...live, status: "finished" }, "890", nowMs), false);
  assert.equal(dispatchAttemptIsLive({ ...live, phase: "verify" }, "890", nowMs), false);
  assert.equal(dispatchAttemptIsLive(undefined, "890", nowMs), false);
  // Konfigo lubomis (4 h) besinaudojantis dispatch'as VIS DAR gyvas — 3 h senumo checkpoint'as
  // buvo nurašomas, kol langas buvo 90 min literalas (pilnas auditas 2026-09-05).
  assert.equal(dispatchAttemptIsLive({ ...live, updated_at: "2026-08-21T09:00:00.000Z" }, "890", nowMs), true);
  // Per senas checkpoint'as = nužudytas orkestratorius, o ne dirbantis dispatch'as: net
  // plačiausias išvedamas langas plius atsarga (4 h 10 min) čia jau išsekęs.
  assert.equal(dispatchAttemptIsLive({ ...live, updated_at: "2026-08-21T06:00:00.000Z" }, "890", nowMs), false);
  // Į ATEITĮ datuotas įrašas (atsuktas laikrodis, VM snapshot) duotų neigiamą amžių, kuris
  // viršutinę ribą tenkina VISADA — vartai liktų atviri neribotai.
  assert.equal(dispatchAttemptIsLive({ ...live, updated_at: "2026-08-21T13:00:00.000Z" }, "890", nowMs), false);
  assert.equal(dispatchAttemptIsLive({ ...live, updated_at: "ne data" }, "890", nowMs), false);
});
