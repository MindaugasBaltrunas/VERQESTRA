// `task-ledger-sync` CLI adapteris (etalonas: interfaces/cli/task-ledger-sync/index.ts).
// Sinchronizacijos TAISYKLĖS perkeltos į application/task-execution/task-ledger-service
// (E5 WBR: taisyklė handler'yje pirma keliama į application) — čia lieka tik portų
// iškvietimas ir etalono console eilutės 1:1.

import {
  syncTaskLedger,
  type TaskLedgerStorePort,
} from "../../../application/task-execution/task-ledger-service.js";
import { consoleCliIo, type CliIo } from "../registry.js";

export type TaskLedgerSyncCommandDeps = {
  ledger: TaskLedgerStorePort;
  /** Failų vardai kataloge; `[]` kai katalogo nėra (etalono readdir-catch semantika). */
  listFiles(absoluteDir: string): Promise<string[]>;
  /** `<root>/AG` — task bucket'ų šaknis. */
  agRoot: string;
  io?: CliIo;
  nowIso?: () => string;
};

export async function taskLedgerSyncCommand(deps: TaskLedgerSyncCommandDeps): Promise<number> {
  const io = deps.io ?? consoleCliIo;
  const nowIso = deps.nowIso ?? (() => new Date().toISOString());

  const outcome = await syncTaskLedger(deps.ledger, deps.listFiles, deps.agRoot, nowIso());

  if (outcome.status === "missing") {
    io.out("task-ledger.json not found — nothing to sync");
    return 0;
  }

  for (const line of outcome.log) io.out(line);

  if (outcome.status === "in-sync") {
    io.out("ledger already in sync");
    return 0;
  }

  io.out(`ledger updated: ${outcome.changed} ${outcome.changed === 1 ? "entry" : "entries"}`);
  return 0;
}
