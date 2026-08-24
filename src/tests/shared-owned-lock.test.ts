// 2026-08-23 (operatoriaus radinys, P2) → 2026-08-24: užraktai be nuosavybės tokeno.
//
// Gedimas, kurį taiso `shared/owned-lock`: senasis savininkas `finally` bloke trynė lock'ą
// BESĄLYGIŠKAI, tad po stale perėmimo jis ištrindavo jau NAUJOJO savininko katalogą, ir įėjimą
// gaudavo trečias procesas — du vienu metu kritinėje sekcijoje.
//
// Testas dirba su valdomu laikrodžiu ir atmintyje laikoma FS: stale riba yra ĮĖJIMAS, ne
// laukimas, todėl lenktynė atkuriama deterministiškai, o ne kartojant ir tikintis.
import assert from "node:assert/strict";
import test from "node:test";
import {
  releaseOwnedLock,
  stealStaleOwnedLock,
  withOwnedLock,
  type OwnedLockIo,
  type OwnedLockTiming,
} from "../shared/owned-lock.js";
import { memorySchedulingFs } from "./helpers/memory-scheduling-fs.js";

const LOCK = "D:/repo/vq/state/progress.json.lock";
const TIMING: OwnedLockTiming = { staleMs: 1_000, retryMs: 1, timeoutMs: 50 };

/** Valdomas laikrodis + skaičiuojami `lock_id` — abu, kad testas nepriklausytų nuo atsitiktinumo. */
function lockIo(startMs: number): { io: OwnedLockIo; advance: (ms: number) => void; ids: string[] } {
  const fs = memorySchedulingFs(startMs);
  let nowMs = startMs;
  let counter = 0;
  const ids: string[] = [];

  const io: OwnedLockIo = {
    createLockDirectory: (dir) => fs.port.createLockDirectory(dir),
    removeDirectory: (dir) => fs.port.removeDirectory(dir),
    readTextFileIfExists: (p) => fs.port.readTextFileIfExists(p),
    writeTextFileAtomic: (p, content) => fs.port.writeTextFileAtomic(p, content),
    directoryModifiedAtMs: (dir) => fs.port.directoryModifiedAtMs(dir),
    exists: (p) => fs.port.exists(p),
    renamePath: (from, to) => fs.port.renamePath(from, to),
    nowMs: () => nowMs,
    // Miegojimas PRALEIDŽIA laiką. Be to fake'o laikrodis stovėtų, `timeoutMs` niekada
    // nesuveiktų, ir laukiantis ciklas suktųsi amžinai — testas pakibtų vietoj to, kad kristų.
    sleep: (ms) => {
      nowMs += ms;
      return Promise.resolve();
    },
    newLockId: () => {
      counter += 1;
      const id = `lock-${counter}`;
      ids.push(id);
      return id;
    },
  };

  return { io, advance: (ms) => void (nowMs += ms), ids };
}

/** Savininko `lock_id`, kaip jį mato bet kuris kitas procesas. */
async function ownerIdOf(io: OwnedLockIo): Promise<string | undefined> {
  const raw = await io.readTextFileIfExists(`${LOCK}/owner.json`);
  return raw === undefined ? undefined : (JSON.parse(raw) as { lock_id: string }).lock_id;
}

