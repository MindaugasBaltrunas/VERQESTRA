// NUOSAVYBĖS TOKENU pažymėtas tarpprocesinis mutex'as — viena vieta visiems katalogo lock'ams.
//
// Kodėl atsirado (operatoriaus radinys 2026-08-23, P2): trys vietos laikė tą patį protokolą
// atskirai, ir visos trys turėjo tą pačią spragą — `finally` blokas trynė lock'ą BESĄLYGIŠKAI:
//
//   1. A paima lock'ą ir užstringa ilgiau nei stale riba;
//   2. B mato stale, pašalina A lock'ą, sukuria savo — dabar savininkas yra B;
//   3. A pagaliau baigia ir savo `finally` bloke ištrina JAU B lock'ą;
//   4. C `mkdir` pavyksta — B ir C vienu metu yra kritinėje sekcijoje.
//
// Trūko ne perėmimo algoritmo (`shared/lock-steal` jau buvo), o TAPATYBĖS: lock'as neturėjo
// savininko, tad nei atlaisvinimas, nei įėjimas negalėjo patikrinti, ar jis vis dar mūsų.
//
// Du sprendimai, kurie kartu uždaro visą lenktynę:
//
//   ĮĖJIMAS. Po `mkdir` savininko įrašas užrašomas ir PERSKAITOMAS atgal. Jei tarp šių dviejų
//   žingsnių kas nors perėmė katalogą kaip stale, atgal grįš svetimas (arba joks) `lock_id`, ir
//   į kritinę sekciją NEĮEINAMA. Todėl bet kuri perėmimo lenktynė virsta pakartojimu, o ne
//   dviem procesais viduje.
//
//   ATLAISVINIMAS. Katalogas trinamas TIK jei savininko įrašas tebėra mūsų. Nežinia („įrašo
//   nėra", „neįskaitomas") NĖRA leidimas trinti: toks lock'as paliekamas stale perėmimui, kuris
//   tam ir skirtas. Tai griežčiau nei `task-state-store`, kur `!current` dar leisdavo trinti.
//
// Modulis be jokių projekto ir `node:` importų — visi efektai ateina parametrais, kaip
// `shared/lock-steal`. Todėl tą patį protokolą naudoja ir application sluoksnio portai, ir
// infrastruktūros `nodeFsAdapter`, o testas gali įrodyti lenktynę be tikro laikrodžio.

import { stealStaleLock } from "./lock-steal.js";

/** Kas laiko lock'ą. `created_at` — ms nuo epochos: stale riba skaičiuojama nuo PAĖMIMO. */
export type LockOwner = {
  lock_id: string;
  created_at: number;
  /** Laisvos formos žymė žmogui (komanda, pid) — į sprendimus neįeina. */
  holder?: string;
};

export type OwnedLockIo = {
  /** `mkdir` be `recursive`: „created" laimi lygiai vienas procesas. */
  createLockDirectory: (dir: string) => Promise<"created" | "exists">;
  removeDirectory: (dir: string) => Promise<void>;
  readTextFileIfExists: (path: string) => Promise<string | undefined>;
  writeTextFileAtomic: (path: string, content: string) => Promise<void>;
  /** Katalogo mtime (ms) — atsarginis stale matas, kai savininko įrašo perskaityti nepavyko. */
  directoryModifiedAtMs: (dir: string) => Promise<number | undefined>;
  exists: (path: string) => Promise<boolean>;
  /** Perėmimas yra `rename` į privatų kelią — jį laimi lygiai vienas procesas. */
  renamePath: (from: string, to: string) => Promise<void>;
  nowMs: () => number;
  sleep: (ms: number) => Promise<void>;
  /** Unikalus tokenas. Turi būti unikalus tarp PROCESŲ, ne tik šio proceso viduje. */
  newLockId: () => string;
};

export type OwnedLockTiming = {
  /** Po kiek laiko be atlaisvinimo lock'as laikomas kritusio proceso palikimu. */
  staleMs: number;
  /** Pauzė tarp bandymų. */
  retryMs: number;
  /** Kiek laukti iš viso, kol metama. */
  timeoutMs: number;
};

const OWNER_FILE = "owner.json";

function ownerPath(lockDir: string): string {
  return `${lockDir}/${OWNER_FILE}`;
}

/** Savininko įrašas arba `undefined`. NIEKADA nemeta: neįskaitomas lock'as = nežinomas. */
async function readOwner(io: OwnedLockIo, lockDir: string): Promise<LockOwner | undefined> {
  const raw = await io.readTextFileIfExists(ownerPath(lockDir)).catch(() => undefined);
  if (raw === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const record = parsed as Record<string, unknown>;
    const lockId = record["lock_id"];
    const createdAt = record["created_at"];
    if (typeof lockId !== "string" || lockId === "" || typeof createdAt !== "number") return undefined;
    return { lock_id: lockId, created_at: createdAt };
  } catch {
    return undefined;
  }
}

