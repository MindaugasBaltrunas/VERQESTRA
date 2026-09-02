import { memo, useEffect, useState } from "react";
import type { WorkflowBucketView, BucketVariant } from "../../model/dashboardViewModel";
import { fill } from "../../model/fillTemplate";
import { taskFileLabel } from "../../model/taskFileLabel";
import { useQueueUploadController } from "../../controller/useQueueUploadController";
import { useI18n } from "../../i18n/I18nContext";

const toneClass: Record<BucketVariant, string> = {
  good: "bucket-good",
  error: "bucket-error",
  warning: "bucket-warning",
  live: "bucket-live",
  neutral: "bucket-neutral",
};

const badgeClass: Record<BucketVariant, string> = {
  good: "status-good",
  error: "status-error",
  warning: "status-warning",
  live: "status-live",
  neutral: "status-neutral",
};

/**
 * Gyvas srautas, kuris DABAR vykdo užduotį. Ateina iš valdiklio slot'ų (`slotProgress`), ne iš
 * bucket'ų: worktree slot'o vaikas task failą kilnoja SAVO kopijoje, tad pagrindinio medžio
 * `queue` jį teberodo kaip laukiantį — 2026-09-02 auditas: w1 = 122 ir w2 = 118 dirbo, o
 * „Darbo eiga" rodė abu eilėje ir „Vykdoma" tik pirminio medžio task'ą.
 */
export type WorkflowLiveSlot = { workerId: string; index: number; taskId: string };

type Props = {
  buckets: WorkflowBucketView[];
  onOpenFolder: (bucket: string) => void;
  onUpload: (files: File[]) => Promise<void>;
  onLoadTasks: (bucket: string) => Promise<string[]>;
  liveSlots?: readonly WorkflowLiveSlot[];
};

const BACKSLASH = String.fromCharCode(92);

/** `AG/tasks/queue/0042-x.md` ir `0042-x.md` → `0042-x`: ta pati tapatybė, kurią neša slot'as. */
function taskIdOf(file: string): string {
  const base = file.slice(Math.max(file.lastIndexOf("/"), file.lastIndexOf(BACKSLASH)) + 1);
  return base.toLowerCase().endsWith(".md") ? base.slice(0, -3) : base;
}

type LiveByTask = ReadonlyMap<string, WorkflowLiveSlot>;

export const WorkflowBoard = memo(function WorkflowBoard({ buckets, onOpenFolder, onUpload, onLoadTasks, liveSlots = [] }: Props) {
  const { t } = useI18n();
  const liveByTask: LiveByTask = new Map(liveSlots.map((slot) => [slot.taskId, slot]));

  // Pirminio medžio vykdymas (bucket'ai) ir worktree srautai (slot'ai) — VIENAS sąrašas, be dublių.
  const treeRunning = buckets
    .filter((b) => (b.name === "delegated" || b.name === "active") && b.tasks.length > 0)
    .flatMap((b) => b.tasks)
    .map((task) => ({ taskId: taskIdOf(task), slot: liveByTask.get(taskIdOf(task)) ?? null }));
  const streamRunning = [...liveSlots]
    .sort((a, b) => a.index - b.index)
    .filter((slot) => !treeRunning.some((entry) => entry.taskId === slot.taskId))
    .map((slot) => ({ taskId: slot.taskId, slot }));
  const running = [...treeRunning, ...streamRunning].map((entry) =>
    entry.slot ? `${entry.taskId} (${t("Stream")} ${entry.slot.index})` : entry.taskId,
  );
  // Srautų task'ai, kurių NĖRA nė vienos kortelės peržiūroje: serveris į kortelę deda tik
  // pirmus N eilės failų, o worktree slot'o task'as pagrindiniame medyje tebeguli `queue` — dažnai
  // už tos N ribos. Tada „Vykdoma" antraštė jį įvardija, bet lentoje jis neturi VIETOS
  // (2026-09-02 operatoriaus radinys: „suvestinė nerodo jų pozicijos"). Tokie task'ai
  // prisegami eilės kortelės viršuje su srauto ženkleliu — jie yra eilės failai, tik vykdomi.
  const previewed = new Set(buckets.flatMap((bucket) => bucket.tasks.map(taskIdOf)));
  const pinnedLive = [...liveSlots]
    .sort((a, b) => a.index - b.index)
    .filter((slot) => !previewed.has(slot.taskId));

  return (
    <section className="panel">
      <div className="panel-header">
        <div>
          <h2>{t("Task workflow")}</h2>
          <p className="panel-subtitle">{t("Drop Markdown task files into the queue to start new work")}</p>
        </div>
        {running.length > 0 && (
          <div className="running-now" role="status" title={running.join(", ")}>
            <span className="agent-step-pulse" />
            <span className="running-now-label">{t("Running")}:</span>
            <strong>{running.join(", ")}</strong>
          </div>
        )}
      </div>
      <div className="workflow-board">
        {buckets.map((bucket) => (
          <BucketCard
            key={bucket.name}
            bucket={bucket}
            liveByTask={liveByTask}
            pinnedLive={bucket.isQueue ? pinnedLive : []}
            onOpenFolder={onOpenFolder}
            onUpload={onUpload}
            onLoadTasks={onLoadTasks}
          />
        ))}
      </div>
    </section>
  );
});

