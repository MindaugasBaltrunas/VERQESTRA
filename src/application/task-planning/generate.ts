// OpenSpec/spec task planavimo use-case: išsprendžia aktyvų task planą, atrenderina po
// vieną queue task failą kiekvienai implementacijos eilutei ir praleidžia jau
// egzistuojančius failus. Elgesio etalonas: AG_loop application/task-planning/generate.ts.
// Gauna jau parsintus options — CLI komandai lieka tik argumentų parsinimas.

import path from "node:path";
import { taskBuckets } from "../../domain/tasks/buckets.js";
import { taskNumberFromFilename, taskSlug } from "../../domain/tasks/identity.js";
import { loadEnforcementPolicy } from "../policy-governance/architecture-policies.js";
import type { PolicyConfigFileSystemPort } from "../policy-governance/ports.js";
import { parseSpecTaskLines } from "./spec-task-lines.js";
import { renderQueueTask } from "./queue-task.js";
import { findActiveSpec, findOpenSpecTaskPlan, type TaskPlanningFsPort } from "./spec-source.js";

export type TaskGeneratePorts = {
  fs: TaskPlanningFsPort & PolicyConfigFileSystemPort & {
    makeDirectory(absoluteDir: string): Promise<void>;
    /** Rašymas `wx` semantika: `created` arba `exists` (jau esamas failas NEperrašomas). */
    writeFileExclusive(absolutePath: string, content: string): Promise<"created" | "exists">;
    /** Failų vardai; `[]` kai katalogo nėra. */
    listFiles(absoluteDir: string): Promise<string[]>;
  };
};

export type TaskGenerateOptions = {
  openspecChangeId?: string;
  startIndex: number;
};

export type TaskGenerateResult = {
  specId: string;
  tasksPath: string;
  created: string[];
  skipped: string[];
};

/**
 * DUP-14 etalono taisyklė: `--start` yra kvietėjo užuomina, niekada nevedama iš disko
 * vien pati — naujas numeris imamas kaip max(start, realus cross-bucket maksimumas + 1),
 * kad negeneruotų kolizijos su numeriu, jau užimtu BET KURIAME AG/tasks/* bucket'e.
 */
export async function nextAvailableTaskNumber(
  ports: TaskGeneratePorts,
  projectRoot: string,
): Promise<number> {
  let max = 0;
  for (const bucket of taskBuckets) {
    const files = await ports.fs.listFiles(path.join(projectRoot, "AG", "tasks", bucket));
    for (const file of files) {
      const number = taskNumberFromFilename(file);
      if (number !== undefined && number > max) max = number;
    }
  }
  return max + 1;
}

export async function taskGenerate(
  ports: TaskGeneratePorts,
  options: TaskGenerateOptions,
  projectRoot = process.cwd(),
  runtimeRoot?: string,
): Promise<TaskGenerateResult> {
  const root = path.resolve(projectRoot);
  const vqRoot = runtimeRoot ?? path.join(root, "vq");
  const activeSpec = options.openspecChangeId
    ? await findOpenSpecTaskPlan(ports.fs, root, options.openspecChangeId)
    : await findActiveSpec(ports.fs, root);
  const tasksPath = path.join(activeSpec.changeDir, "tasks.md");
  const tasksText = await ports.fs.readTextFileIfExists(tasksPath);
  if (tasksText === undefined) {
    throw new Error(`Active spec task plan missing: ${tasksPath}`);
  }

  const taskLines = parseSpecTaskLines(tasksText, {
    requireCheckbox: options.openspecChangeId !== undefined,
  }).filter((taskLine) => !taskLine.complete);
  if (taskLines.length === 0) {
    throw new Error(`No implementation task lines found in ${tasksPath}`);
  }

  const enforcement = await loadEnforcementPolicy(ports.fs, vqRoot);
  const queueDir = path.join(root, "AG", "tasks", "queue");
  await ports.fs.makeDirectory(queueDir);

  const result: TaskGenerateResult = {
    specId: activeSpec.id,
    tasksPath: activeSpec.relativeTasksPath,
    created: [],
    skipped: [],
  };

  const startIndex = Math.max(options.startIndex, await nextAvailableTaskNumber(ports, root));

  for (const taskLine of taskLines) {
    const taskNumber = startIndex + taskLine.index - 1;
    const fileName = `${String(taskNumber).padStart(3, "0")}-${taskSlug(taskLine.title)}.md`;
    const filePath = path.join(queueDir, fileName);
    const relativePath = path.relative(root, filePath).replace(/\\/g, "/");
    const content = renderQueueTask(taskLine, activeSpec.relativeSpecPath, result.tasksPath, enforcement);

    const written = await ports.fs.writeFileExclusive(filePath, content);
    if (written === "created") result.created.push(relativePath);
    else result.skipped.push(relativePath);
  }

  return result;
}