test("atlaisvinimas NETRINA lock'o, kurį jau perėmė kitas savininkas", async () => {
  const { io, advance } = lockIo(1_000);

  // A paima lock'ą ir „užstringa".
  await io.createLockDirectory(LOCK);
  await io.writeTextFileAtomic(`${LOCK}/owner.json`, JSON.stringify({ lock_id: "A", created_at: 1_000 }));

  // Praeina stale riba; B perima ir tampa savininku.
  advance(5_000);
  await stealStaleOwnedLock(io, LOCK, TIMING.staleMs);
  assert.equal(await io.createLockDirectory(LOCK), "created", "perėmus lock'as atlaisvintas");
  await io.writeTextFileAtomic(`${LOCK}/owner.json`, JSON.stringify({ lock_id: "B", created_at: 6_000 }));

  // A bando atlaisvinti SAVO lock'ą. `created_at` paduodamas ŠVIEŽIAS sąmoningai: taip fencing'as
  // trynimo neblokuoja, ir tikrinamas būtent NUOSAVYBĖS patikros vaidmuo, o ne amžiaus riba.
  // Kitaip testas praeitų dėl kitos priežasties nei ta, kurią jis vardija.
  await releaseOwnedLock(io, LOCK, { lock_id: "A", created_at: io.nowMs() }, TIMING.staleMs);

  // Būtent čia senoji versija ištrindavo B katalogą ir įleisdavo trečią rašytoją.
  assert.equal(await ownerIdOf(io), "B", "B lieka savininku");
  assert.equal(await io.createLockDirectory(LOCK), "exists", "trečias rašytojas NEGAUNA įėjimo");
});

// SCENARIJUS 4 (operatoriaus radinys 2026-08-24): TOCTOU tarp nuosavybės patikros ir trynimo.
//
// Uždaryta FENCING'u, o ne nauju primityvu: trynimas leidžiamas tik tame lange, kuriame perėmimas
// DRAUDŽIAMAS — t. y. kol `now - created_at + margin < staleMs`. Kol esame jauni, niekas neturi
// teisės mūsų perimti, tad katalogas įrodomai tebėra mūsų.
test("peržengus stale ribą atlaisvinimas NEBETRINA — teisė jau perėmėjo", async () => {
  const { io, advance } = lockIo(1_000);
  await io.createLockDirectory(LOCK);
  const claim = { lock_id: "A", created_at: 1_000 };
  await io.writeTextFileAtomic(`${LOCK}/owner.json`, JSON.stringify(claim));

  // Kritinė sekcija užtruko ilgiau nei stale riba: nuo šios akimirkos lock'as gali būti perimtas
  // BET KADA, tad mūsų trynimas nebeturi įrodymo, kad katalogas vis dar mūsų.
  advance(TIMING.staleMs + 1);
  await releaseOwnedLock(io, LOCK, claim, TIMING.staleMs);

  assert.equal(await io.createLockDirectory(LOCK), "exists", "peržengus ribą trynimas neleidžiamas");
  assert.equal(await ownerIdOf(io), "A", "savininko įrašas nepaliestas");
});

test("ties pačia riba atlaisvinimas irgi susilaiko — atsarga dviem syscall'ams", async () => {
  const { io, advance } = lockIo(1_000);
  await io.createLockDirectory(LOCK);
  const claim = { lock_id: "A", created_at: 1_000 };
  await io.writeTextFileAtomic(`${LOCK}/owner.json`, JSON.stringify(claim));

  // Likus mažiau nei atsargai iki ribos: tarp patikros ir trynimo riba galėtų būti peržengta.
  advance(TIMING.staleMs - 1);
  await releaseOwnedLock(io, LOCK, claim, TIMING.staleMs);
  assert.equal(await io.createLockDirectory(LOCK), "exists", "prie pat ribos trynimas neleidžiamas");
});

