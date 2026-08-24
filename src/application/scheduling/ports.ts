// scheduling klasterio IO portai (WBR VQ-303). Scope lock registro ir worker lease store
// failų darbas — tik per šiuos kontraktus; adapteriai — E4. Laikrodžio/proceso default'ai
// gyvena čia pat, kaip context-pack `systemClock` — application sluoksniui Date ir process
// globalai leidžiami, importų gate'ą tai tenkina.

import { randomUUID } from "node:crypto";
import type { OwnedLockIo } from "../../shared/owned-lock.js";

export type SchedulingFileSystemPort = {
  /** Failo tekstas arba `undefined`, kai failo nėra (nebuvimas — atsakymas, ne klaida). */
  readTextFileIfExists(absolutePath: string): Promise<string | undefined>;
  /** Katalogo įrašų vardai arba `undefined`, kai katalogo nėra. */
  listDirectoryIfExists(absoluteDir: string): Promise<string[] | undefined>;
  /**
   * Atominis įrašymas (tmp + rename E4 adapteryje). Serializacija (`toPrettyJson`) lieka
   * application pusėje — baitinis store formatas yra kontraktas, ne adapterio detalė.
   */
  writeTextFileAtomic(absolutePath: string, content: string): Promise<void>;
  makeDirectory(absoluteDir: string): Promise<void>;
  exists(absolutePath: string): Promise<boolean>;
  /**
   * Atominis „sukurk arba pasakyk, kad yra" mutex primityvas (`mkdir` be `recursive`).
   * Tas pats receptas kaip etalono task-move lock'e — elgsena repozitorijoje viena.
   */
  createLockDirectory(absoluteDir: string): Promise<"created" | "exists">;
  /** Best-effort pašalinimas; klaidas nutyli KVIETĖJAS, ne portas. */
  removeDirectory(absoluteDir: string): Promise<void>;
  /** Katalogo mtime (ms) stale-lock patikrai; `undefined`, kai katalogo nebėra. */
  directoryModifiedAtMs(absoluteDir: string): Promise<number | undefined>;
  /**
   * Pervadinimas. Reikalingas TIK stale lock'o perėmimui (`shared/lock-steal`): perėmimas yra
   * `rename` į privatų kelią, kurį laimi lygiai vienas laukėjas. Be jo scheduling lock'ai turėjo
   * savo, silpnesnį `stat -> rm` perėmimą — t. y. TOCTOU, kurį bendras algoritmas jau uždarė
   * kitose repo vietose. Portas jį gavo 2026-08-24 būtent tam, kad protokolas liktų vienas.
   */
  renamePath(from: string, to: string): Promise<void>;
};

export type SchedulingClockPort = {
  now(): Date;
  sleep(ms: number): Promise<void>;
};

/** Testų/kompozicijos default'as: realus laikrodis ir realus laukimas. */
export const systemSchedulingClock: SchedulingClockPort = {
  now: () => new Date(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/**
 * Scheduling portai → `shared/owned-lock` efektai.
 *
 * Vienoje vietoje, o ne kiekvienoje saugykloje: būtent dvi atskiros to paties lock'o kopijos ir
 * buvo 2026-08-23 radinio priežastis. Laikrodis ateina iš to paties `SchedulingClockPort`, tad
 * testas gali įrodyti stale ribą be tikro laukimo.
 */
export function schedulingOwnedLockIo(fs: SchedulingFileSystemPort, clock: SchedulingClockPort): OwnedLockIo {
  return {
    createLockDirectory: (dir) => fs.createLockDirectory(dir),
    removeDirectory: (dir) => fs.removeDirectory(dir),
    readTextFileIfExists: (absolutePath) => fs.readTextFileIfExists(absolutePath),
    writeTextFileAtomic: (absolutePath, content) => fs.writeTextFileAtomic(absolutePath, content),
    directoryModifiedAtMs: (dir) => fs.directoryModifiedAtMs(dir),
    exists: (absolutePath) => fs.exists(absolutePath),
    renamePath: (from, to) => fs.renamePath(from, to),
    nowMs: () => clock.now().getTime(),
    sleep: (ms) => clock.sleep(ms),
    newLockId: () => randomUUID(),
  };
}

/**
 * Ar procesas su tokiu pid dar egzistuoja. `EPERM` reiškia „egzistuoja, bet svetimas" —
 * tai GYVAS procesas, todėl jis niekada nelaikomas mirusiu (kitaip svetimo naudotojo
 * loop'o lease būtų nuplėštas nuo dirbančio proceso). Grynos taisyklės
 * (`domain/scheduling/worker-lease-rules.ts#isLeaseOwnerProcessDead`) šį predikatą gauna
 * injekcija — default'as gyvena čia, prie IO ribos.
 */
export function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
