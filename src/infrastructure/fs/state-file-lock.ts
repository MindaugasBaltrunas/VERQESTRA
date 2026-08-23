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

import path from "node:path";
import { nodeFsAdapter } from "./node-fs-adapter.js";

const LOCK_STALE_MS = 30_000;
const LOCK_POLL_MS = 25;
const LOCK_MAX_WAIT_MS = 5_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Laiko lock'ą per VISĄ read-modify-write.
 *
 * Nepavykus jo gauti per `LOCK_MAX_WAIT_MS` — METAMA: tylus tęsimas be lock'o būtų lygiai tas pats
 * prarastas atnaujinimas, kurį šis vartas ir taiso.
 *
 * Užstrigęs (stale) lock'as perimamas pagal katalogo mtime — kritęs procesas neturi teisės amžinai
 * stabdyti darbo. Perėmimo lenktynės (du procesai vienu metu mato stale) baigiasi tuo, kad laimi
 * vienintelis `mkdir`; tai ir yra primityvo prasmė.
 */
export async function withStateFileLock<T>(statePath: string, work: () => Promise<T>): Promise<T> {
  const lockDir = `${statePath}.lock`;
  // `mkdir` be `recursive` reikalauja esamo tėvo; pirmo rašymo metu jo dar gali nebūti.
  await nodeFsAdapter.makeDirectory(path.dirname(statePath));

  const deadline = Date.now() + LOCK_MAX_WAIT_MS;
  for (;;) {
    if ((await nodeFsAdapter.createLockDirectory(lockDir)) === "created") break;

    const heldSinceMs = await nodeFsAdapter.directoryModifiedAtMs(lockDir);
    if (heldSinceMs !== undefined && Date.now() - heldSinceMs > LOCK_STALE_MS) {
      await nodeFsAdapter.removeDirectory(lockDir);
      continue;
    }
    if (Date.now() >= deadline) {
      throw new Error(`state file is locked by another writer: ${lockDir}`);
    }
    await delay(LOCK_POLL_MS);
  }

  try {
    return await work();
  } finally {
    // Best-effort: nepavykęs atlaisvinimas baigsis stale perėmimu, o metimas čia užgožtų tikrąjį
    // `work()` rezultatą arba klaidą.
    await nodeFsAdapter.removeDirectory(lockDir).catch(() => undefined);
  }
}
