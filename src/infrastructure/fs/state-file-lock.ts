// Read-modify-write serializavimas vienam būsenos failui.
//
// Primityvas — `createLockDirectory` (atominis `mkdir` be `recursive`), tas pats, kurį naudoja
// ledger lock protokolas. Lock'as pasirinktas vietoj CAS sąmoningai: CAS reikalautų `revision`
// lauko DOMENO tipuose, o tai paliestų kiekvieną skaitytoją, schemą ir fikstūrą; lock'as lieka
// saugyklos viduje ir nekeičia nė vieno kontrakto.
//
// 2026-08-23: iškelta iš `architecture-graph-store`, kur ji gyveno kaip privati `withProgressLock`.
// Antram kvietėjui (retry skaitikliai) reikėjo TO PATIES elgesio, ir antra kopija būtų buvusi ta
// pati klaida, kurią šiame repo jau taisėme keliuose grafo algoritmuose: du to paties protokolo
// egzemplioriai išsiskiria tyliai.

import { randomUUID } from "node:crypto";
import path from "node:path";
import { withOwnedLock, type OwnedLockIo, type OwnedLockTiming } from "../../shared/owned-lock.js";
import { nodeFsAdapter } from "./node-fs-adapter.js";

export const STATE_FILE_LOCK_TIMING: OwnedLockTiming = { staleMs: 30_000, retryMs: 25, timeoutMs: 5_000 };

/** `nodeFsAdapter` → `shared/owned-lock` efektai. Vienintelė vieta, kur šis modulis liečia FS. */
const stateFileLockIo: OwnedLockIo = {
  createLockDirectory: (dir) => nodeFsAdapter.createLockDirectory(dir),
  removeDirectory: (dir) => nodeFsAdapter.removeDirectory(dir),
  readTextFileIfExists: (absolutePath) => nodeFsAdapter.readTextFileIfExists(absolutePath),
  writeTextFileAtomic: (absolutePath, content) => nodeFsAdapter.writeTextFileAtomic(absolutePath, content),
  directoryModifiedAtMs: (dir) => nodeFsAdapter.directoryModifiedAtMs(dir),
  exists: (absolutePath) => nodeFsAdapter.exists(absolutePath),
  renamePath: (from, to) => nodeFsAdapter.renamePath(from, to),
  nowMs: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  newLockId: () => randomUUID(),
};

/**
 * Laiko lock'ą per VISĄ read-modify-write.
 *
 * Nepavykus jo gauti per `timeoutMs` — METAMA: tylus tęsimas be lock'o būtų lygiai tas pats
 * prarastas atnaujinimas, kurį šis vartas ir taiso.
 *
 * 2026-08-24: protokolas — bendras `shared/owned-lock`. Iki tol šis lock'as (ir dvi scheduling
 * kopijos) trynė katalogą `finally` bloke BESĄLYGIŠKAI, tad po stale perėmimo senasis savininkas
 * ištrindavo jau naujojo lock'ą ir įleisdavo trečią rašytoją. Iškeliant `withProgressLock` iš
 * `architecture-graph-store` spraga persikėlė kartu — bendras helper'is nepadarė jos mažesnės,
 * tik vienavietę.
 */
export async function withStateFileLock<T>(statePath: string, work: () => Promise<T>): Promise<T> {
  // `mkdir` be `recursive` reikalauja esamo tėvo; pirmo rašymo metu jo dar gali nebūti.
  await nodeFsAdapter.makeDirectory(path.dirname(statePath));
  return await withOwnedLock(stateFileLockIo, `${statePath}.lock`, STATE_FILE_LOCK_TIMING, work, "state-file");
}
