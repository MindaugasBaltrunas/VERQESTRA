// `process-queued-task` CLI adapteris (etalonas: interfaces/cli/process-queued-task/index.ts;
// spec: second-slot-child-execution §1). Loop-internal child vykdytojas: loop'as paleidžia
// CHILD procesu su cwd = worktree, tad reliatyvus task kelias resolve'inamas prieš PROCESO
// cwd ir rodo į worktree KOPIJĄ. SĄMONINGAI ne `loop`: vykdomas LYGIAI VIENAS queue task'as,
// o exit kodas (0 = sėkmė) yra visas koordinatoriaus vartų rinkinys — preflight, dispatch,
// diagnose, gates, commit. Patį koordinatorių (run-coordinator kompoziciją) paduoda VQ-504.

import path from "node:path";
import { USAGE_ERROR_EXIT_CODE } from "../../../shared/exit-codes.js";
import { consoleCliIo, type CliIo } from "../registry.js";

export type ProcessQueuedTaskCommandDeps = {
  /** Gitignored runtime katalogų paruošimas worktree checkout'e (etalono ensureDirs). */
  ensureDirs(): Promise<void>;
  /** Pilnas vieno task'o koordinatoriaus ciklas; `true` = task priimtas. */
  processQueuedTask(taskFile: string): Promise<boolean>;
  io?: CliIo;
};

export async function processQueuedTaskCommand(args: string[], deps: ProcessQueuedTaskCommandDeps): Promise<number> {
  const io = deps.io ?? consoleCliIo;
  const taskFileArg = args[0];
  if (!taskFileArg) {
    io.error("Usage: verqestra process-queued-task <task-file>");
    return USAGE_ERROR_EXIT_CODE;
  }

  const taskFile = path.resolve(taskFileArg);
  await deps.ensureDirs();
  const ok = await deps.processQueuedTask(taskFile);
  return ok ? 0 : 1;
}
