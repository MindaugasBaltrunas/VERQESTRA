// Task failų perkėlimas tarp bucket'ų PO LOCK'U (etalonas: AG_loop orchestrator/loop/task-state.ts
// perkėlimų pusė).
//
// Kodėl lock'as apskritai: task'o failas yra jo BŪSENA. Du procesai, judinantys tą patį failą
// (loop'as ir operatoriaus CLI, arba du worker'iai), be serializacijos vieną iš perkėlimų
// praranda — failas atsiduria ne tame bucket'e, kurį rodo ledger'is, o kitas ratas jį
// dispatch'ina iš naujo.
//
// Kodėl KATALOGO lock'as, o ne failo: `mkdir` be `recursive` yra atominis „sukurk arba klysk"
// primityvas visose platformose. Perėmimo algoritmas bendras su ledger'io lock'u
// (`shared/lock-steal`), bet čia lock'as yra katalogas (valymas rekursinis), o tapatybė —
// `owner.json` `lock_id`.
//
// Nuosavybės vartai (`assertAuthority`) ateina PARAMETRU: kas turi teisę judinti task'ą, sprendžia
// application/scheduling, o ne failų sistema.

import { randomUUID } from "node:crypto";
import path from "node:path";
import { isTaskBucket, normalizeTerminalBucket } from "../../domain/tasks/buckets.js";
import { stealStaleLock } from "../../shared/lock-steal.js";
import { isAlreadyExistsError, isErrnoCode, toError } from "../../shared/errors.js";
import { toPrettyJson, tryParseJson } from "../../shared/json.js";
import { nodeFsAdapter } from "../fs/node-fs-adapter.js";
import { appendStateHistory, stateHistoryPath } from "./state-history.js";

/**
 * - `staleMs` (30 s): kritinė sekcija yra vienas `rename`, tad 30 s be pažangos praktiškai reiškia
 *   kritusį procesą.
 * - `timeoutMs` (45 s) > `staleMs`: kitaip kritusio proceso lock'as išnaudotų mūsų deadline'ą dar
 *   nespėjus jo perimti.
 * - `minRetryMs`/`maxRetryMs` su PILNU jitter'iu: vienu metu startavę laukėjai kitaip liktų fazėje.
 * - `readAttempts`/`readRetryMs`: `owner.json` skaitymo retry win32 contention atveju. Langas mažas
 *   sąmoningai — tai ne laukimas eilėje, o vieno syscall'o pakartojimas, kol konkurentas baigia
 *   trinti katalogą. Ilgesnis retry čia tik pailgintų kritinės sekcijos laukimą nieko neišsprendęs:
 *   jei po trijų bandymų kelias vis dar neįskaitomas, atsakymas yra „nežinia", ir jis saugus.
 */
export const taskMoveLockTiming = {
  staleMs: 30_000,
  timeoutMs: 45_000,
  minRetryMs: 20,
  maxRetryMs: 100,
  readAttempts: 3,
  readRetryMs: 5,
} as const;

/** Kiek kolizijos kandidatų bandoma prieš pasiduodant (`task.md`, `task-2.md`, ...). */
const MAX_COLLISION_CANDIDATES = 100;

type TaskMoveLock = {
  lock_id: string;
  pid: number;
  created_at: string;
  operation: string;
};

export type TaskStateStoreDeps = {
  /** `<repo>/AG` — task bucket'ai ir lock'as gyvena po juo. */
  agRoot: string;
  /** vq runtime šaknis — `current-task-*` žymės. */
  runtimeRoot: string;
  /**
   * Nuosavybės vartai prieš KIEKVIENĄ perkėlimą. Meta, kai teisės nebėra — failų sistema tokio
   * sprendimo priimti negali.
   */
  assertAuthority?: (taskId: string) => Promise<void>;
};

function lockDirOf(deps: TaskStateStoreDeps): string {
  return path.join(deps.agRoot, "state", "task-move.lock");
}

function ownerFile(lockDir: string): string {
  return path.join(lockDir, "owner.json");
}

