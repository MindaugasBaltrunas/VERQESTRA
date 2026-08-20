// Repair prompt failų saugykla — `vq/state/repair/<taskId>.md` (etalonas: AG_loop
// orchestrator/tasks/task-repair.ts failo pusė; sekcijų perrašymo taisyklės gyvena
// application/task-execution/repair-prompt.ts). Failą rašo integracijos peržiūra ir
// diagnozė, o pasiima retry-bounded repair ciklas (`TaskRunPorts.repairPrompt.read`).

import { rm } from "node:fs/promises";
import path from "node:path";
import { nodeFsAdapter } from "../fs/node-fs-adapter.js";

export function taskRepairPath(runtimeRoot: string, taskId: string): string {
  if (!/^[A-Za-z0-9_.-]+$/.test(taskId) || taskId === "." || taskId === "..") {
    throw new Error(`Invalid repair task id: ${taskId}`);
  }
  return path.join(runtimeRoot, "state", "repair", `${taskId}.md`);
}

export async function writeTaskRepairPrompt(runtimeRoot: string, taskId: string, content: string): Promise<string> {
  const filePath = taskRepairPath(runtimeRoot, taskId);
  await nodeFsAdapter.writeTextFile(filePath, content);
  return filePath;
}

/** Failo turinys arba `""`, kai repair prompt'o nėra (etalono readOptionalFile semantika). */
export async function readTaskRepairPrompt(runtimeRoot: string, taskId: string): Promise<string> {
  return (await nodeFsAdapter.readTextFileIfExists(taskRepairPath(runtimeRoot, taskId))) ?? "";
}

export async function removeTaskRepairPrompt(runtimeRoot: string, taskId: string): Promise<void> {
  await rm(taskRepairPath(runtimeRoot, taskId), { force: true });
}
