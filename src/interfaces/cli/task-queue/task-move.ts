// `task-move` CLI adapteris (etalonas: interfaces/cli/task-move/index.ts). Argumentų
// validacija čia; failo judinimą daro TaskStateStorePort per bucket-transition — adapteris
// (E4/E5) taiko etalono task-state semantiką (unikalus šaltinis, terminal normalizacija).

import path from "node:path";
import { resolveProjectPath } from "../../../shared/paths.js";
// Sankcionuotas tiltas: interfaces kanoninį bucket rinkinį ima per task-execution barrel'į,
// ne tiesiogiai iš domain/tasks/buckets.ts (žr. barrel'io pastabą).
import {
  moveTaskToBucket,
  taskBuckets,
  type TaskBucket,
  type TaskStateStorePort,
} from "../../../application/task-execution/index.js";
import { consoleCliIo, type CliIo } from "../registry.js";

export type TaskMoveCommandDeps = {
  store: TaskStateStorePort;
  /** `true` kai kelias egzistuoja ir yra failas (etalono stat().isFile() patikra). */
  isFile(absolutePath: string): Promise<boolean>;
  projectRoot: string;
  io?: CliIo;
};

function bucketOfTargetDir(tasksRoot: string, targetDir: string): TaskBucket | undefined {
  if (path.dirname(targetDir) !== tasksRoot) return undefined;
  const name = path.basename(targetDir);
  return (taskBuckets as readonly string[]).includes(name) ? (name as TaskBucket) : undefined;
}

export async function moveTask(args: string[], deps: TaskMoveCommandDeps): Promise<number> {
  const io = deps.io ?? consoleCliIo;
  const [fromFile, toDir] = args;

  if (!fromFile || !toDir) {
    io.error("Usage: ag task-move <from-file> <to-dir>");
    return 2;
  }

  const root = path.resolve(deps.projectRoot);
  const agRoot = path.join(root, "AG");
  const tasksRoot = path.join(agRoot, "tasks");
  const taskBucketPrefixes = taskBuckets.map((bucket) => `AG/tasks/${bucket}`);
  let source: string;
  let targetDir: string;
  try {
    source = resolveProjectPath(root, fromFile, {
      allowAbsoluteInsideRoot: true,
      allowedPrefixes: taskBucketPrefixes,
      extension: ".md",
    });
    targetDir = resolveProjectPath(
      root,
      toDir,
      { allowAbsoluteInsideRoot: true, allowedPrefixes: ["AG/tasks"] },
      "target directory",
    );
  } catch (error) {
    io.error(error instanceof Error ? error.message : String(error));
    return 2;
  }

  const bucket = bucketOfTargetDir(tasksRoot, targetDir);
  if (bucket === undefined) {
    io.error(`task-move target must be a task bucket: ${taskBuckets.join(", ")}`);
    return 2;
  }

  if (!(await deps.isFile(source))) {
    io.error("task-move source must exist and be a file");
    return 2;
  }

  await moveTaskToBucket(deps.store, agRoot, source, bucket, path.basename(source), { updateCurrent: false });
  return 0;
}
