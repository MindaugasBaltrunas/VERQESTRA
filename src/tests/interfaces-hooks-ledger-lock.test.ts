// VQ-502 (5/6-b) testai — ledger'io lock protokolas. Svarbiausia, ką jie pin'ina: `wx` klaida
// yra BUSY (o ne leidimas rašyti be lock'o), stale perėmimas atrakina kritusio proceso lock'ą,
// šviežio svetimo lock'o niekas neperima, o atlaisvinimas NIEKADA netrina lock'o, kurio
// nuosavybė nepatvirtinta.

import assert from "node:assert/strict";
import { test } from "node:test";
import { stealStaleLock } from "../shared/lock-steal.js";
import {
  type LedgerFsPort,
  acquireLedgerLock,
  ledgerLockTiming,
  releaseLedgerLock,
} from "../interfaces/hooks/ledger-lock.js";

const LOCK = "/repo/vq/state/session-writes.json.lock";

type LedgerWorld = {
  fs: LedgerFsPort;
  store: Map<string, string>;
  /** mtime, kurį portas grąžina vietoj „dabar" — stale riba testuojama be laukimo. */
  mtimes: Map<string, number>;
  faults: { exclusive?: Error; write?: Error; remove?: Error; rename?: Error };
  calls: { exclusive: number; write: number; remove: number };
};

function fakeLedgerFs(initial: Record<string, string> = {}): LedgerWorld {
  const store = new Map(Object.entries(initial));
  const mtimes = new Map<string, number>();
  const faults: LedgerWorld["faults"] = {};
  const calls = { exclusive: 0, write: 0, remove: 0 };
  const enoent = (): Error => Object.assign(new Error("ENOENT"), { code: "ENOENT" });

  const fs: LedgerFsPort = {
    exists: async (p) => store.has(p),
    makeDirectory: async () => {},
    readTextFileIfExists: async (p) => store.get(p),
    readContendedTextFileIfExists: async (p) => store.get(p),
    writeTextFile: async (p, content) => {
      calls.write += 1;
      if (faults.write) throw faults.write;
      store.set(p, content);
    },
    writeFileExclusive: async (p, content) => {
      calls.exclusive += 1;
      if (faults.exclusive) throw faults.exclusive;
      if (store.has(p)) return "exists";
      store.set(p, content);
      return "created";
    },
    renamePath: async (from, to) => {
      if (faults.rename) throw faults.rename;
      const value = store.get(from);
      if (value === undefined) throw enoent();
      store.delete(from);
      store.set(to, value);
      const mtime = mtimes.get(from);
      if (mtime !== undefined) {
        mtimes.delete(from);
        mtimes.set(to, mtime);
      }
    },
    removeFile: async (p) => {
      calls.remove += 1;
      if (faults.remove) throw faults.remove;
      store.delete(p);
      mtimes.delete(p);
    },
    fileMtimeMs: async (p) => (store.has(p) ? (mtimes.get(p) ?? Date.now()) : undefined),
  };

  return { fs, store, mtimes, faults, calls };
}

// ---------------------------------------------------------------------------
// acquire
// ---------------------------------------------------------------------------

test("acquireLedgerLock: laisvas lock'as paimamas, o užimtas šviežias — niekada neperimamas", async () => {
  const world = fakeLedgerFs();
  const token = await acquireLedgerLock(world.fs, LOCK, Date.now() + 500);
  assert.ok(token, "laisvas lock'as privalo būti paimtas");
  assert.ok(world.store.get(LOCK)?.startsWith(token));

  // Antras laukėjas mato ŠVIEŽIĄ (mtime = dabar) svetimą lock'ą: stale perėmimas netaikomas,
  // tad jis laukia iki deadline'o ir grįžta tuščiomis. Fail-open šaka „nepavyko, tad rašau be
  // lock'o" čia neegzistuoja.
  const second = await acquireLedgerLock(world.fs, LOCK, Date.now() + 80);
  assert.equal(second, undefined);
  assert.ok(world.store.get(LOCK)?.startsWith(token), "svetimas lock'as lieka nepaliestas");
});

test("acquireLedgerLock: stale lock'as perimamas ir vieta atlaisvinama", async () => {
  const world = fakeLedgerFs({ [LOCK]: "1234-1-0 2026-08-21T00:00:00.000Z\n" });
  world.mtimes.set(LOCK, Date.now() - ledgerLockTiming.staleMs - 5_000);

  const token = await acquireLedgerLock(world.fs, LOCK, Date.now() + 1_000);
  assert.ok(token, "kritusio proceso lock'as privalo būti perimtas");
  assert.ok(world.store.get(LOCK)?.startsWith(token));
  // Perimtas lock'as pervadinamas į privatų kelią ir sunaikinamas — jokių šiukšlių.
  assert.deepEqual([...world.store.keys()], [LOCK]);
});

