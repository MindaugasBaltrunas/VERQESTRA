// Sesijos įrodymų ledger'io LOCK protokolas (etalonas: AG_loop hooks/session-staging.ts IO
// pusė, task 0047 + 0056). Tuos pačius primityvus naudoja trys sluoksniai: PostToolUse
// hook'ai, Stop hook'as ir orkestratoriaus task aktyvacija — todėl protokolas gyvena atskirai
// nuo bet kurio jų.
//
// VERQESTRA nukrypimas nuo etalono, sąmoningas: visas IO ateina per LedgerFsPort, o etalono
// `node:fs` importai lieka infrastructure adapteryje. Kaina — vienas parametras kiekvienoje
// funkcijoje; nauda — sluoksnio riba nesulaužoma ir contention scenarijus testuojamas be
// tikros failų sistemos.
//
// Čia — VIENINTELĖ ledger'io laiko konstantų vieta. Jokių konfigų ar env flag'ų: hook'as
// paleidžiamas šimtus kartų per sesiją ir turi elgtis vienodai kiekvienoje mašinoje.

import { toError } from "../../shared/errors.js";
import { stealStaleLock } from "../../shared/lock-steal.js";

/**
 * - `staleMs` (10 s): riba, po kurios lock'as laikomas kritusio proceso palikimu. Kritinė
 *   sekcija čia yra vienas `read - push - rename`, t. y. milisekundės, tad 10 s be pažangos
 *   praktiškai reiškia mirusį rašytoją, o ne lėtą.
 * - `minRetryMs` / `maxRetryMs` (20 - 100 ms): eksponentinio backoff'o rėžiai. Pradžia trumpa,
 *   kad įprastas trumpas susidūrimas kainuotų ~20 ms, o riba saugo nuo kelių dešimčių
 *   lygiagrečių hook'ų sukuriamo `wx` šturmo. Realus miegas — VISADA jitter'is intervale
 *   `[minRetryMs, backoff]`: be jo vienu metu startavę laukėjai lieka fazėje, kas backoff'o
 *   periodą lock'ą gauna lygiai vienas, ir append'ų eilė netelpa į deadline'ą (išmatuota
 *   etalone kuriant task 0047: grynas eksponentinis backoff be jitter'io buvo LĖTESNIS už
 *   seną fiksuotą 20 ms retry). Viršutinė riba laikoma ties 100 ms, nes kritinė sekcija
 *   trunka ~5 ms — didesnis cap'as tik prailgina eilę, o syscall'ų nesutaupo.
 * - `timeoutMs` (15 s): bendras laukimo deadline. PRIVALO būti > `staleMs`, kitaip kritusio
 *   proceso lock'as galėtų išnaudoti mūsų deadline'ą dar nespėjus jo perimti. Kaina: laukėjas,
 *   startavęs kartu su holder'iu, ties `staleMs` gali perimti dar GYVO holder'io lock'ą
 *   (reikėtų >10 s trunkančios ~5 ms kritinės sekcijos). Tylus tai nebūna — apiplėštas
 *   holder'is tai pastebi atlaisvindamas ({@link releaseLedgerLock}).
 */
export const ledgerLockTiming = {
  staleMs: 10_000,
  minRetryMs: 20,
  maxRetryMs: 100,
  timeoutMs: 15_000,
} as const;

/**
 * Ledger'io IO portas. Platformos retry (win32 EPERM/EACCES/EBUSY per atidarytą failą) gyvena
 * adapteryje, ne čia: `renamePath`, `removeFile` ir `readContendedTextFileIfExists` privalo jį
 * turėti, nes tuos pačius failus be jokio lock'o pollina keliolika skaitytojų.
 */
export type LedgerFsPort = {
  exists(absolutePath: string): Promise<boolean>;
  makeDirectory(absoluteDir: string): Promise<void>;
  /** Nesamas ar neįskaitomas failas — `undefined`. Niekada nemeta. */
  readTextFileIfExists(absolutePath: string): Promise<string | undefined>;
  /** Tas pats kontraktas, bet su platformos contention retry. */
  readContendedTextFileIfExists(absolutePath: string): Promise<string | undefined>;
  /** ATOMINIS rašymas (unikalus tmp + rename): skaitytojas niekada nemato apkirpto failo. */
  writeTextFile(absolutePath: string, content: string): Promise<void>;
  /** `wx` primityvas — lock'o įėjimas. */
  writeFileExclusive(absolutePath: string, content: string): Promise<"created" | "exists">;
  renamePath(fromPath: string, toPath: string): Promise<void>;
  /** META, kai pašalinti nepavyko — atlaisvinimas iš to sprendžia. */
  removeFile(absolutePath: string): Promise<void>;
  fileMtimeMs(absolutePath: string): Promise<number | undefined>;
};