// SCENARIJUS 5 (operatoriaus radinys 2026-08-24, P1): tvora be gyvybės žymės gina tuščią prielaidą.
//
// Tvora remiasi teiginiu „kol esame jauni, niekas neturi teisės mūsų perimti". Be tiksėjimo
// `created_at` yra PAĖMIMO laikas, tad ilga kritinė sekcija pati save paverčia stale: perėmimas
// tampa teisėtas dar tebedirbant. Tiksėjimas paverčia `created_at` gyvybės žyme.
test("TIKSĖJIMAS: ilga kritinė sekcija nebevirsta stale, ir atlaisvinimas lieka teisėtas", async () => {
  const { io, advance } = lockIo(1_000);
  const ticks: Array<() => void> = [];
  const beating: OwnedLockIo = {
    ...io,
    scheduleHeartbeat: (_intervalMs, tick) => {
      ticks.push(tick);
      return () => void ticks.splice(ticks.indexOf(tick), 1);
    },
  };

  const released = await withOwnedLock(
    beating,
    LOCK,
    TIMING,
    async () => {
      // Darbas trunka ILGIAU nei stale riba — būtent tai anksčiau nuginkluodavo tvorą.
      for (let step = 0; step < 4; step += 1) {
        advance(TIMING.staleMs / 2);
        for (const tick of [...ticks]) tick();
        await Promise.resolve();
      }
      const owner = await ownerIdOf(beating);
      assert.equal(owner, "lock-1", "lock'as viso darbo metu lieka mūsų");
      return "padaryta";
    },
    "test",
  );

  assert.equal(released, "padaryta");
  assert.equal(
    await beating.createLockDirectory(LOCK),
    "created",
    "po tiksėjimo atlaisvinimas ĮVYKO — be jo tvora būtų jį uždraudusi kaip peržengtą ribą",
  );

  // KONTRASTAS: tas pats darbo ilgis BE tiksėjimo. Be jo testas įrodytų tik tiek, kad kažkas
  // praėjo, bet ne kad tiksėjimas yra priežastis.
  const plain = lockIo(1_000);
  await withOwnedLock(plain.io, LOCK, TIMING, async () => void plain.advance(TIMING.staleMs * 2), "test");
  assert.equal(
    await plain.io.createLockDirectory(LOCK),
    "exists",
    "be tiksėjimo ta pati sekcija peržengia stale ribą ir lock'as lieka gulėti",
  );
});

test("TIKSĖJIMAS nustoja ir NEPRIKELIA lock'o, kurį jau perėmė kitas", async () => {
  const { io, advance } = lockIo(1_000);
  const ticks: Array<() => void> = [];
  const beating: OwnedLockIo = { ...io, scheduleHeartbeat: (_ms, tick) => (ticks.push(tick), () => undefined) };

  await withOwnedLock(
    beating,
    LOCK,
    TIMING,
    async () => {
      // Perėmimas: svetimas savininkas užima TĄ PATĮ katalogą.
      await beating.writeTextFileAtomic(`${LOCK}/owner.json`, JSON.stringify({ lock_id: "B", created_at: 9_000 }));
      advance(TIMING.staleMs / 2);
      for (const tick of [...ticks]) tick();
      await Promise.resolve();

      assert.equal(await ownerIdOf(beating), "B", "tiksėjimas svetimo įrašo NEPERRAŠO");
    },
    "test",
  );

  assert.equal(await ownerIdOf(beating), "B", "ir atlaisvinimas svetimo lock'o nesunaikina");
});

test("atlaisvinimas trina TIK savo lock'ą", async () => {
  const { io } = lockIo(1_000);
  await io.createLockDirectory(LOCK);
  await io.writeTextFileAtomic(`${LOCK}/owner.json`, JSON.stringify({ lock_id: "A", created_at: 1_000 }));

  await releaseOwnedLock(io, LOCK, { lock_id: "A", created_at: 1_000 }, TIMING.staleMs);
  assert.equal(await io.createLockDirectory(LOCK), "created", "savas lock'as atlaisvinamas");
});

test("neįskaitomas savininkas NĖRA leidimas trinti", async () => {
  const { io } = lockIo(1_000);
  await io.createLockDirectory(LOCK);
  await io.writeTextFileAtomic(`${LOCK}/owner.json`, "{ sugadintas json");

  // Nežinia negali reikšti nuosavybės: tokį lock'ą išvalo stale perėmimas, o ne spėjimas.
  await releaseOwnedLock(io, LOCK, { lock_id: "A", created_at: 1_000 }, TIMING.staleMs);
  assert.equal(await io.createLockDirectory(LOCK), "exists");
});

