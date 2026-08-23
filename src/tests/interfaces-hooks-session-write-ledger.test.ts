// VQ-502 (5/6-b) testai — ledger'io rašytojai po lock'u. Svarbiausia, ką jie pin'ina: append'as
// NIEKADA nemeta (PostToolUse throw = užblokuotas tool call'as), lock timeout politika skiriasi
// pagal failą („drop" prieš „unlocked-append"), nuosavybės sidecar'o gedimas NEPAVERČIA pavykusio
// įrašo prarastu darbu, o vidury append'o pavogtas lock'as nurašo įrašą garsiai.

import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import {
  mergeSessionWriteOwner,
  sessionWriteOwnersPath,
  shouldResetSessionWriteLedger,
} from "../application/task-execution/session-write-owners.js";
import type { LedgerFsPort } from "../interfaces/hooks/ledger-lock.js";
import {
  appendJsonArrayEntry,
  clearSessionWriteLedger,
  recordSessionWriteOwner,
} from "../interfaces/hooks/session-write-ledger.js";

// Keliai statomi per `path.join` — sidecar'o kelio taisyklė irgi juo remiasi, tad POSIX formos
// literalas Windows'e tyliai prasilenktų su tikruoju raktu.
const STATE_DIR = path.join(path.resolve("/repo"), "vq", "state");
const LEDGER = path.join(STATE_DIR, "session-writes.json");
const OWNERS = sessionWriteOwnersPath(LEDGER);
const LOCK = `${LEDGER}.lock`;

type LedgerWorld = {
  fs: LedgerFsPort;
  store: Map<string, string>;
  faults: { mkdir?: Error; write?: Error; remove?: Error };
  calls: { exclusive: number; write: number };
  /** Kviečiama kritinės sekcijos rašymo metu — lock'o vagystei imituoti. */
  onWrite?: () => void;
};

