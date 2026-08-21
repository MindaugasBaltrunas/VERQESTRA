// Sesijos įrodymų ledger'io RAŠYMAS po lock'u (etalonas: AG_loop hooks/session-staging.ts,
// task 0047 + 0056). Lock'o protokolas — `ledger-lock.ts`; čia — ką su juo daro rašytojai.
//
// Nemeta NIEKADA: rašymo klaida grąžinama kaip `appended: false`, nes PostToolUse hook'e throw
// virsta exit kodu 2, t. y. UŽBLOKUOTU tool call'u. Įrodymų telemetrija neturi teisės sustabdyti
// darbo — tik tapti matoma.

import path from "node:path";
import {
  type SessionWriteIdentity,
  type SessionWriteOwners,
  mergeSessionWriteOwner,
  sessionWriteOwnersPath,
} from "../../application/task-execution/session-write-owners.js";
import { toPrettyJson, tryParseJson, parseJsonStringArray } from "../../shared/json.js";
import {
  type LedgerFsPort,
  acquireLedgerLock,
  ledgerErrorText,
  ledgerLockTiming,
  releaseLedgerLock,
} from "./ledger-lock.js";

/**
 * Ką daryti, kai lock'o nepavyko gauti per deadline'ą. Politika PRIKLAUSO NUO FAILO — dvi
 * ledger'io klasės klysta į priešingas puses:
 *
 * - `"drop"` (`session-writes.json`): prarandame TIK savo įrašą, bet niekada nesugadiname kitų
 *   procesų įrašų. Neatominis fallback rašymas čia buvo tyliai lossy.
 * - `"unlocked-append"` (`readme-read-events.json`): prarastas įrašas UŽDARO readme-guard vartus
 *   grandinės viduryje, o agentas jų atidaryti nebegali — to failo rašymas per įrankius
 *   uždraustas. Todėl čia geriau vis tiek bandyti (atominiu rename, tad skaitytojas niekada
 *   nemato apkirpto JSON) nei praleisti įrašą.
 */
export type LockTimeoutPolicy = "drop" | "unlocked-append";

export type JsonArrayAppendResult = {
  /** `true` kai kelias garantuotai yra faile — įrašytas dabar arba jau buvo. */
  appended: boolean;
  /**
   * `true`, kai įrašas faile JAU buvo, t. y. šis kvietimas nieko nepridėjo. Kvietėjas iš to
   * sprendžia, ar reikšmė matoma PIRMĄ kartą (brangi klasifikacija daroma tik tada). Prasminga
   * tik kai `appended === true`.
   */
  alreadyPresent: boolean;
  /**
   * Kiek ms iš viso praleista funkcijoje (laukimas + kritinė sekcija). Eina į klaidos eilutę,
   * kad apkrova būtų matuojama; nesėkmės kelyje tai yra grynas lock'o laukimas.
   */
  waitedMs: number;
  /** Kodėl praradome įrašą. Yra TIK kai `appended === false`. */
  failure?: string;
  /** `true`, kai įrašas atsirado BE lock'o (`"unlocked-append"` politika po deadline'o). */
  degraded?: boolean;
  /**
   * Kodėl nepavyko šalutinis `withinLock` rašymas (nuosavybės sidecar'as). ATSKIRAS nuo
   * `failure` sąmoningai: pats įrašas ledger'yje YRA, tad `ledger_append_failed=1` — grep'inama
   * „necommit'into darbo" žymė — čia meluotų. Prarastas savininkas kelią tik grąžina į saugią
   * „legacy" būseną (jis lieka stage'inamas), o ne prarandamas.
   */
  ownerFailure?: string;
};

export type JsonArrayAppendOptions = {
  lockWaitMs?: number;
  onLockTimeout?: LockTimeoutPolicy;
  /**
   * Kviečiama TOJE PAČIOJE kritinėje sekcijoje, jau po pagrindinio rašymo. Skirta šalutiniam
   * įrašui, kuris privalo būti serializuotas kartu su ledger'iu (nuosavybės sidecar'as) —
   * atskiras lock'as leistų dviem rašytojams pamatyti skirtingas dviejų failų versijas.
   */
  withinLock?: () => Promise<void>;
};

async function readLedgerEntries(fs: LedgerFsPort, filePath: string): Promise<string[]> {
  return parseJsonStringArray(await fs.readTextFileIfExists(filePath));
}

