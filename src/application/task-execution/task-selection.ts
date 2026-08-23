// Queue task selection use-case: picks the next task file to work on, mirroring the selection
// order the loop entry applies (resumable buckets active/delegated/error take priority over a
// fresh queue pick, each bucket resolved to its oldest-sorted markdown file). Etalone failų
// enumeraciją darė `core/fs.listMarkdownFilePaths`; VERQESTRA ją gauna per portą — rūšiavimo
// tvarka (vardų sort) yra adapterio kontrakto dalis, nes nuo jos priklauso, kuris task'as
// laimi bucket'e.
import { type TaskBucket } from "../../domain/tasks/index.js";
import { taskBucketDir } from "./bucket-transition.js";

/** The subset of buckets a task interrupted mid-run can resume from. */
export type ResumableTaskBucket = Extract<TaskBucket, "active" | "delegated" | "error">;

/** Buckets scanned, in priority order, for a task interrupted mid-run that should resume. */
export const resumableTaskBuckets: readonly ResumableTaskBucket[] = ["active", "delegated", "error"];

export type SelectedResumableTask = {
  bucket: ResumableTaskBucket;
  file: string;
};

export type TaskSelectionPorts = {
  /** Katalogo `.md` failų PILNI keliai, surūšiuoti vardų tvarka; tuščias sąrašas, kai katalogo nėra. */
  listMarkdownFilePaths(dir: string): Promise<string[]>;
};

/** Returns the first resumable task found across `resumableTaskBuckets`, if any. */
export async function selectNextResumableTask(
  agRoot: string,
  ports: TaskSelectionPorts,
): Promise<SelectedResumableTask | undefined> {
  for (const bucket of resumableTaskBuckets) {
    const files = await ports.listMarkdownFilePaths(taskBucketDir(agRoot, bucket));
    if (files[0]) {
      return { bucket, file: files[0] };
    }
  }
  return undefined;
}

// `selectNextQueuedTaskFile` ištrinta 2026-08-23 orkestratoriaus audite: 0 produkcinių
// kvietėjų ir čia, ir etalone — plokščią „kitas eilės failas" kelią pakeitė bangos
// planuoklis (`scheduleNextWave`), ką konstatuoja ir paties etalono komentaras
// schedule-next-wave.ts antraštėje. Resumable pusė (`selectNextResumableTask`) lieka gyva.
