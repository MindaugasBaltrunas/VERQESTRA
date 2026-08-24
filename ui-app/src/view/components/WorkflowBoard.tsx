import { memo, useEffect, useState } from "react";
import type { WorkflowBucketView, BucketVariant } from "../../model/dashboardViewModel";
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

type Props = {
  buckets: WorkflowBucketView[];
  onOpenFolder: (bucket: string) => void;
  onUpload: (files: File[]) => Promise<void>;
  onLoadTasks: (bucket: string) => Promise<string[]>;
};

export const WorkflowBoard = memo(function WorkflowBoard({ buckets, onOpenFolder, onUpload, onLoadTasks }: Props) {
  const { t } = useI18n();
  const runningTasks = buckets
    .filter((b) => (b.name === "delegated" || b.name === "active") && b.tasks.length > 0)
    .flatMap((b) => b.tasks);

  return (
    <section className="panel">
      <div className="panel-header">
        <div>
          <h2>{t("Task workflow")}</h2>
          <p className="panel-subtitle">{t("Drop Markdown task files into the queue to start new work")}</p>
        </div>
        {runningTasks.length > 0 && (
          <div className="running-now" role="status" title={runningTasks.join(", ")}>
            <span className="agent-step-pulse" />
            <span className="running-now-label">{t("Running")}:</span>
            <strong>{runningTasks.join(", ")}</strong>
          </div>
        )}
      </div>
      <div className="workflow-board">
        {buckets.map((bucket) => (
          <BucketCard
            key={bucket.name}
            bucket={bucket}
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
  onOpenFolder: (bucket: string) => void;
  onUpload: (files: File[]) => Promise<void>;
  onLoadTasks: (bucket: string) => Promise<string[]>;
};

function BucketCard({ bucket, onOpenFolder, onUpload, onLoadTasks }: BucketCardProps) {
  const { t } = useI18n();
  const upload = useQueueUploadController(onUpload);
  const [allTasks, setAllTasks] = useState<string[] | null>(null);
  const [isLoadingTasks, setIsLoadingTasks] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const isRunning = bucket.variant === "live" && bucket.tasks.length > 0;
  const displayedTasks = allTasks ?? bucket.tasks;

  // Išskleistas („Show all") sąrašas turi sekti realią būseną. Anksčiau `allTasks` niekada
  // nebūdavo nunulinamas, tad kortelė rodydavo tų pačių senų užduočių sąrašą dar ilgai po to,
  // kai jos pereidavo į kitus bucket'us — badge skaičius atsinaujindavo, sąrašas ne
  // (2026-08-06 UI auditas). Šviežias serverio snapshot'as grąžina kortelę į suglaustą būseną.
  const bucketTasksKey = bucket.tasks.join("\u0000");
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
          <h3>{bucket.name}</h3>
          <p>{t(bucket.description)}</p>
        </div>
        <span className={`badge ${badgeClass[bucket.variant]}`}>{bucket.totalTasks}</span>
      </div>
      <ul className="task-list">
        {displayedTasks.length > 0 ? (
          displayedTasks.map((task) => {
            const label = taskFileLabel(task);
            return (
              // PILNAS vardas lieka `title`: sąrašas trumpinamas, informacija — ne.
              <li key={task} title={task}>
                {label.id && <b className="task-id">{label.id}</b>}
                <span className="task-name">{label.name}</span>
              </li>
            );
          })
        ) : (
          <li className="empty-task">{t("No tasks")}</li>
        )}
      </ul>
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
