import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Persistence adapter. Knows the filesystem; knows nothing about task rules
 * beyond the shape it serialises. `src/domain` must never import this file.
 */

/**
 * @param {string} file
 * @returns {Promise<{ id: string, title: string, priority: string, done: boolean }[]>}
 */
export async function loadTasks(file) {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if (error && error.code === "ENOENT") return [];
    throw error;
  }
}

/**
 * @param {string} file
 * @param {readonly { id: string, title: string, priority: string, done: boolean }[]} tasks
 */
export async function saveTasks(file, tasks) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(tasks, null, 2)}\n`, "utf8");
}