/**
 * Lock'o savininko skaitymo baigtis. TRYS būsenos, o ne dvi, nes „lock'o nėra" ir „lock'o
 * perskaityti nepavyko" yra PRIEŠINGI atsakymai atlaisvinimo klausimui: pirmas leidžia trinti,
 * antras — draudžia. Sulieti juos į `undefined` reiškia, kad laikina skaitymo klaida virsta
 * svetimo lock'o trynimu, t. y. tuo pačiu trečiu rašytoju, kurio šis modulis ir saugosi.
 */
export type TaskMoveLockRead =
  | { state: "owned"; lock: TaskMoveLock }
  | { state: "absent" }
  | { state: "unreadable" };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * `owner.json` skaitymas, kuris NIEKADA nemeta.
 *
 * Tai ne patogumas, o `shared/lock-steal` `readIdentity` KONTRAKTAS („NIEKADA nemeta:
 * neįskaitomas lock'as = undefined"). Ankstesnė realizacija jį pažeidė: ji rėmėsi
 * `readTextFileIfExists`, kuris sąmoningai praleidžia tik ENOENT/EISDIR/ENOTDIR, o win32
 * delete-pending langas tą pačią lenktynę pateikia kaip EPERM. Rezultatas — `stealStaleLock`
 * krisdavo per patį pirmą savo žingsnį, ir tai matydavosi tik pilnoje testų serijoje, kur
 * lenktynės langas platesnis (izoliuotai testas praeidavo visada).
 *
 * Contention formos kartojamos trumpai (`readAttempts`), nes jos praeina pačios; visa kita —
 * įskaitant POSIX teisių klaidą ir sugadintą JSON — virsta `unreadable`. Sugadintas turinys
 * čia SĄMONINGAI nebėra „nėra savininko": įrodyti nuosavybės jis neleidžia lygiai taip pat,
 * kaip ir neperskaitytas failas, o toks lock'as vis tiek bus atgautas per stale ribą.
 */
async function readTaskMoveLockState(lockDir: string): Promise<TaskMoveLockRead> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const raw = await nodeFsAdapter.readTextFileIfExists(ownerFile(lockDir));
      if (raw === undefined) return { state: "absent" };
      const parsed = tryParseJson<TaskMoveLock>(raw);
      return parsed.ok ? { state: "owned", lock: parsed.value } : { state: "unreadable" };
    } catch (error: unknown) {
      if (!isLockContentionError(error) || attempt >= taskMoveLockTiming.readAttempts) {
        return { state: "unreadable" };
      }
      await sleep(taskMoveLockTiming.readRetryMs);
    }
  }
}

/** Tapatybė `lock-steal` kontraktui: neįskaitomas IR nesamas lock'as vienodai — `undefined`. */
async function readTaskMoveLock(lockDir: string): Promise<TaskMoveLock | undefined> {
  const read = await readTaskMoveLockState(lockDir);
  return read.state === "owned" ? read.lock : undefined;
}

function lockAgeMs(lock: TaskMoveLock | undefined, fallbackMtimeMs: number, now: number): number {
  if (!lock?.created_at) return now - fallbackMtimeMs;
  const createdAt = new Date(lock.created_at).getTime();
  return Number.isNaN(createdAt) ? now - fallbackMtimeMs : now - createdAt;
}

/**
 * Kritusio proceso lock'o perėmimas. Bendras TOCTOU-saugus algoritmas gyvena `shared/lock-steal`;
 * čia lieka tik tai, kas specifiška: lock'as yra KATALOGAS (valymas rekursinis), tapatybė —
 * `lock_id`, o perėmus ne tą tapatybę katalogas GRĄŽINAMAS, o ne sunaikinamas.
 */
async function stealStaleTaskMoveLock(lockDir: string): Promise<void> {
  await stealStaleLock<TaskMoveLock>({
    lockPath: lockDir,
    statMtimeMs: (target) => nodeFsAdapter.directoryModifiedAtMs(target),
    createStealPath: () => `${lockDir}.stale-${randomUUID()}`,
    readIdentity: readTaskMoveLock,
    isStale: (lock, mtimeMs) => lockAgeMs(lock, mtimeMs, Date.now()) > taskMoveLockTiming.staleMs,
    isForeign: (observed, stolen) =>
      observed !== undefined && stolen !== undefined && stolen.lock_id !== observed.lock_id,
    rename: (from, to) => nodeFsAdapter.renamePath(from, to),
    exists: (target) => nodeFsAdapter.exists(target),
    // Naujasis savininkas praradimą pamato pats: atlaisvindamas savo `lock_id` neberas.
    remove: async (target) => await nodeFsAdapter.removeDirectory(target).catch(() => undefined),
  });
}

