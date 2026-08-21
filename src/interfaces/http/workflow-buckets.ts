// Užduočių bucket'ų vaizdas ir katalogo atidarymas dashboard'e (etalonas: AG_loop
// ui/{task-renderer,folder-service}.ts).
//
// Bucket'o vardas ateina iš HTTP užklausos, tad jis PRIVALO būti patikrintas prieš virsdamas
// keliu: `taskBucketDir` grąžina `undefined` nežinomam vardui, ir tik tada kelias sudedamas.
// Katalogo atidarymas gyvena už porto — `interfaces` sluoksnis procesų nepaleidžia.

import { taskBuckets, type TaskBucket } from "../../domain/tasks/buckets.js";
import { taskBucketDir } from "../../application/task-execution/bucket-transition.js";

/** Kiek naujausių užduočių rodoma bucket'o kortelėje; pilnas sąrašas — atskiras maršrutas. */
export const VISIBLE_TASK_LIMIT = 20;

export type WorkflowBucketView = {
  name: string;
  tasks: string[];
  totalCount: number;
};

export type WorkflowBucketPorts = {
  /** `.md` failų vardai kataloge, rūšiuoti; nesamas katalogas — tuščias sąrašas. */
  listTaskFiles(absoluteDir: string): Promise<string[]>;
  /** Katalogo atidarymas operatoriaus aplinkoje; `false`, kai nepavyko. */
  openFolder(absolutePath: string): Promise<boolean>;
};

/**
 * Bucket'o katalogas arba `undefined`, kai vardas nėra ŽINOMAS bucket'as. Kelio sudėjimas
 * deleguojamas application `taskBucketDir` — čia lieka tik vartai laisvos formos vardui, kad
 * repozitorijoje neatsirastų antra to paties kelio taisyklė.
 */
export function resolveTaskBucketDir(agRoot: string, bucket: string): string | undefined {
  const known = taskBuckets.find((candidate) => candidate === bucket);
  return known === undefined ? undefined : taskBucketDir(agRoot, known);
}

/** Visi bucket'ai su naujausiomis užduotimis ir pilnu kiekiu (kortelėms). */
export async function loadWorkflowBuckets(
  ports: WorkflowBucketPorts,
  agRoot: string,
): Promise<WorkflowBucketView[]> {
  const views: WorkflowBucketView[] = [];
  for (const bucket of taskBuckets) {
    const files = await ports.listTaskFiles(taskBucketDir(agRoot, bucket));
    views.push({ name: bucket, tasks: files.slice(-VISIBLE_TASK_LIMIT), totalCount: files.length });
  }
  return views;
}

/** Nežinomas bucket'as yra kliento klaida, ne tuščias sąrašas — todėl META. */
export async function loadWorkflowBucketTasks(
  ports: WorkflowBucketPorts,
  agRoot: string,
  bucket: string,
): Promise<WorkflowBucketView> {
  const dir = resolveTaskBucketDir(agRoot, bucket);
  if (dir === undefined) throw new UnknownTaskBucketError(`Unknown task bucket: ${bucket}`);
  const tasks = await ports.listTaskFiles(dir);
  return { name: bucket, tasks, totalCount: tasks.length };
}

export class UnknownTaskBucketError extends Error {}

/**
 * Atidaro bucket'o katalogą. `false` grąžinamas ir nežinomam bucket'ui: laisvos formos vardas
 * niekada netampa keliu, kurį paduodame OS.
 */
export async function openTaskBucketFolder(
  ports: WorkflowBucketPorts,
  agRoot: string,
  bucket: string,
): Promise<boolean> {
  const dir = resolveTaskBucketDir(agRoot, bucket);
  if (dir === undefined) return false;
  return await ports.openFolder(dir);
}

export type { TaskBucket };
