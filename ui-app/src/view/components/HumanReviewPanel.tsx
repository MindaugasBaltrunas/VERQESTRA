import { memo, useState } from "react";
import { useHumanReviewController } from "../../controller/useHumanReviewController";
import type { TaskTriageAction } from "../../controller/useHumanReviewController";
import { useI18n } from "../../i18n/I18nContext";

type PendingConfirm = { taskId: string; action: TaskTriageAction } | null;

const ACTION_LABEL: Record<TaskTriageAction, string> = {
  requeue: "Approve / Requeue",
  complete: "Complete",
};

export const HumanReviewPanel = memo(function HumanReviewPanel() {
  const { t } = useI18n();
  const { tasks, loaded, error, busyTaskId, errors, requeue, complete, reload } = useHumanReviewController();
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirm>(null);

  async function confirm() {
    if (!pendingConfirm) return;
    const { taskId, action } = pendingConfirm;
    await (action === "requeue" ? requeue(taskId) : complete(taskId));
  }

  if (error) {
    return (
      <section className="panel">
        <div className="panel-header"><h2>{t("Human review")}</h2></div>
        <div className="notice notice-warning" role="alert">
          {t("Failed to load human review tasks")}: {error}
          <button className="button ghost small-button" type="button" onClick={() => void reload()}>
            {t("Try again")}
          </button>
        </div>
      </section>
    );
  }

  if (!loaded) {
    return (
      <section className="panel">
        <div className="panel-header"><h2>{t("Human review")}</h2></div>
        <p className="panel-subtitle">{t("Loading...")}</p>
      </section>
    );
  }

  if (tasks.length === 0) {
    return (
      <section className="panel">
        <div className="panel-header"><h2>{t("Human review")}</h2></div>
        <div className="inbox-zero">
          <span>✓</span>
          <strong>{t("No tasks currently require a human decision.")}</strong>
        </div>
      </section>
    );
  }

  return (
    <section className="panel">
      <div className="panel-header">
        <div>
          <h2>{t("Human review")}</h2>
          <p className="panel-subtitle">{t("Tasks that automation cannot resolve without a human decision")}</p>
        </div>
        <span className="badge status-warning">{tasks.length}</span>
      </div>
      <div className="recommendation-list">
        {tasks.map((task) => {
          const busy = busyTaskId === task.task_id;
          const taskError = errors[task.task_id];
          const confirming = pendingConfirm?.taskId === task.task_id;

          return (
            <details key={task.file} className="recommendation-card" open>
              <summary>
                <div><strong>{task.title}</strong></div>
                {task.reason && <span>{task.reason}</span>}
              </summary>
              <div className="recommendation-body">
                {task.blocked_by && (
                  <p className="runtime-explanation">{t("Blocked by")}: {task.blocked_by}</p>
                )}
                <pre>{task.preview}</pre>
                {taskError && (
                  <div className="notice notice-warning" role="alert">
                    {t("Action failed")}: {taskError}
                  </div>
                )}
                <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap", marginTop: "0.5rem" }}>
                  {confirming ? (
                    <>
                      <button
                        className="button success small-button"
                        type="button"
                        disabled={busy}
                        onClick={() => void confirm()}
                      >
                        {taskError ? t("Retry") : `${t("Confirm")}: ${t(ACTION_LABEL[pendingConfirm.action])}`}
                      </button>
                      <button
                        className="button ghost small-button"
                        type="button"
                        disabled={busy}
                        onClick={() => setPendingConfirm(null)}
                      >
                        {t("Cancel")}
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        className="button success small-button"
                        type="button"
                        disabled={busy}
                        onClick={() => setPendingConfirm({ taskId: task.task_id, action: "requeue" })}
                      >
                        {t(ACTION_LABEL.requeue)}
                      </button>
                      <button
                        className="button ghost small-button"
                        type="button"
                        disabled={busy}
                        onClick={() => setPendingConfirm({ taskId: task.task_id, action: "complete" })}
                      >
                        {t(ACTION_LABEL.complete)}
                      </button>
                    </>
                  )}
                </div>
              </div>
            </details>
          );
        })}
      </div>
    </section>
  );
});