function fakeLedgerFs(initial: Record<string, string> = {}): LedgerWorld {
  const store = new Map(Object.entries(initial));
  const world: LedgerWorld = {
    store,
    faults: {},
    calls: { exclusive: 0, write: 0 },
    fs: {
      exists: async (p) => store.has(p),
      makeDirectory: async () => {
        if (world.faults.mkdir) throw world.faults.mkdir;
      },
      readTextFileIfExists: async (p) => store.get(p),
      readContendedTextFileIfExists: async (p) => store.get(p),
      writeTextFile: async (p, content) => {
        world.calls.write += 1;
        if (world.faults.write) throw world.faults.write;
        store.set(p, content);
        world.onWrite?.();
      },
      writeFileExclusive: async (p, content) => {
        world.calls.exclusive += 1;
        if (store.has(p)) return "exists";
        store.set(p, content);
        return "created";
      },
      renamePath: async (from, to) => {
        const value = store.get(from);
        if (value === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        store.delete(from);
        store.set(to, value);
      },
      removeFile: async (p) => {
        if (world.faults.remove) throw world.faults.remove;
        store.delete(p);
      },
      fileMtimeMs: async (p) => (store.has(p) ? Date.now() : undefined),
    },
  };
  return world;
}

const entriesOf = (world: LedgerWorld, file = LEDGER): unknown => JSON.parse(world.store.get(file) ?? "null");

// ---------------------------------------------------------------------------
// appendJsonArrayEntry
// ---------------------------------------------------------------------------

test("appendJsonArrayEntry: pirmas įrašas rašomas po lock'u, pakartotinis eina lock-free keliu", async () => {
  const world = fakeLedgerFs();

  const first = await appendJsonArrayEntry(world.fs, LEDGER, "src/a.ts");
  assert.equal(first.appended, true);
  assert.equal(first.alreadyPresent, false);
  assert.deepEqual(entriesOf(world), ["src/a.ts"]);
  assert.equal(world.store.has(LOCK), false, "lock'as privalo būti atlaisvintas");

  // Read yra dažniausias tool call'as sesijoje: kai įrašas jau yra, `wx` ciklas nieko nekeičia,
  // tik kainuoja. Masyvas monotoniškas (įrašai po vieną netrinami), tad „matau įrašą" yra
  // galutinis atsakymas.
  const exclusiveBefore = world.calls.exclusive;
  const second = await appendJsonArrayEntry(world.fs, LEDGER, "src/a.ts");
  assert.deepEqual({ appended: second.appended, alreadyPresent: second.alreadyPresent }, {
    appended: true,
    alreadyPresent: true,
  });
  assert.equal(world.calls.exclusive, exclusiveBefore, "lock'o net nebandoma imti");
});

test("appendJsonArrayEntry: sugadintas ir ne masyvo formos ledger'is virsta tuščiu, o ne klaida", async () => {
  // PostToolUse hook'e išimtis reiškia exit 2, t. y. UŽBLOKUOTĄ tool call'ą: vienas sugadintas
  // įrodymų failas būtų blokavęs kiekvieną rašymą, o pataisyti jo agentas negali.
  for (const broken of ["{ nebaigtas", '{"ne":"masyvas"}', "null"]) {
    const world = fakeLedgerFs({ [LEDGER]: broken });
    const result = await appendJsonArrayEntry(world.fs, LEDGER, "src/a.ts");
    assert.equal(result.appended, true, broken);
    assert.deepEqual(entriesOf(world), ["src/a.ts"], broken);
  }
});

test("appendJsonArrayEntry: lock timeout — `drop` nurašo įrašą, `unlocked-append` vis tiek rašo", async () => {
  const held = fakeLedgerFs({ [LOCK]: "kitas-1-1 2026-08-21T00:00:00.000Z\n" });
  const dropped = await appendJsonArrayEntry(held.fs, LEDGER, "src/a.ts", { lockWaitMs: 60 });
  assert.equal(dropped.appended, false);
  assert.match(dropped.failure ?? "", /lock not acquired within 60ms/);
  assert.equal(held.store.has(LEDGER), false, "svetimų įrašų nesugadiname");

  // readme-read-events klysta į PRIEŠINGĄ pusę: prarastas skaitymo įrašas uždaro readme-guard
  // vartus grandinės viduryje, o agentas jų atidaryti nebegali.
  const events = fakeLedgerFs({ [LOCK]: "kitas-1-1 2026-08-21T00:00:00.000Z\n" });
  const degraded = await appendJsonArrayEntry(events.fs, LEDGER, "README.md", {
    lockWaitMs: 60,
    onLockTimeout: "unlocked-append",
  });
  assert.deepEqual({ appended: degraded.appended, degraded: degraded.degraded }, { appended: true, degraded: true });
  assert.deepEqual(entriesOf(events), ["README.md"]);
});

test("appendJsonArrayEntry: katalogo ir rašymo gedimai grįžta rezultatu, niekada išimtimi", async () => {
  const noDir = fakeLedgerFs();
  noDir.faults.mkdir = new Error("EACCES vq/state");
  const dirFailure = await appendJsonArrayEntry(noDir.fs, LEDGER, "src/a.ts");
  assert.equal(dirFailure.appended, false);
  assert.match(dirFailure.failure ?? "", /ledger dir unavailable: EACCES/);

  const noWrite = fakeLedgerFs();
  noWrite.faults.write = new Error("EPERM rename");
  const writeFailure = await appendJsonArrayEntry(noWrite.fs, LEDGER, "src/a.ts");
  assert.equal(writeFailure.appended, false);
  assert.match(writeFailure.failure ?? "", /ledger write failed: EPERM rename/);
  assert.equal(noWrite.store.has(LOCK), false, "lock'as atlaisvinamas ir po klaidos");
});

test("appendJsonArrayEntry: withinLock gedimas duoda ownerFailure, bet append'as lieka pavykęs", async () => {
  const world = fakeLedgerFs();
  const result = await appendJsonArrayEntry(world.fs, LEDGER, "src/a.ts", {
    withinLock: async () => {
      throw new Error("sidecar nepasiekiamas");
    },
  });

  // ATSKIRI laukai sąmoningai: pats įrašas ledger'yje YRA, tad „necommit'into darbo" žymė čia
  // meluotų — prarastas savininkas kelią tik grąžina į saugią „legacy" būseną.
  assert.deepEqual({ appended: result.appended, failure: result.failure }, { appended: true, failure: undefined });
  assert.equal(result.ownerFailure, "sidecar nepasiekiamas");
  assert.deepEqual(entriesOf(world), ["src/a.ts"]);
});

test("appendJsonArrayEntry: su withinLock lock'as imamas ir tada, kai įrašas jau buvo", async () => {
  const world = fakeLedgerFs({ [LEDGER]: JSON.stringify(["src/a.ts"]) });
  let ownerWrites = 0;
  const result = await appendJsonArrayEntry(world.fs, LEDGER, "src/a.ts", {
    withinLock: async () => void (ownerWrites += 1),
  });

  // Fast path praleidžiamas: nuosavybės įrašas privalo atsirasti ir tada, kai pats kelias
  // ledger'yje jau yra (antra sesija, rašanti tą patį failą).
  assert.deepEqual({ appended: result.appended, alreadyPresent: result.alreadyPresent }, {
    appended: true,
    alreadyPresent: true,
  });
  assert.equal(ownerWrites, 1);
});

test("appendJsonArrayEntry: vidury append'o pavogtas lock'as nurašo įrašą garsiai", async () => {
  const world = fakeLedgerFs();
  world.onWrite = (): void => {
    // Kol rašėme, kitas laukėjas mus palaikė stale ir pasiėmė savo lock'ą. Serializacija
    // nebegaliojo, tad tvirtinti „įrašas išliko" nebegalime.
    world.store.set(LOCK, "kitas-9-9 2026-08-21T00:00:00.000Z\n");
  };

  const result = await appendJsonArrayEntry(world.fs, LEDGER, "src/a.ts");
  assert.equal(result.appended, false);
  assert.match(result.failure ?? "", /lock was reclaimed by another writer mid-append/);
});

// ---------------------------------------------------------------------------
// nuosavybės sidecar'as
// ---------------------------------------------------------------------------

test("mergeSessionWriteOwner: aibės jungiamos, tuščia sesija ir nieko nekeičiantis įrašas — undefined", () => {
  const owners = { "src/a.ts": { sessions: ["nonce-1"], tasks: ["890"] } };

  const added = mergeSessionWriteOwner(owners, "src/a.ts", { session: "nonce-2", taskId: "891" });
  assert.deepEqual(added, { key: "src/a.ts", owner: { sessions: ["nonce-1", "nonce-2"], tasks: ["890", "891"] } });

  // Windows separatoriai normalizuojami — raktas yra git kelio forma.
  assert.equal(mergeSessionWriteOwner({}, "src\\b.ts", { session: "n", taskId: "" })?.key, "src/b.ts");

  // Tuščia tapatybė NIEKADA nerašoma: kelias be savininko reiškia „legacy / nežinoma", ir tokia
  // saugi būsena neturi virsti melagingu „žinau, ir tai ne tu".
  assert.equal(mergeSessionWriteOwner(owners, "src/a.ts", { session: "  ", taskId: "890" }), undefined);
  assert.equal(mergeSessionWriteOwner(owners, "src/a.ts", { session: "nonce-1", taskId: "890" }), undefined);
});

// Etalono task 1100: tik NAUJAS task'as valo ledger'į — to paties task'o retry/repair/resume
// privalo matyti ankstesnių bandymų rašymus. Iki 2026-08-23 VERQESTRA valymas buvo besąlyginis
// plikas "[]", o clearSessionWriteLedger neturėjo nė vieno produkcinio kvietėjo.
test("shouldResetSessionWriteLedger: naujas task'as valo, tas pats — ne", () => {
  assert.equal(shouldResetSessionWriteLedger(undefined, "0042"), true, "pirmas startas valo");
  assert.equal(shouldResetSessionWriteLedger("0041", "0042"), true, "kitas task'as valo");
  assert.equal(shouldResetSessionWriteLedger("0042", "0042"), false, "to paties task'o retry NEvalo");
});

test("recordSessionWriteOwner: sugadintas sidecar'as perrašomas, tuščia sesija nieko neliečia", async () => {
  const world = fakeLedgerFs({ [OWNERS]: "[ne objektas]" });
  await recordSessionWriteOwner(world.fs, OWNERS, "src/a.ts", { session: "nonce-1", taskId: "890" });
  assert.deepEqual(entriesOf(world, OWNERS), { "src/a.ts": { sessions: ["nonce-1"], tasks: ["890"] } });

  const writesBefore = world.calls.write;
  await recordSessionWriteOwner(world.fs, OWNERS, "src/a.ts", { session: "", taskId: "890" });
  assert.equal(world.calls.write, writesBefore, "be tapatybės sidecar'as neliečiamas");
});

// ---------------------------------------------------------------------------
// clearSessionWriteLedger
// ---------------------------------------------------------------------------

test("clearSessionWriteLedger: valo ledger'į, sidecar'ą ir palydovus po tuo pačiu lock'u", async () => {
  const extra = path.join(STATE_DIR, "readme-read-events.json");
  const world = fakeLedgerFs({
    [LEDGER]: JSON.stringify(["src/a.ts"]),
    [OWNERS]: JSON.stringify({ "src/a.ts": { sessions: ["n"], tasks: [] } }),
    [extra]: JSON.stringify(["README.md"]),
  });

  const result = await clearSessionWriteLedger(world.fs, LEDGER, [extra]);
  assert.deepEqual(result, { locked: true });
  assert.deepEqual([...world.store.keys()], []);
});

test("clearSessionWriteLedger: neįgytas lock'as valymo NESUSTABDO, tik pažymi locked=false", async () => {
  // Task'as be išvalyto ledger'io stage'intų praeito task'o rašymus — tai blogesnis gedimas nei
  // lenktynės, tad valymas vyksta vis tiek, bet kvietėjas privalo tai garsiai užloginti.
  const world = fakeLedgerFs({
    [LEDGER]: JSON.stringify(["src/a.ts"]),
    [LOCK]: "kitas-1-1 2026-08-21T00:00:00.000Z\n",
  });

  const result = await clearSessionWriteLedger(world.fs, LEDGER, [], 60);
  assert.deepEqual(result, { locked: false });
  assert.equal(world.store.has(LEDGER), false);
  assert.equal(world.store.has(LOCK), true, "svetimas lock'as lieka jo savininkui");
});

test("clearSessionWriteLedger: trynimo klaida grąžinama, o ne metama", async () => {
  const world = fakeLedgerFs({ [LEDGER]: JSON.stringify(["src/a.ts"]) });
  world.faults.remove = new Error("EBUSY");

  const result = await clearSessionWriteLedger(world.fs, LEDGER, [], 60);
  assert.equal(result.locked, true);
  assert.match(result.failure ?? "", /ledger clear failed: EBUSY/);
});
