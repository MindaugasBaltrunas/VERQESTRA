// Task-flavored path resolution (WBR VQ-201 pataisa: E1 shared negali žinoti task
// bucket'ų, todėl ši trijulė gyvena domain/tasks). Behaviour etalon: AG_loop
// core/paths.ts dispatchTaskPrefixes/resolveDispatchTaskFile (grynos; FS variantas
// resolveExistingDispatchTaskFile lieka vėlesnei bangai).

import { resolveProjectPath } from "../../shared/paths.js";
import { taskBuckets } from "./buckets.js";

// Dispatchable buckets exclude the terminal rest states ("failed" escalates to
// "human-review" before a task can be dispatched again; "done" is finished) — derived
// from the canonical bucket set, never a standalone list.
export const dispatchTaskPrefixes: readonly string[] = taskBuckets
  .filter((bucket) => bucket !== "failed" && bucket !== "done")
  .map((bucket) => `AG/tasks/${bucket}`);

/** Pure dispatch-address resolution: inside a dispatchable bucket, `.md`, no escapes. */
export function resolveDispatchTaskFile(projectRoot: string, candidate: string, label = "task file"): string {
  return resolveProjectPath(
    projectRoot,
    candidate,
    {
      allowAbsoluteInsideRoot: true,
      allowedPrefixes: [...dispatchTaskPrefixes],
      extension: ".md",
    },
    label,
  );
}
