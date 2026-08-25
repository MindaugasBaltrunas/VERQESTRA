// Queue task selection use-case: picks the next task file to work on, mirroring the selection
// order the loop entry applies (resumable buckets active/delegated/error take priority over a
// fresh queue pick, each bucket resolved to its oldest-sorted markdown file). Etalone failų
// enumeraciją darė `core/fs.listMarkdownFilePaths`; VERQESTRA ją gauna per portą — rūšiavimo
// tvarka (vardų sort) yra adapterio kontrakto dalis, nes nuo jos priklauso, kuris task'as
// laimi bucket'e.
import { type TaskBucket } from "../../domain/tasks/index.js";
import { taskFileStem } from "../../domain/tasks/identity.js";
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
  /**
   * Task'ai, kuriuos ŠIUO METU saugo gyvas worker lease (`held`, TTL nepasibaigęs, savininko
   * procesas gyvas — `domain/scheduling/worker-lease-rules.leaseGuardsTask`).
   *
   * Reikšmės lyginamos su task'o failo stem'u, tad adapteris privalo grąžinti `task_id` tokį patį,
   * kokį lease'ui rašo planuoklis. Nepavykus perskaityti lease'ų adapteris grąžina VISUS rastus
   * kaip gyvus arba meta — tylus tuščias sąrašas reikštų, kad sugedusi saugykla atrakina
   * kiekvieną vykdomą task'ą.
   */
  liveLeaseTaskIds(): Promise<ReadonlySet<string>>;
};

/**
 * Pirmas ATSTATOMAS task'as iš `resumableTaskBuckets`, jei toks yra.
 *
 * „Atstatomas" NĖRA „guli bucket'e". Bucket'as tik pasako, kad task'as buvo pradėtas; ar jis
 * apleistas, pasako lease. Task'as, kurį dar saugo gyvas lease, praleidžiamas — jis ne nutrūkęs,
 * o vykdomas šią sekundę, ir jo antra aktyvacija ištrauktų failą iš po veikiančio vykdytojo
 * (2026-08-25: dviguba 012 aktyvacija → `Unique move source file does not exist` → slot'as krito
 * → ciklas sustojo; šalutinė žala — `EBUSY` nužudytas nesusijęs 007).
 *
 * Praleidžiamas TIK saugomas task'as, o ne visas bucket'as: likę to paties bucket'o failai
 * tikrinami toliau, kitaip vienas gyvas vykdytojas užblokuotų atstatymą visiems.
 */
export async function selectNextResumableTask(
  agRoot: string,
  ports: TaskSelectionPorts,
): Promise<SelectedResumableTask | undefined> {
  const guarded = await ports.liveLeaseTaskIds();
  for (const bucket of resumableTaskBuckets) {
    const files = await ports.listMarkdownFilePaths(taskBucketDir(agRoot, bucket));
    for (const file of files) {
      if (!guarded.has(taskFileStem(file))) {
        return { bucket, file };
      }
    }
  }
  return undefined;
}

// `selectNextQueuedTaskFile` ištrinta 2026-08-23 orkestratoriaus audite: 0 produkcinių
// kvietėjų ir čia, ir etalone — plokščią „kitas eilės failas" kelią pakeitė bangos
// planuoklis (`scheduleNextWave`), ką konstatuoja ir paties etalono komentaras
// schedule-next-wave.ts antraštėje. Resumable pusė (`selectNextResumableTask`) lieka gyva.
