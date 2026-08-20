// Task ledger'io operacijos virš store porto (etalono orchestrator/tasks/task-ledger.ts
// clearTaskLedgerEntry pusė + commands/task-ledger-sync sinchronizacijos TAISYKLĖS,
// perkeltos iš CLI į application pagal E5 WBR — handler'iui lieka tik argumentai ir
// spausdinimas). Grynosios įrašų taisyklės (seen-before, normalizacija) — task-ledger-rules.

import path from "node:path";
import { taskBuckets, type TaskBucket } from "../../domain/tasks/buckets.js";
import { taskFileStem } from "../../domain/tasks/identity.js";
import type { TaskLedgerEntry } from "./task-ledger-rules.js";

/**
 * Ledger failo store portas. Adapteris (E4/E5 kompozicija) privalo išlaikyti etalono
 * semantiką: `read` sugadintam JSON meta klaidą (ne tyliai grąžina {}), `write` — atominis.
 */
export type TaskLedgerStorePort = {
  exists(): Promise<boolean>;
  read(): Promise<Record<string, TaskLedgerEntry>>;
  write(ledger: Record<string, TaskLedgerEntry>): Promise<void>;
};

/** Pašalina vieną ledger'io įrašą; `true` kai įrašas realiai buvo ir buvo ištrintas. */
export async function clearTaskLedgerEntry(store: TaskLedgerStorePort, taskId: string): Promise<boolean> {
  if (!(await store.exists())) return false;
  const ledger = await store.read();
  if (!(taskId in ledger)) return false;
  delete ledger[taskId];
  await store.write(ledger);
  return true;
}

export type TaskLocation = { bucket: TaskBucket; file: string };

/**
 * Faktinės task failų vietos `AG/tasks/<bucket>` kataloguose. Bucket'ų failai yra tiesos
 * šaltinis (rankinis ar CLI task-move palieka ledger'į pasenusį). Failui gulint keliuose
 * bucket'uose laimi pirmas pagal `taskBuckets` eilę; ne-.md failai praleidžiami
 * (etalono pastaba: `.md` atpažinimas per `taskFileStem` yra case-insensitive — TYČINIS,
 * dokumentuotas skirtumas nuo buvusio case-sensitive endsWith).
 */
export async function collectTaskLocations(
  listFiles: (absoluteDir: string) => Promise<string[]>,
  agRoot: string,
): Promise<Map<string, TaskLocation>> {
  const locations = new Map<string, TaskLocation>();
  for (const bucket of taskBuckets) {
    const dir = path.join(agRoot, "tasks", bucket);
    for (const name of await listFiles(dir)) {
      const stem = taskFileStem(name);
      if (stem === name) continue;
      if (!locations.has(stem)) locations.set(stem, { bucket, file: path.join(dir, name) });
    }
  }
  return locations;
}

export type TaskLedgerSyncResult = {
  ledger: Record<string, TaskLedgerEntry>;
  changed: number;
  /** Žmogui skirtos eilutės ta tvarka, kuria įvyko sprendimai (etalono console išvestis 1:1). */
  log: string[];
};

/**
 * GRYNOS sinchronizacijos taisyklės: queue bucket'as elgiasi kaip requeue — įrašas
 * šalinamas, kad seen-before nelaikytų grąžinto task'o duplikatu; kiti bucket'ai atnaujina
 * state ir file; failo nesant jokiame bucket'e įrašas paliekamas (istorija, ne korupcija).
 */
export function syncTaskLedgerEntries(
  ledger: Record<string, TaskLedgerEntry>,
  locations: Map<string, TaskLocation>,
  nowIso: string,
): TaskLedgerSyncResult {
  const next: Record<string, TaskLedgerEntry> = { ...ledger };
  const log: string[] = [];
  let changed = 0;

  for (const [taskId, entry] of Object.entries(ledger)) {
    const taskStem = taskFileStem(entry.task_name ?? taskId);
    const location = locations.get(taskStem);
    if (!location) continue;

    if (location.bucket === "queue") {
      delete next[taskId];
      changed += 1;
      log.push(`cleared (file back in queue): ${taskId}`);
      continue;
    }

    if (entry.state !== location.bucket || entry.file !== location.file) {
      next[taskId] = { ...entry, state: location.bucket, file: location.file, updated_at: nowIso };
      changed += 1;
      log.push(`synced: ${taskId} -> ${location.bucket}`);
    }
  }

  return { ledger: next, changed, log };
}

export type TaskLedgerSyncOutcome =
  | { status: "missing" }
  | { status: "in-sync"; log: string[] }
  | { status: "updated"; changed: number; log: string[] };

/** Pilna sinchronizacija: vietos iš disko, taisyklės, atominis įrašymas tik kai keitėsi. */
export async function syncTaskLedger(
  store: TaskLedgerStorePort,
  listFiles: (absoluteDir: string) => Promise<string[]>,
  agRoot: string,
  nowIso: string,
): Promise<TaskLedgerSyncOutcome> {
  if (!(await store.exists())) return { status: "missing" };
  const locations = await collectTaskLocations(listFiles, agRoot);
  const result = syncTaskLedgerEntries(await store.read(), locations, nowIso);
  if (result.changed === 0) return { status: "in-sync", log: result.log };
  await store.write(result.ledger);
  return { status: "updated", changed: result.changed, log: result.log };
}