/**
 * Prideda vieną reikšmę į JSON string masyvo failą atominiu (serializuotu + rename) būdu.
 *
 * Etalono task 0047 (`session-writes.json`) ir 0056 (`readme-read-events.json`): abu failai buvo
 * `read - push - write` be jokios serializacijos, ir laimėdavo paskutinis rašytojas — anksčiau
 * užregistruoti įrašai dingdavo, o `writeFile` truncate lange fail-closed skaitytojas matydavo
 * korumpuotą JSON. Vienas mechanizmas abiem, nes tai lygiai ta pati klaidų klasė.
 *
 * `lockWaitMs` egzistuoja tik tam, kad testas įrodytų deadline išsekimo kelią nelaukdamas 15 s
 * realaus laiko; produkciniai kviečiantieji visada naudoja numatytąjį.
 */
export async function appendJsonArrayEntry(
  fs: LedgerFsPort,
  filePath: string,
  entry: string,
  options: JsonArrayAppendOptions = {},
): Promise<JsonArrayAppendResult> {
  const lockWaitMs = options.lockWaitMs ?? ledgerLockTiming.timeoutMs;
  const onLockTimeout = options.onLockTimeout ?? "drop";
  const lockPath = `${filePath}.lock`;
  const startedAt = Date.now();
  const waitedMs = (): number => Date.now() - startedAt;

  try {
    await fs.makeDirectory(path.dirname(filePath));
  } catch (error) {
    // Ir šis kelias privalo grįžti, o ne mesti: PostToolUse hook'e exit 2 reiškia UŽBLOKUOTĄ
    // tool call'ą. Neegzistuojantis ar užimtas state katalogas negali sustabdyti darbo — jis tik
    // virsta garsia log eilute.
    return {
      appended: false,
      alreadyPresent: false,
      waitedMs: waitedMs(),
      failure: `ledger dir unavailable: ${ledgerErrorText(error)}`,
    };
  }

  // Lock-free fast path. Read yra dažniausias tool call'as sesijoje, o po pirmo karto įrašas
  // faile jau yra — tada `wx - read - rm` ciklas nieko nekeičia, tik kainuoja. Saugu dėl
  // monotoniškumo: masyvas tik auga (įrašai niekada netrinami po vieną), tad „matau įrašą" yra
  // galutinis atsakymas. Praleidžiama TIK be `withinLock`: šalutinis rašymas (nuosavybė) privalo
  // vykti ir tada, kai pats kelias ledger'yje jau buvo.
  if (!options.withinLock && (await readLedgerEntries(fs, filePath)).includes(entry)) {
    return { appended: true, alreadyPresent: true, waitedMs: waitedMs() };
  }

  const token = await acquireLedgerLock(fs, lockPath, startedAt + lockWaitMs);
  if (!token) {
    if (onLockTimeout === "drop") {
      return {
        appended: false,
        alreadyPresent: false,
        waitedMs: waitedMs(),
        failure: `lock not acquired within ${lockWaitMs}ms`,
      };
    }
    // Fail-open šaka: rašoma VIS TIEK, bet tuo pačiu atominiu rename — lygiagretus rašytojas
    // blogiausiu atveju pameta vieną įrašą, bet niekada nemato apkirpto JSON.
    const degraded = await writeEntryUnlocked(fs, filePath, entry, options.withinLock);
    return { ...degraded, waitedMs: waitedMs(), degraded: true };
  }

  let outcome: JsonArrayAppendResult;
  try {
    const entries = await readLedgerEntries(fs, filePath);
    const alreadyPresent = entries.includes(entry);
    if (!alreadyPresent) {
      entries.push(entry);
      // Atominis rašymas: dalinai įrašytas failas niekada nepasiekia skaitytojų (Stop hook,
      // package-guard, fail-closed pre-write vartai), kurie skaito be lock'o.
      await fs.writeTextFile(filePath, toPrettyJson(entries));
    }
    outcome = { appended: true, alreadyPresent, waitedMs: waitedMs() };
    // PO pagrindinio rašymo ir su ATSKIRU rezultatu: šalutinio įrašo gedimas nepaverčia pavykusio
    // ledger'io append'o „prarastu darbu".
    const ownerFailure = await runWithinLock(options.withinLock);
    if (ownerFailure !== undefined) outcome = { ...outcome, ownerFailure };
  } catch (error) {
    outcome = {
      appended: false,
      alreadyPresent: false,
      waitedMs: waitedMs(),
      failure: `ledger write failed: ${ledgerErrorText(error)}`,
    };
  }

  // Serializacija galiojo tik tol, kol lock'as buvo mūsų. Praradę jį rašymo metu negalime
  // tvirtinti, kad įrašas išliko — tokį append'ą skelbiame nepavykusiu, o ne tyliai sėkmingu.
  if ((await releaseLedgerLock(fs, lockPath, token)) === "stolen") {
    return {
      appended: false,
      alreadyPresent: false,
      waitedMs: waitedMs(),
      failure: `${outcome.failure ?? "ledger written"}; lock was reclaimed by another writer mid-append`,
    };
  }
  return outcome;
}