test("acquireLedgerLock: `wx` klaida yra BUSY, ne leidimas rašyti be lock'o", async () => {
  const world = fakeLedgerFs();
  // Windows ką tik trinamą lock failą laiko delete-pending būsenoje ir grąžina EPERM vietoje
  // EEXIST. Traktuoti tai kaip „lock'as neprieinamas, rašau vis tiek" reikštų du rašytojus
  // kritinėje sekcijoje; teisingas atsakymas — retry iki deadline'o ir tuščias rezultatas.
  world.faults.exclusive = Object.assign(new Error("EPERM"), { code: "EPERM" });

  const token = await acquireLedgerLock(world.fs, LOCK, Date.now() + 80);
  assert.equal(token, undefined);
  assert.equal(world.store.size, 0);
  assert.ok(world.calls.exclusive > 1, "deadline'as privalo apimti daugiau nei vieną bandymą");
});

// ---------------------------------------------------------------------------
// release
// ---------------------------------------------------------------------------

test("releaseLedgerLock: trinamas TIK savas lock'as; svetimas ir dingęs duoda stolen", async () => {
  const world = fakeLedgerFs();
  const token = await acquireLedgerLock(world.fs, LOCK, Date.now() + 500);
  assert.ok(token);
  assert.equal(await releaseLedgerLock(world.fs, LOCK, token), "released");
  assert.equal(world.store.has(LOCK), false);

  // Kol dirbome, mus palaikė stale ir lock'ą pasiėmė kitas. Besąlygiškas trynimas čia įleistų
  // TREČIĄ rašytoją — vienas incidentas virstų kaskada.
  world.store.set(LOCK, "kitas-9-9 2026-08-21T00:00:00.000Z\n");
  const before = world.calls.remove;
  assert.equal(await releaseLedgerLock(world.fs, LOCK, token), "stolen");
  assert.equal(world.calls.remove, before, "svetimas lock'as netrinamas net nebandant");
  assert.equal(world.store.get(LOCK), "kitas-9-9 2026-08-21T00:00:00.000Z\n");

  // Neįskaitomas arba dingęs lock'as — irgi stolen: negalime tvirtinti, kad įrašas išliko.
  world.store.delete(LOCK);
  assert.equal(await releaseLedgerLock(world.fs, LOCK, token), "stolen");
});

test("releaseLedgerLock: nepavykęs trynimas grąžina stolen, o ne tylią sėkmę", async () => {
  const world = fakeLedgerFs();
  const token = await acquireLedgerLock(world.fs, LOCK, Date.now() + 500);
  assert.ok(token);
  world.faults.remove = Object.assign(new Error("EPERM"), { code: "EPERM" });

  // Lock'as liko gulėti — kvietėjas privalo tai matyti, nes jo įrašo išlikimo niekas
  // nebegarantuoja.
  assert.equal(await releaseLedgerLock(world.fs, LOCK, token), "stolen");
  assert.equal(world.store.has(LOCK), true);
});

// ---------------------------------------------------------------------------
// shared/lock-steal — bendras TOCTOU-saugus algoritmas
// ---------------------------------------------------------------------------

test("stealStaleLock: perimtas JAU NAUJO savininko lock'as grąžinamas, o ne sunaikinamas", async () => {
  const store = new Map<string, string>([["/lock", "senas"]]);
  const removed: string[] = [];
  let renames = 0;

  await stealStaleLock<string>({
    lockPath: "/lock",
    statMtimeMs: async () => 0,
    createStealPath: () => "/lock.stale-1",
    readIdentity: async (p) => store.get(p),
    isStale: () => true,
    isForeign: (observed, stolen) => Boolean(stolen) && stolen !== observed,
    rename: async (from, to) => {
      renames += 1;
      const value = store.get(from);
      if (value === undefined) throw new Error("ENOENT");
      store.delete(from);
      // Pirmas pervadinimas įvyksta lygiai tuo metu, kai lock'ą jau teisėtai perėmė NAUJAS
      // savininkas: perimame ne tą tapatybę, kurią matėme kaip stale.
      store.set(to, renames === 1 ? "naujas" : value);
    },
    exists: async (p) => store.has(p),
    remove: async (p) => void removed.push(p),
  });

  assert.equal(store.get("/lock"), "naujas", "svetimas lock'as privalo grįžti į savo vietą");
  assert.deepEqual(removed, [], "nepatvirtintos nuosavybės lock'as niekada nesunaikinamas");
});

test("stealStaleLock: ne stale ir dingęs lock'as nieko nedaro", async () => {
  const renames: string[] = [];
  const options = {
    lockPath: "/lock",
    createStealPath: () => "/lock.stale-1",
    readIdentity: async (): Promise<string | undefined> => "gyvas",
    isForeign: (): boolean => false,
    rename: async (from: string): Promise<void> => void renames.push(from),
    exists: async (): Promise<boolean> => true,
    remove: async (): Promise<void> => {},
  };

  // Šviežias lock'as: perėmimo net nepradedame.
  await stealStaleLock<string>({ ...options, statMtimeMs: async () => Date.now(), isStale: () => false });
  // Lock'o nebėra — `stat` neduoda mtime; kitas retry ciklas bandys iš naujo.
  await stealStaleLock<string>({ ...options, statMtimeMs: async () => undefined, isStale: () => true });

  assert.deepEqual(renames, []);
});
