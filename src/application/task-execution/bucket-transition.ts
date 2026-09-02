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
import { stripVerificationPreamble } from "../quality-gates/preflight-rules.js";

/**
 * Failų judinimo tarp bucket'ų portas. Adapteris (E4) privalo išlaikyti etalono
 * `task-state.ts` semantiką: unikalus šaltinis, terminal-bucket normalizacija,
 * win32 rename retry ir `updateCurrent` žymės atnaujinimas.
 *
 * `readTaskText`/`writeTaskText` (092): turinio prieiga preambulės nuėmimui prieš perkėlimą
 * iš dispatch lango — žr. `stripDispatchPreambleBeforeExit`.
 */
export type TaskStateStorePort = {
  moveTaskState(from: string, toDir: string, taskName: string, options?: { updateCurrent?: boolean }): Promise<string>;
  finishTaskState(
    from: string,
    toDir: string,
    taskName: string,
    cleanupFiles: string[],
    options?: { updateCurrent?: boolean },
  ): Promise<string>;
  activateTaskFile(taskFile: string, activeFile: string, taskId: string): Promise<string>;
  /** Failo tekstas arba `undefined`, kai failo nėra (nebuvimas — atsakymas, ne klaida). */
  readTaskText(absolutePath: string): Promise<string | undefined>;
  writeTaskText(absolutePath: string, text: string): Promise<void>;
};

/**
 * Invariantas (092): queue/done/human-review (ir error) — VISADA kanoninė forma; dispatch'o
 * forma (`verificationPreamble`, instaliuota `installReformulatedTask` keliu) leidžiama TIK
 * active/delegated bandymo lange. Kiekvienas perkėlimas, kurio tikslas nėra langas, preambulę
 * nuima ČIA — vieninteliame perėjimo taške, per kurį eina koordinatoriaus finish, CLI
 * requeue/task-move ir HTTP triažas. Trūkstamas failas — ne šio kelio klaida: move'as pats
 * praneš tiksliau (unikalaus šaltinio patikra su lock'u).
 */
async function stripDispatchPreambleBeforeExit(
  store: TaskStateStorePort,
  from: string,
  bucket: TaskBucket,
): Promise<void> {
  if (bucket === "active" || bucket === "delegated") return;
  const text = await store.readTaskText(from);
  if (text === undefined) return;
  const stripped = stripVerificationPreamble(text);
  if (stripped !== text) await store.writeTaskText(from, stripped);
}

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
  await stripDispatchPreambleBeforeExit(store, from, bucket);
  return await store.moveTaskState(from, taskBucketDir(agRoot, bucket), taskName, options);
}

/**
 * Moves a task file into a terminal bucket (done/human-review) and cleans up auxiliary files.
 *
 * `updateCurrent: false` — SVETIMO slot'o užbaigimas (worktree integracija pagrindiniame medyje)
 * `current-task-file` žymės NELIEČIA: žymė aprašo pirminio medžio vykdymą, o integracija ją
 * perrašydavo paskutinio sulieto task'o `done/` keliu, kol `current-task-id` likdavo nuo kito
 * task'o — dashboard'as iš dviejų žymių lipdė „012-a-02 (done)" (2026-09-02 apžvalgos auditas).
 */
export async function finishTaskInBucket(
  store: TaskStateStorePort,
  agRoot: string,
  from: string,
  bucket: TaskBucket,
  taskName: string,
  cleanupFiles: string[] = [],
  options: MoveTaskToBucketOptions = {},
): Promise<string> {
  if (!isTerminalBucket(bucket)) {
    throw new Error(`finishTaskInBucket requires a terminal bucket (human-review|done), got "${bucket}"`);
  }
  await stripDispatchPreambleBeforeExit(store, from, bucket);
  return await store.finishTaskState(from, taskBucketDir(agRoot, bucket), taskName, cleanupFiles, options);
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
