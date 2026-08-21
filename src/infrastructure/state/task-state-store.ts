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
import { isAlreadyExistsError, isErrnoCode } from "../../shared/errors.js";
import { toPrettyJson, tryParseJson } from "../../shared/json.js";
import { nodeFsAdapter } from "../fs/node-fs-adapter.js";

/**
 * - `staleMs` (30 s): kritinė sekcija yra vienas `rename`, tad 30 s be pažangos praktiškai reiškia
 *   kritusį procesą.
 * - `timeoutMs` (45 s) > `staleMs`: kitaip kritusio proceso lock'as išnaudotų mūsų deadline'ą dar
 *   nespėjus jo perimti.
 * - `minRetryMs`/`maxRetryMs` su PILNU jitter'iu: vienu metu startavę laukėjai kitaip liktų fazėje.
 */
export const taskMoveLockTiming = {
  staleMs: 30_000,
  timeoutMs: 45_000,
  minRetryMs: 20,
  maxRetryMs: 100,
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

async function readTaskMoveLock(lockDir: string): Promise<TaskMoveLock | undefined> {
  const raw = await nodeFsAdapter.readTextFileIfExists(ownerFile(lockDir));
  if (raw === undefined) return undefined;
  const parsed = tryParseJson<TaskMoveLock>(raw);
  return parsed.ok ? parsed.value : undefined;
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

async function releaseTaskMoveLock(lockDir: string, lock: TaskMoveLock): Promise<void> {
  const current = await readTaskMoveLock(lockDir);
  // Besąlyginis trynimas įleistų TREČIĄ rašytoją, jei mūsų lock'ą kas nors jau perėmė kaip stale.
  if (!current || current.lock_id === lock.lock_id) {
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
function isLockContentionError(error: unknown, platform: NodeJS.Platform = process.platform): boolean {
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

async function setCurrentTaskFile(deps: TaskStateStoreDeps, filePath: string): Promise<void> {
  await nodeFsAdapter.writeTextFile(path.join(deps.runtimeRoot, "state", "current-task-file"), `${filePath}\n`);
}

async function moveWithUniqueName(deps: TaskStateStoreDeps, from: string, preferredTo: string): Promise<string> {
  return await withTaskMoveLock(deps, `move ${from} -> ${preferredTo}`, async () => {
    if (!(await nodeFsAdapter.exists(from))) throw new Error(`Unique move source file does not exist: ${from}`);
    const target = await uniquePathUnderLock(preferredTo);
    await nodeFsAdapter.renamePath(from, target);
    return target;
  });
}

export type MoveTaskOptions = { updateCurrent?: boolean };

/** `TaskStateStorePort` realizacija: perkėlimai, užvėrimas ir aktyvavimas. */
export function createTaskStateStore(deps: TaskStateStoreDeps): {
  moveTaskState(from: string, toDir: string, taskName: string, options?: MoveTaskOptions): Promise<string>;
  finishTaskState(from: string, toDir: string, taskName: string, cleanupFiles: string[]): Promise<string>;
  activateTaskFile(taskFile: string, activeFile: string, taskId: string): Promise<string>;
} {
  const assertAuthority = async (taskId: string): Promise<void> => {
    await deps.assertAuthority?.(taskId);
  };

  return {
    async moveTaskState(from, toDir, taskName, options = {}) {
      await assertAuthority(taskIdFromName(taskName));
      const targetDir = normalizeTerminalTaskDir(toDir);
      await nodeFsAdapter.makeDirectory(targetDir);
      const to = await moveWithUniqueName(deps, from, path.join(targetDir, taskName));
      if (options.updateCurrent ?? true) await setCurrentTaskFile(deps, to);
      return to;
    },

    async finishTaskState(from, toDir, taskName, cleanupFiles = []) {
      await assertAuthority(taskIdFromName(taskName));
      const targetDir = normalizeTerminalTaskDir(toDir);
      await nodeFsAdapter.makeDirectory(targetDir);
      const to = await moveWithUniqueName(deps, from, path.join(targetDir, taskName));
      for (const cleanupFile of cleanupFiles) {
        // Šaltinio ir taikinio NIEKADA nevalome: pirmasis jau perkeltas, antrasis yra rezultatas.
        if (cleanupFile !== from && cleanupFile !== to) await nodeFsAdapter.removeIfExists(cleanupFile);
      }
      await setCurrentTaskFile(deps, to);
      return to;
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
  };
}