/** `undefined` = pavyko (arba nėra ko daryti); kitu atveju — priežastis. Niekada nemeta. */
async function runWithinLock(withinLock: (() => Promise<void>) | undefined): Promise<string | undefined> {
  if (!withinLock) return undefined;
  try {
    await withinLock();
    return undefined;
  } catch (error) {
    return ledgerErrorText(error);
  }
}

async function writeEntryUnlocked(
  fs: LedgerFsPort,
  filePath: string,
  entry: string,
  withinLock: (() => Promise<void>) | undefined,
): Promise<Omit<JsonArrayAppendResult, "waitedMs">> {
  try {
    const entries = await readLedgerEntries(fs, filePath);
    const alreadyPresent = entries.includes(entry);
    if (!alreadyPresent) {
      entries.push(entry);
      await fs.writeTextFile(filePath, toPrettyJson(entries));
    }
    // Ir degradavusioje šakoje: ledger'io įrašas be savininko reikštų, kad kelias tyliai nukrinta
    // į „legacy" būseną, nors jo tapatybė buvo žinoma.
    const ownerFailure = await runWithinLock(withinLock);
    return { appended: true, alreadyPresent, ...(ownerFailure === undefined ? {} : { ownerFailure }) };
  } catch (error) {
    return {
      appended: false,
      alreadyPresent: false,
      failure: `unlocked ledger write failed: ${ledgerErrorText(error)}`,
    };
  }
}

/** Sugadintas ar ne objekto formos sidecar'as — tuščias žemėlapis (savigyda, ne nutylėjimas). */
function parseOwners(raw: string | undefined): SessionWriteOwners {
  if (raw === undefined) return {};
  const parsed = tryParseJson<unknown>(raw);
  if (!parsed.ok) return {};
  const value = parsed.value;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  return value as SessionWriteOwners;
}

/**
 * Užrašo, kuri sesija rašė kelią. Kviečiama TIK ledger'io lock'o viduje (žr.
 * {@link JsonArrayAppendOptions.withinLock}): atskiras lock'as leistų dviem rašytojams matyti
 * skirtingas dviejų failų versijas. Sprendimas, ką įrašyti, yra GRYNAS —
 * `mergeSessionWriteOwner` application sluoksnyje; čia lieka skaitymas ir atominis rašymas.
 */
export async function recordSessionWriteOwner(
  fs: LedgerFsPort,
  ownersPath: string,
  entry: string,
  identity: SessionWriteIdentity,
): Promise<void> {
  const current = parseOwners(await fs.readTextFileIfExists(ownersPath));
  const merged = mergeSessionWriteOwner(current, entry, identity);
  if (!merged) return;

  await fs.writeTextFile(ownersPath, toPrettyJson({ ...current, [merged.key]: merged.owner }));
}

/**
 * Išvalo per-TASK ledger'į ir jo palydovus PO TUO PAČIU lock'u, kurį naudoja hook'ai.
 *
 * Be lock'o task aktyvacijos trynimas lenktyniavo su lygiagrečios sesijos `read - push - rename`:
 * pralaimėjęs trynimas grąžindavo svetimą įrašą į ką tik išvalytą ledger'į, o laimėjęs paliktų
 * sidecar'ą rodyti į nebeegzistuojančius kelius.
 *
 * Nemeta ir niekada neblokuoja task'o starto: neįgijus lock'o valymas VIS TIEK atliekamas
 * (task'as be išvalyto ledger'io stage'intų praeito task'o rašymus — tai blogesnis gedimas nei
 * lenktynės), bet grąžinamas `locked: false`, kad kvietėjas tai garsiai užlogintų.
 */
export async function clearSessionWriteLedger(
  fs: LedgerFsPort,
  sessionWritesPath: string,
  extraPaths: readonly string[] = [],
  lockWaitMs: number = ledgerLockTiming.timeoutMs,
): Promise<{ locked: boolean; failure?: string }> {
  const lockPath = `${sessionWritesPath}.lock`;
  const targets = [sessionWritesPath, sessionWriteOwnersPath(sessionWritesPath), ...extraPaths];
  const token = await acquireLedgerLock(fs, lockPath, Date.now() + lockWaitMs);

  let failure: string | undefined;
  try {
    for (const target of targets) {
      await fs.removeFile(target);
    }
  } catch (error) {
    failure = `ledger clear failed: ${ledgerErrorText(error)}`;
  }

  if (token && (await releaseLedgerLock(fs, lockPath, token)) === "stolen") {
    failure = `${failure ?? "ledger cleared"}; lock was reclaimed by another writer mid-clear`;
  }
  return { locked: token !== undefined, ...(failure === undefined ? {} : { failure }) };
}