/**
 * Ar atlaisvinant lock'ą jį galima TRINTI. Gryna, nes tai vienintelė vieta, kur klaida yra
 * neatstatoma: klaidingai ištrintas svetimas lock'as įleidžia TREČIĄ rašytoją į kritinę sekciją.
 *
 * `unreadable` → `keep`. Neperskaitytas savininkas gali būti tas, kuris mūsų lock'ą ką tik perėmė
 * kaip stale; jo trynimas būtų būtent ta klaida. Neatlaisvintas lock'as nieko neužrakina visam
 * laikui — jį atgaus stale riba (`staleMs`), o klaidingai ištrintas neatgaunamas niekaip.
 *
 * `absent` → `keep` (2026-09-05 audito F6). Anksčiau čia buvo `release`, ir tai atrodė nekaltai
 * („nėra ko trinti"), bet atlaisvinimas yra REKURSINIS katalogo `rm`, o ne failo `unlink`, ir
 * tarp skaitymo bei trynimo telpa visas perėmimo langas: A stovi ilgiau nei `staleMs` → B perima
 * lock'ą (`rename` į stale kelią, savo `mkdir`), bet `owner.json` dar neįrašė; A `finally`
 * perskaito `absent` ir nušluoja B KATALOGĄ; C laimi tuščią vardą, ir kritinėje sekcijoje
 * atsiduria du. Tai ta pati taisyklė, kurią `shared/owned-lock` formuluoja žodžiais „nežinia NĖRA
 * leidimas trinti" — čia ji tik nebuvo pritaikyta nesamam vardui.
 *
 * Kaina: nepavykęs `owner.json` rašymas palieka tuščią lock'o katalogą iki stale ribos vietoje
 * greito išvalymo. Tai priimta sąmoningai ir dėl tos pačios priežasties kaip `unreadable`:
 * pavėluotas atgavimas atsistato pats, klaidingas trynimas — ne.
 */
export function taskMoveLockReleaseDecision(read: TaskMoveLockRead, ourLockId: string): "release" | "keep" {
  if (read.state === "unreadable") return "keep";
  if (read.state === "absent") return "keep";
  return read.lock.lock_id === ourLockId ? "release" : "keep";
}

async function releaseTaskMoveLock(lockDir: string, lock: TaskMoveLock): Promise<void> {
  const current = await readTaskMoveLockState(lockDir);
  if (taskMoveLockReleaseDecision(current, lock.lock_id) === "release") {
    await nodeFsAdapter.removeDirectory(lockDir).catch(() => undefined);
  }
}

function jitteredBackoff(backoffMs: number): number {
  const spread = backoffMs - taskMoveLockTiming.minRetryMs;
  return taskMoveLockTiming.minRetryMs + (spread > 0 ? Math.floor(Math.random() * (spread + 1)) : 0);
}

/**
 * Lock contention formos. POSIX pralaimėtą `mkdir` lenktynę signalizuoja `EEXIST`; Windows tą patį
 * gali pateikti kaip laikiną EPERM/EACCES/EBUSY, kai konkurentas kaip tik atlaisvina katalogą. Tie
 * kodai yra contention TIK win32 — kitur teisių klaida yra tikras gedimas ir privalo mesti.
 */
export function isLockContentionError(error: unknown, platform: NodeJS.Platform = process.platform): boolean {
  if (isAlreadyExistsError(error)) return true;
  if (platform !== "win32") return false;
  return isErrnoCode(error, "EPERM") || isErrnoCode(error, "EACCES") || isErrnoCode(error, "EBUSY");
}

function candidateCollisionPath(preferredPath: string, index: number): string {
  if (index === 1) return preferredPath;
  const parsed = path.parse(preferredPath);
  return path.join(parsed.dir, `${parsed.name}-${index}${parsed.ext}`);
}