/**
 * Ar lock'as yra kritusio proceso palikimas.
 *
 * Amžius imamas iš savininko `created_at`, o ne iš katalogo mtime: mtime keičia bet koks rašymas
 * kataloge, tad jis matuoja „kada paskutinį kartą kas nors ten rašė", o ne „kiek laiko lock'as
 * laikomas". Katalogo mtime lieka atsarga tik tada, kai savininko įrašo perskaityti nepavyko —
 * be jos lock'as, kurio savininkas nespėjo įsirašyti, liktų amžinas.
 */
function isStaleOwner(owner: LockOwner | undefined, mtimeMs: number, nowMs: number, staleMs: number): boolean {
  const heldSinceMs = owner?.created_at ?? mtimeMs;
  return nowMs - heldSinceMs > staleMs;
}

/**
 * Laiko lock'ą per VISĄ `work()` ir garantuoja, kad kritinėje sekcijoje yra ne daugiau nei vienas
 * procesas. Nepavykus paimti per `timeoutMs` — METAMA: tylus tęsimas be lock'o yra lygiai tas
 * prarastas atnaujinimas, kurį šis vartas ir taiso.
 */
export async function withOwnedLock<T>(
  io: OwnedLockIo,
  lockDir: string,
  timing: OwnedLockTiming,
  work: () => Promise<T>,
  holder?: string,
): Promise<T> {
  const deadlineMs = io.nowMs() + timing.timeoutMs;

  for (;;) {
    if ((await io.createLockDirectory(lockDir)) === "created") {
      const claim: LockOwner = {
        lock_id: io.newLockId(),
        created_at: io.nowMs(),
        ...(holder === undefined ? {} : { holder }),
      };
      await io.writeTextFileAtomic(ownerPath(lockDir), JSON.stringify(claim));

      // PERTIKRINIMAS: tarp `mkdir` ir šio skaitymo katalogą galėjo perimti stale laukėjas.
      // Grįžęs svetimas `lock_id` reiškia, kad lock'as jau ne mūsų — tada nei įeiname, nei
      // trename (katalogas priklauso kitam), o tiesiog laukiame toliau.
      const confirmed = await readOwner(io, lockDir);
      if (confirmed?.lock_id === claim.lock_id) {
        try {
          return await work();
        } finally {
          await releaseOwnedLock(io, lockDir, claim.lock_id);
        }
      }
    } else {
      await stealStaleOwnedLock(io, lockDir, timing.staleMs);
    }

    if (io.nowMs() >= deadlineMs) {
      throw new Error(`lock is held by another writer: ${lockDir}`);
    }
    await io.sleep(timing.retryMs);
  }
}

/**
 * Atlaisvina lock'ą TIK jei jis vis dar mūsų.
 *
 * Būtent besąlyginis trynimas čia ir įleisdavo trečią rašytoją. Nesutapęs arba neperskaitytas
 * savininkas reiškia „nebe mūsų" — toks lock'as paliekamas, o jį išvalys stale perėmimas.
 * Klaidos nurauamos: metimas čia užgožtų tikrąjį `work()` rezultatą arba jo klaidą.
 */
export async function releaseOwnedLock(io: OwnedLockIo, lockDir: string, lockId: string): Promise<void> {
  const current = await readOwner(io, lockDir);
  if (current?.lock_id !== lockId) return;
  await io.removeDirectory(lockDir).catch(() => undefined);
}

/**
 * Perima lock'ą, likusį po kritusio proceso. Algoritmas — bendras `shared/lock-steal`:
 * `rename` į privatų kelią laimi lygiai vienas laukėjas, o perėmus SVETIMĄ tapatybę lock'as
 * grąžinamas, o ne sunaikinamas.
 */
export async function stealStaleOwnedLock(io: OwnedLockIo, lockDir: string, staleMs: number): Promise<void> {
  await stealStaleLock<LockOwner>({
    lockPath: lockDir,
    statMtimeMs: (target) => io.directoryModifiedAtMs(target).catch(() => undefined),
    createStealPath: () => `${lockDir}.stale-${io.newLockId()}`,
    readIdentity: (target) => readOwner(io, target),
    isStale: (owner, mtimeMs) => isStaleOwner(owner, mtimeMs, io.nowMs(), staleMs),
    isForeign: (observed, stolen) =>
      observed !== undefined && stolen !== undefined && stolen.lock_id !== observed.lock_id,
    rename: (from, to) => io.renamePath(from, to),
    exists: (target) => io.exists(target),
    remove: async (target) => await io.removeDirectory(target).catch(() => undefined),
  });
}
