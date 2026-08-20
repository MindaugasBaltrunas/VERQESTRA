// Bucket-aware application layer over the FS-facing task-state store. Callers state the
// destination as a domain TaskBucket instead of a raw directory path; this module resolves the
// bucket to its on-disk directory and delegates the actual file move to the store port, whose
// adapter (E4) applies the domain/tasks/buckets.ts terminal-bucket rule (a move routed to
// "failed" lands in "human-review" instead). Etalone šis modulis buvo prisirišęs prie
// `agRoot` runtime konteksto ir `task-state.ts` FS adapterio; VERQESTRA jį gauna parametrais —
// `agRoot` yra kelio šaknis (`<repo>/AG`, nes task bucket'ai lieka `AG/tasks/<bucket>`),
// o failų judinimas eina per `TaskStateStorePort`.
import path from "node:path";
import { isTerminalBucket, type TaskBucket } from "../../domain/tasks/index.js";

/**
 * Failų judinimo tarp bucket'ų portas. Adapteris (E4) privalo išlaikyti etalono
 * `task-state.ts` semantiką: unikalus šaltinis, terminal-bucket normalizacija,
 * win32 rename retry ir `updateCurrent` žymės atnaujinimas.
 */
export type TaskStateStorePort = {
  moveTaskState(from: string, toDir: string, taskName: string, options?: { updateCurrent?: boolean }): Promise<string>;
  finishTaskState(from: string, toDir: string, taskName: string, cleanupFiles: string[]): Promise<string>;
  activateTaskFile(taskFile: string, activeFile: string, taskId: string): Promise<string>;
};

export function taskBucketDir(agRoot: string, bucket: TaskBucket): string {
  return path.join(agRoot, "tasks", bucket);
}

export type MoveTaskToBucketOptions = {
  updateCurrent?: boolean;
};

/** Moves a task file into `bucket`. Non-final transition (queue/active/delegated/error/human-review). */
export async function moveTaskToBucket(
  store: TaskStateStorePort,
  agRoot: string,
  from: string,
  bucket: TaskBucket,
  taskName: string,
  options: MoveTaskToBucketOptions = {},
): Promise<string> {
  return await store.moveTaskState(from, taskBucketDir(agRoot, bucket), taskName, options);
}

/** Moves a task file into a terminal bucket (done/human-review) and cleans up auxiliary files. */
export async function finishTaskInBucket(
  store: TaskStateStorePort,
  agRoot: string,
  from: string,
  bucket: TaskBucket,
  taskName: string,
  cleanupFiles: string[] = [],
): Promise<string> {
  if (!isTerminalBucket(bucket)) {
    throw new Error(`finishTaskInBucket requires a terminal bucket (human-review|done), got "${bucket}"`);
  }
  return await store.finishTaskState(from, taskBucketDir(agRoot, bucket), taskName, cleanupFiles);
}

/** Activates a queued task file into the "active" bucket and records it as the current task. */
export async function activateQueuedTask(
  store: TaskStateStorePort,
  agRoot: string,
  taskFile: string,
  taskId: string,
): Promise<string> {
  const activeFile = path.join(taskBucketDir(agRoot, "active"), taskFileName(taskFile));
  return await store.activateTaskFile(taskFile, activeFile, taskId);
}

function taskFileName(taskFile: string): string {
  return path.basename(taskFile);
}