test("perėmus lock'ą tarp `mkdir` ir patvirtinimo — į kritinę sekciją NEĮEINAMA", async () => {
  const { io } = lockIo(1_000);
  let entered = 0;

  // Perėmimą imituojame ties savininko RAŠYMU: iškart po jo katalogą perima kitas procesas.
  const hijacking: OwnedLockIo = {
    ...io,
    writeTextFileAtomic: async (p, content) => {
      await io.writeTextFileAtomic(p, content);
      if (p.endsWith("owner.json")) {
        await io.removeDirectory(LOCK);
        await io.createLockDirectory(LOCK);
        await io.writeTextFileAtomic(p, JSON.stringify({ lock_id: "svetimas", created_at: 1_000 }));
      }
    },
  };

  await assert.rejects(
    () => withOwnedLock(hijacking, LOCK, TIMING, () => Promise.resolve(void (entered += 1))),
    /lock is held by another writer/,
    "svetimas savininkas privalo baigtis laukimu, o ne įėjimu",
  );
  assert.equal(entered, 0, "darbas NEBUVO paleistas ant svetimo lock'o");
});

test("LAIKINA pertikrinimo skaitymo klaida neatima mūsų pačių lock'o", async () => {
  const { io } = lockIo(1_000);
  let reads = 0;
  let entered = 0;

  // Pirmas savininko skaitymas „nepavyksta" (grąžina undefined) — lygiai taip pasielgtų
  // `readTextFileIfExists` po laikinos FS klaidos. Lock'as tuo metu JAU mūsų.
  const flaky: OwnedLockIo = {
    ...io,
    readTextFileIfExists: (p) => {
      if (p.endsWith("owner.json")) {
        reads += 1;
        if (reads === 1) return Promise.resolve(undefined);
      }
      return io.readTextFileIfExists(p);
    },
  };

  const result = await withOwnedLock(flaky, LOCK, TIMING, () => {
    entered += 1;
    return Promise.resolve("ok");
  });

  // Be savo tokeno atpažinimo čia būtų buvęs laukimas iki `timeoutMs` ir klaida, o lock'as
  // būtų blokavęs VISUS iki stale ribos — nors įėjimą turėjome.
  assert.equal(entered, 1, "darbas įvykdytas, o ne prarastas dėl laikinos skaitymo klaidos");
  assert.equal(result, "ok");
  assert.equal(await io.createLockDirectory(LOCK), "created", "lock'as atlaisvintas");
});

test("laisvas lock'as paimamas, darbas įvykdomas, katalogas atlaisvinamas", async () => {
  const { io } = lockIo(1_000);
  const order: string[] = [];

  const result = await withOwnedLock(io, LOCK, TIMING, async () => {
    order.push("darbas");
    // Kritinės sekcijos metu lock'as tikrai laikomas.
    assert.equal(await io.createLockDirectory(LOCK), "exists");
    return 42;
  });

  assert.equal(result, 42);
  assert.deepEqual(order, ["darbas"]);
  assert.equal(await io.createLockDirectory(LOCK), "created", "po darbo lock'as atlaisvintas");
});

test("darbo klaida atlaisvina lock'ą ir keliauja pas kvietėją nepaliesta", async () => {
  const { io } = lockIo(1_000);

  await assert.rejects(
    () => withOwnedLock(io, LOCK, TIMING, () => Promise.reject(new Error("darbas lūžo"))),
    /darbas lūžo/,
    "atlaisvinimas negali užgožti tikrosios klaidos",
  );
  assert.equal(await io.createLockDirectory(LOCK), "created", "lock'as atlaisvintas ir po klaidos");
});

test("stale riba skaičiuojama nuo PAĖMIMO, ne nuo katalogo mtime", async () => {
  const { io, advance } = lockIo(1_000);
  await io.createLockDirectory(LOCK);
  // `created_at` naujesnis nei katalogo mtime: mtime keičia bet koks rašymas kataloge, tad jis
  // matuotų „kada paskutinį kartą rašyta", o ne „kiek laiko lock'as laikomas".
  await io.writeTextFileAtomic(`${LOCK}/owner.json`, JSON.stringify({ lock_id: "A", created_at: 900_000 }));

  advance(5_000);
  await stealStaleOwnedLock(io, LOCK, TIMING.staleMs);
  assert.equal(await ownerIdOf(io), "A", "šviežias savininkas neperimamas");
});
