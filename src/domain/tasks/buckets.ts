// Pure task-lifecycle bucket rules — the lowest domain layer: no IO, only the value types
// and total functions describing how a task's on-disk lifecycle bucket may transition.
// Adapters own the FS mutations and delegate the decisions here.
// Behaviour etalon: AG_loop domain/tasks/buckets.ts (ported 1:1, WBR VQ-201).

/** A task's lifecycle bucket — the on-disk folder a task file lives in at a given moment. */
export type TaskBucket =
  | "queue"
  | "active"
  | "delegated"
  | "error"
  | "failed"
  | "human-review"
  | "done";

/** All buckets, in lifecycle order. */
export const taskBuckets: readonly TaskBucket[] = [
  "queue",
  "active",
  "delegated",
  "error",
  "failed",
  "human-review",
  "done",
];

/** Buckets a task rests in once no further automated transition applies. */
export const terminalTaskBuckets: readonly TaskBucket[] = ["human-review", "done"];

/** Narrows an arbitrary folder name to a known {@link TaskBucket}. */
export function isTaskBucket(value: string): value is TaskBucket {
  return (taskBuckets as readonly string[]).includes(value);
}

/** True for buckets a task rests in with no further automated transition. */
export function isTerminalBucket(bucket: TaskBucket): boolean {
  return terminalTaskBuckets.includes(bucket);
}

/**
 * Resolves the bucket a task should actually land in when routed to a terminal bucket.
 * `failed` escalates to `human-review`: a failed task needs a human decision rather than
 * a silent dead-end. Every other bucket passes through unchanged.
 */
export function normalizeTerminalBucket(bucket: TaskBucket): TaskBucket {
  return bucket === "failed" ? "human-review" : bucket;
}