type BucketCardProps = {
  bucket: WorkflowBucketView;
  liveByTask: LiveByTask;
  /** Srautų task'ai be vietos peržiūroje — rodomi kortelės viršuje (tik eilės kortelei). */
  pinnedLive: readonly WorkflowLiveSlot[];
  onOpenFolder: (bucket: string) => void;
  onUpload: (files: File[]) => Promise<void>;
  onLoadTasks: (bucket: string) => Promise<string[]>;
};

function BucketCard({ bucket, liveByTask, pinnedLive, onOpenFolder, onUpload, onLoadTasks }: BucketCardProps) {
  const { t } = useI18n();
  const upload = useQueueUploadController(onUpload);
  const [allTasks, setAllTasks] = useState<string[] | null>(null);
  const [isLoadingTasks, setIsLoadingTasks] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const isRunning = bucket.variant === "live" && bucket.tasks.length > 0;
  const displayedTasks = allTasks ?? bucket.tasks;
  // Pilname („Show all") sąraše srautų task'ai jau yra savo vietoje — prisegti tik peržiūroje.
  const pinned = allTasks === null ? pinnedLive.filter((slot) => !displayedTasks.some((task) => taskIdOf(task) === slot.taskId)) : [];
  // Eilėje gulintys, bet sraute jau vykdomi: pasakoma kortelėje, o ne slepiama už skaičiaus.
  const liveInBucket = displayedTasks.filter((task) => liveByTask.has(taskIdOf(task))).length + pinned.length;

  // Išskleistas („Show all") sąrašas turi sekti realią būseną. Anksčiau `allTasks` niekada
  // nebūdavo nunulinamas, tad kortelė rodydavo tų pačių senų užduočių sąrašą dar ilgai po to,
  // kai jos pereidavo į kitus bucket'us — badge skaičius atsinaujindavo, sąrašas ne
  // (2026-08-06 UI auditas). Šviežias serverio snapshot'as grąžina kortelę į suglaustą būseną.
  // Raktas — JSON, ne sujungimas skirtuku: skirtukas turėtų būti simbolis, kurio nėra failų
  // varduose, o NUL šaltinyje git'ui reiškia dvejetainį failą.
  const bucketTasksKey = JSON.stringify(bucket.tasks);
  useEffect(() => {
    setAllTasks(null);
  }, [bucketTasksKey]);

  const loadAllTasks = async () => {
    setIsLoadingTasks(true);
    setLoadError(null);
    try {
      setAllTasks(await onLoadTasks(bucket.name));
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsLoadingTasks(false);
    }
  };

  return (
    <article
      className={`workflow-card workflow-card--${bucket.name} ${toneClass[bucket.variant]}${isRunning ? " workflow-card--running" : ""}`}
    >
      <div className="workflow-card-top">
        <div>
          {/* Bucket'o vardas verčiamas (LT režime likdavo `queue`/`human-review`); mašininis vardas
              lieka `Open folder` mygtuko `aria-label`, nes juo kalbama su CLI ir katalogais. */}
          <h3>{t(bucket.name)}</h3>
          <p>{t(bucket.description)}</p>
        </div>
        <span className={`badge ${badgeClass[bucket.variant]}`}>{bucket.totalTasks}</span>
      </div>
      <ul className="task-list">
        {pinned.map((slot) => {
          const label = taskFileLabel(`${slot.taskId}.md`);
          return (
            <li key={`live:${slot.taskId}`} title={fill(t("Running in stream {stream}"), { stream: slot.index })}>
              {label.id && <b className="task-id">{label.id}</b>}
              <span className="task-name">{label.name}</span>
              <span className="badge status-live">{`${t("Stream")} ${slot.index}`}</span>
            </li>
          );
        })}
        {displayedTasks.length > 0 || pinned.length > 0 ? (
          displayedTasks.map((task) => {
            const label = taskFileLabel(task);
            const live = liveByTask.get(taskIdOf(task));
            return (
              // PILNAS vardas lieka `title`: sąrašas trumpinamas, informacija — ne.
              <li key={task} title={live ? fill(t("Running in stream {stream}"), { stream: live.index }) : task}>
                {label.id && <b className="task-id">{label.id}</b>}
                <span className="task-name">{label.name}</span>
                {live && <span className="badge status-live">{`${t("Stream")} ${live.index}`}</span>}
              </li>
            );
          })
        ) : (
          <li className="empty-task">{t("No tasks")}</li>
        )}
      </ul>
      {liveInBucket > 0 && (
        <p className="task-list-summary" role="status">
          {fill(t("{count} of these are running in worktree streams right now"), { count: liveInBucket })}
        </p>
      )}
      {bucket.totalTasks > displayedTasks.length && (
        <button className="button ghost small-button" type="button" disabled={isLoadingTasks} onClick={() => void loadAllTasks()}>
          {isLoadingTasks ? t("Loading...") : `${t("Show all")} (${bucket.totalTasks})`}
        </button>
      )}
      {loadError && <p className="task-list-summary" role="alert">{t("Could not load tasks")}: {loadError}</p>}
      {allTasks && allTasks.length >= bucket.totalTasks && <p className="task-list-summary">{t("Showing all")} {allTasks.length} {t("tasks")}</p>}
      {bucket.isQueue && (
        <div
          className={`queue-dropzone${upload.isDragOver ? " drag-over" : ""}${upload.isUploading ? " uploading" : ""}`}
          onDragOver={(event) => {
            event.preventDefault();
            upload.dragOver();
          }}
          onDragLeave={upload.dragLeave}
          onDrop={(event) => {
            event.preventDefault();
            if (event.dataTransfer?.files) upload.dropFiles(event.dataTransfer.files);
          }}
        >
          {/* NE FOKUSUOJAMAS (2026-08-24, operatoriaus radinys). Šis laukas yra 1×1 px, permatomas
              ir be `pointer-events` — jį atidaro TIK mygtukas „Pasirinkti" žemiau. Bet jis liko
              tab tvarkoje, tad klaviatūros naudotojas užlipdavo ant nematomo valdiklio: fokusas
              dingdavo iš ekrano be jokio matomo žymens, o `Enter` ties juo nedarydavo nieko.
              `tabIndex={-1}` palieka jį programiniam atidarymui ir išima iš grandinės; kartu
              `aria-hidden`, nes tikrasis prieinamas valdiklis yra mygtukas, o du to paties
              veiksmo įėjimai skaitytuve skambėtų kaip du skirtingi. */}
          <input
            ref={upload.fileInputRef}
            className="queue-file-input"
            type="file"
            accept=".md,text/markdown"
            multiple
            tabIndex={-1}
            aria-hidden="true"
            onChange={upload.selectFiles}
          />
          <div>
            <strong>{t("Drop .md files")}</strong>
            <span>{t("or choose files")}</span>
          </div>
          <button className="button ghost small-button" type="button" onClick={upload.openFilePicker}>
            {t("Choose")}
          </button>
        </div>
      )}
      {bucket.isQueue && upload.uploadError && (
        <p className="task-list-summary" style={{ color: "var(--error)" }} role="alert">
          {t("Upload failed")}: {t(upload.uploadError)}
        </p>
      )}
      <button
        className="button ghost small-button"
        type="button"
        aria-label={`${t("Open folder")}: ${bucket.name}`}
        onClick={() => onOpenFolder(bucket.name)}
      >
        {t("Open folder")}
      </button>
    </article>
  );
}