/** Klaidos tekstas žurnalo eilutei. */
export function ledgerErrorText(error: unknown): string {
  return toError(error).message;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let ledgerLockSeq = 0;

/**
 * Šio konkretaus lock'o paėmimo tapatybė. PID vienas nepakanka: tas pats hook procesas viename
 * ėjime ima lock'ą kelis kartus, o stale perėmimas turi būti atskiriamas nuo mūsų pačių
 * ankstesnio paėmimo. Turinys grynai vidinis — lock failo niekas neskaito (skaitytojų
 * kontraktas yra tik patys ledger'io failai).
 */
function newLedgerLockToken(): string {
  return `${process.pid}-${++ledgerLockSeq}-${Date.now()}`;
}

async function takeLedgerLock(fs: LedgerFsPort, lockPath: string, token: string): Promise<"taken" | "busy"> {
  try {
    const created = await fs.writeFileExclusive(lockPath, `${token} ${new Date().toISOString()}\n`);
    return created === "created" ? "taken" : "busy";
  } catch {
    // EEXIST reiškia „kitas hook procesas šiuo metu rašo" ir jį portas jau grąžina kaip
    // "exists". VISOS kitos klaidos irgi virsta retry: Windows ką tik trinamą lock failą laiko
    // delete-pending būsenoje ir `wx` trumpam grąžina EPERM/EACCES vietoje EEXIST — tai
    // laikina, o „nepavyko, tad rašau be lock'o" kelias rašytų lygiagrečiai su tikru holder'iu.
    // Deadline kvietėjo cikle riboja laukimą, tad amžino kartojimo nėra.
    return "busy";
  }
}

/**
 * Miego trukmė iki kito bandymo: pilnas jitter'is intervale `[minRetryMs, backoffMs]`.
 * Žr. {@link ledgerLockTiming} — jitter'is čia nėra kosmetika, o vienintelis dalykas,
 * išskaidantis vienu metu startavusių hook'ų bandymus per periodą.
 */
function jitteredBackoff(backoffMs: number): number {
  const spread = backoffMs - ledgerLockTiming.minRetryMs;
  return ledgerLockTiming.minRetryMs + (spread > 0 ? Math.floor(Math.random() * (spread + 1)) : 0);
}

/**
 * Perima lock'ą, likusį po kritusio proceso — kitaip vienas crash užrakintų ledger'į visam
 * laikui. Bendras TOCTOU-saugus algoritmas gyvena `shared/lock-steal`; čia lieka tik tai, kas
 * specifiška ledger'io lock'ui: lock'as yra FAILAS (valymas nerekursinis), tapatybė — žalias
 * lock failo tekstas, o stale riba — vien `mtimeMs`. Neįskaitoma tapatybė reiškia, kad
 * perėmimo NEPRADEDAME.
 */
async function dropStaleLedgerLock(fs: LedgerFsPort, lockPath: string): Promise<void> {
  await stealStaleLock<string>({
    lockPath,
    statMtimeMs: (target) => fs.fileMtimeMs(target),
    createStealPath: () => `${lockPath}.stale-${newLedgerLockToken()}`,
    readIdentity: (target) => fs.readTextFileIfExists(target),
    isStale: (holder, mtimeMs) => holder !== undefined && Date.now() - mtimeMs > ledgerLockTiming.staleMs,
    // Neįskaitomas (arba tuščias) perimtas lock'as traktuojamas kaip tas pats stale įrašas — jis
    // šalinamas, o ne grąžinamas.
    isForeign: (observed, stolen) => Boolean(stolen) && stolen !== observed,
    rename: (from, to) => fs.renamePath(from, to),
    exists: (target) => fs.exists(target),
    remove: async (target) => await fs.removeFile(target).catch(() => undefined),
  });
}

/**
 * Laukia lock'o iki `deadlineAtMs` ir grąžina MŪSŲ token'ą, arba `undefined`, jei deadline
 * išseko. Laukimo taisyklės (jitter'is, eksponentinis backoff, stale perėmimas) yra
 * {@link ledgerLockTiming} kontraktas ir čia gyvena vienintelį kartą — visi ledger'io rašytojai
 * privalo elgtis identiškai, nes jie serializuoja tuos pačius lygiagrečius procesus.
 */
export async function acquireLedgerLock(
  fs: LedgerFsPort,
  lockPath: string,
  deadlineAtMs: number,
): Promise<string | undefined> {
  const token = newLedgerLockToken();
  let backoffMs: number = ledgerLockTiming.minRetryMs;
  for (;;) {
    if ((await takeLedgerLock(fs, lockPath, token)) === "taken") {
      return token;
    }
    await dropStaleLedgerLock(fs, lockPath);
    const remainingMs = deadlineAtMs - Date.now();
    if (remainingMs <= 0) {
      return undefined;
    }
    await delay(Math.min(jitteredBackoff(backoffMs), remainingMs));
    backoffMs = Math.min(backoffMs * 2, ledgerLockTiming.maxRetryMs);
  }
}

/**
 * Atlaisvina MŪSŲ lock'ą ir pasako, ar jis tebebuvo mūsų.
 *
 * Besąlygiškas trynimas būtų klaida: jei kol rašėme, kitas laukėjas mūsų lock'ą palaikė stale
 * (kritinė sekcija > `staleMs`) ir pasiėmė savo, mes ištrintume JAU SVETIMĄ lock'ą ir įleistume
 * trečią rašytoją — vienas incidentas virstų kaskada. `"stolen"` grąžinimas tą paverčia
 * matomu: kvietėjas nebegali garantuoti, kad jo įrašas išliko, tad rezultatas nurašomas į tą
 * pačią garsią klaidos eilutę, o ne nutylimas.
 */
export async function releaseLedgerLock(
  fs: LedgerFsPort,
  lockPath: string,
  token: string,
): Promise<"released" | "stolen"> {
  // Nuosavybės skaitymas eina per TĄ PATĮ contention retry kaip trynimas: be jo laikinas EPERM
  // (t. y. lygiai ta klasė, dėl kurios retry egzistuoja) melagingai paskelbtų sveiką append'ą
  // prarastu IR paliktų mūsų pačių lock'ą gulėti iki `staleMs`.
  const holder = await fs.readContendedTextFileIfExists(lockPath);
  if (holder === undefined || !holder.startsWith(token)) {
    // Lock'o nebėra (kažkas jį perėmė kaip stale) arba jis nebe mūsų. Trinti nepatvirtinus
    // nuosavybės negalima: būtent taip vienas incidentas virsta kaskada.
    return "stolen";
  }

  try {
    await fs.removeFile(lockPath);
    return "released";
  } catch {
    return "stolen";
  }
}