async function uniquePathUnderLock(preferredPath: string): Promise<string> {
  for (let index = 1; index <= MAX_COLLISION_CANDIDATES; index += 1) {
    const candidate = candidateCollisionPath(preferredPath, index);
    if (!(await nodeFsAdapter.exists(candidate))) return candidate;
  }
  throw new Error(`Unable to allocate unique task path for ${preferredPath}`);
}

async function withTaskMoveLock<T>(deps: TaskStateStoreDeps, operationName: string, operation: () => Promise<T>): Promise<T> {
  const lockDir = lockDirOf(deps);
  const deadlineAtMs = Date.now() + taskMoveLockTiming.timeoutMs;
  let backoffMs: number = taskMoveLockTiming.minRetryMs;

  for (;;) {
    const lock: TaskMoveLock = {
      lock_id: randomUUID(),
      pid: process.pid,
      created_at: new Date().toISOString(),
      operation: operationName,
    };

    let acquired = false;
    try {
      await nodeFsAdapter.makeDirectory(path.dirname(lockDir));
      acquired = (await nodeFsAdapter.createLockDirectory(lockDir)) === "created";
    } catch (error) {
      // Contention klasifikuojama TIK ties lock'o paėmimu: kitaip win32 EPERM ties `rename` atrodytų
      // kaip užimtas lock'as ir perkėlimas būtų tyliai kartojamas.
      if (!isLockContentionError(error)) throw error;
    }

    if (acquired) {
      try {
        await nodeFsAdapter.writeTextFile(ownerFile(lockDir), toPrettyJson(lock));
        // Nuosavybės PERTIKRINIMAS po paėmimo: jei kas nors perėmė mūsų katalogą kaip stale ir
        // įrašė savo `owner.json`, lock'o nebeturime ir į kritinę sekciją įeiti negalime.
        const confirmed = await readTaskMoveLock(lockDir);
        if (confirmed?.lock_id === lock.lock_id) {
          return await operation();
        }
      } finally {
        await releaseTaskMoveLock(lockDir, lock);
      }
    } else {
      await stealStaleTaskMoveLock(lockDir);
    }

    const remainingMs = deadlineAtMs - Date.now();
    if (remainingMs <= 0) {
      throw new Error(`Timed out waiting for task move lock after ${taskMoveLockTiming.timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(jitteredBackoff(backoffMs), remainingMs)));
    backoffMs = Math.min(backoffMs * 2, taskMoveLockTiming.maxRetryMs);
  }
}

/**
 * Tikslinis katalogas pagal DOMAIN terminalinio bucket'o taisyklę: perkėlimas į `failed` nusileidžia
 * į `human-review`. Ne bucket'ų katalogai ir bucket'ai be perrašymo grąžinami nepaliesti.
 */
function normalizeTerminalTaskDir(toDir: string): string {
  const bucket = path.basename(toDir);
  if (!isTaskBucket(bucket)) return toDir;
  const normalized = normalizeTerminalBucket(bucket);
  return normalized === bucket ? toDir : path.join(path.dirname(toDir), normalized);
}

function taskIdFromName(taskName: string): string {
  return path.basename(taskName).replace(/\.md$/i, "");
}

function currentTaskFilePath(deps: TaskStateStoreDeps): string {
  return path.join(deps.runtimeRoot, "state", "current-task-file");
}

async function setCurrentTaskFile(deps: TaskStateStoreDeps, filePath: string): Promise<void> {
  await nodeFsAdapter.writeTextFile(currentTaskFilePath(deps), `${filePath}\n`);
}

/**
 * Compare-and-clear (126): išvalo `current-task-file` žymę TIK jei jos turinys ŠIUO METU rodo į
 * `expectedFilePath`. Besąlyginis trynimas ištrintų lygiagretaus slot'o ką tik aktyvuoto task'o
 * žymę — čia tikrinama tapatybė prieš kiekvieną trynimą, kaip ir lock'o atlaisvinime
 * ({@link taskMoveLockReleaseDecision}).
 */
async function clearCurrentTaskFileIfMatches(deps: TaskStateStoreDeps, expectedFilePath: string): Promise<boolean> {
  const markerPath = currentTaskFilePath(deps);
  const current = await nodeFsAdapter.readTextFileIfExists(markerPath);
  if (current?.trim() !== expectedFilePath) return false;
  await nodeFsAdapter.removeIfExists(markerPath);
  return true;
}

/** Ką rašyti į `state-history.json` po perkėlimo; `reason` be reikšmės — `operationName`. */
type StateHistoryIntent = { taskId: string; reason?: string };

/**
 * Perėjimo baigtis bucket'ų kalba. Etalono `resolveHumanReviewStatus` skaito TIK šį lauką:
 * `"routed"` atveria peržiūrą, `"resolved"` ją uždaro. Todėl abi kryptys privalo būti
 * rašomos — vien „resolved" paverstų mirusį kanalą meluojančiu: kartą atblokuotas, o paskui
 * vėl į `human-review` nuleistas task'as amžinai liktų „resolved" ir nustotų blokuoti
 * `final-audit`.
 */
function stateHistoryResult(previousFolder: string, nextFolder: string): string {
  if (nextFolder === "human-review") return "routed";
  if (previousFolder === "human-review") return "resolved";
  return "moved";
}

/**
 * Įvykio įrašas PO sėkmingo `rename` ir dar LOCK'O VIDUJE: `appendStateHistory` yra
 * read-modify-write be savo lock'o, tad serializuoja jį būtent `task-move.lock`.
 *
 * Bucket'ai imami iš REALIŲ kelių, ne iš prašyto `toDir`: `normalizeTerminalTaskDir`
 * perrašo `failed` → `human-review`, ir prašymu paremtas įrašas prarastų būtent tą
 * `"routed"` įvykį, dėl kurio kanalas ir egzistuoja.
 *
 * Nesėkmė perkėlimo NEATŠAUKIA: failas jau perkeltas, o istorija yra stebėjimo kanalas.
 * Bet ji ir nenutylima — `readStateHistory` sugadintam JSON yra fail-closed (meta), tad
 * tylus praleidimas paliktų visą kanalą užsivėrusį be nė vieno pėdsako.
 */
async function recordStateHistoryMove(
  deps: TaskStateStoreDeps,
  from: string,
  to: string,
  intent: StateHistoryIntent,
  operationName: string,
): Promise<void> {
  const previousFolder = path.basename(path.dirname(from));
  const nextFolder = path.basename(path.dirname(to));
  try {
    await appendStateHistory(stateHistoryPath(deps.runtimeRoot), {
      task_id: intent.taskId,
      previous_folder: previousFolder,
      next_folder: nextFolder,
      result: stateHistoryResult(previousFolder, nextFolder),
      reason: intent.reason ?? operationName,
    });
  } catch (error: unknown) {
    process.stderr.write(`[task-state-store] state-history append failed: ${toError(error).message}\n`);
  }
}

async function moveWithUniqueName(
  deps: TaskStateStoreDeps,
  from: string,
  preferredTo: string,
  history?: StateHistoryIntent,
): Promise<string> {
  const operationName = `move ${from} -> ${preferredTo}`;
  return await withTaskMoveLock(deps, operationName, async () => {
    if (!(await nodeFsAdapter.exists(from))) throw new Error(`Unique move source file does not exist: ${from}`);
    const target = await uniquePathUnderLock(preferredTo);
    await nodeFsAdapter.renamePath(from, target);
    if (history !== undefined) await recordStateHistoryMove(deps, from, target, history, operationName);
    return target;
  });
}

export type MoveTaskOptions = {
  updateCurrent?: boolean;
  /** `state-history` įrašo priežastis; be jos — perkėlimo operacijos vardas. */
  reason?: string;
};

/** `TaskStateStorePort` realizacija: perkėlimai, užvėrimas ir aktyvavimas. */
export function createTaskStateStore(deps: TaskStateStoreDeps): {
  moveTaskState(from: string, toDir: string, taskName: string, options?: MoveTaskOptions): Promise<string>;
  finishTaskState(
    from: string,
    toDir: string,
    taskName: string,
    cleanupFiles: string[],
    options?: MoveTaskOptions,
  ): Promise<string>;
  activateTaskFile(taskFile: string, activeFile: string, taskId: string): Promise<string>;
  readTaskText(absolutePath: string): Promise<string | undefined>;
  writeTaskText(absolutePath: string, text: string): Promise<void>;
  /** Compare-and-clear `current-task-file` žymei; `true`, kai ji realiai išvalyta. */
  clearCurrentTaskFile(expectedFilePath: string): Promise<boolean>;
} {
  const assertAuthority = async (taskId: string): Promise<void> => {
    await deps.assertAuthority?.(taskId);
  };

  return {
    async moveTaskState(from, toDir, taskName, options = {}) {
      const taskId = taskIdFromName(taskName);
      await assertAuthority(taskId);
      const targetDir = normalizeTerminalTaskDir(toDir);
      await nodeFsAdapter.makeDirectory(targetDir);
      const to = await moveWithUniqueName(deps, from, path.join(targetDir, taskName), {
        taskId,
        ...(options.reason === undefined ? {} : { reason: options.reason }),
      });
      if (options.updateCurrent ?? true) await setCurrentTaskFile(deps, to);
      return to;
    },

    // Istorija rašoma ir ČIA, ne tik `moveTaskState`: būtent šiuo keliu task'as ĮEINA į
    // `human-review` (koordinatoriaus finish, tuščios eilės ir bangos integracijos adapteriai).
    // Rašant tik išėjimą, kartą atblokuotas ir vėl nuleistas task'as liktų „resolved" ir
    // nustotų blokuoti `final-audit` — kanalas ne miręs, o meluojantis.
    async finishTaskState(from, toDir, taskName, cleanupFiles = [], options = {}) {
      const taskId = taskIdFromName(taskName);
      await assertAuthority(taskId);
      const targetDir = normalizeTerminalTaskDir(toDir);
      await nodeFsAdapter.makeDirectory(targetDir);
      const to = await moveWithUniqueName(deps, from, path.join(targetDir, taskName), {
        taskId,
        ...(options.reason === undefined ? {} : { reason: options.reason }),
      });
      for (const cleanupFile of cleanupFiles) {
        // Šaltinio ir taikinio NIEKADA nevalome: pirmasis jau perkeltas, antrasis yra rezultatas.
        if (cleanupFile !== from && cleanupFile !== to) await nodeFsAdapter.removeIfExists(cleanupFile);
      }
      // Ta pati parinktis kaip `moveTaskState`: svetimo slot'o užbaigimas žymės neperrašo.
      if (options.updateCurrent ?? true) await setCurrentTaskFile(deps, to);
      return to;
    },

    // Turinio prieiga bucket-transition preambulės nuėmimui (092). Be lock'o sąmoningai:
    // kritinę sekciją saugo pats move'as, o strip yra idempotentiškas — pralaimėta lenktynė
    // blogiausiu atveju palieka turinį, kurį nuims kitas perėjimas.
    async readTaskText(absolutePath) {
      return await nodeFsAdapter.readTextFileIfExists(absolutePath);
    },

    async writeTaskText(absolutePath, text) {
      await nodeFsAdapter.writeTextFile(absolutePath, text);
    },

    async activateTaskFile(taskFile, activeFile, taskId) {
      await assertAuthority(taskId);
      // NUKRYPIMAS (griežtinantis): tikslinis katalogas sukuriamas ČIA. Etalone jis egzistavo dėl
      // globalaus `ensureDirs()` starto metu, tad aktyvavimas turėjo paslėptą tvarkos
      // priklausomybę — švariame checkout'e pirmas aktyvavimas krisdavo su ENOENT.
      await nodeFsAdapter.makeDirectory(path.dirname(activeFile));
      const to = await moveWithUniqueName(deps, taskFile, activeFile);
      await nodeFsAdapter.writeTextFile(path.join(deps.runtimeRoot, "state", "current-task-id"), `${taskId}\n`);
      await setCurrentTaskFile(deps, to);
      return to;
    },

    clearCurrentTaskFile: (expectedFilePath) => clearCurrentTaskFileIfMatches(deps, expectedFilePath),
  };
}
