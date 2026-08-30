import { memo } from "react";
import type { OverviewMetric, WorkerControlView } from "../../model/dashboardViewModel";
import type { SlotProgressView } from "../../model/slotProgressViewModel";
import { Badge } from "./Badge";
import { useI18n } from "../../i18n/I18nContext";

type Props = {
  metrics: OverviewMetric[];
  slotProgress?: SlotProgressView[];
  workerControl?: WorkerControlView;
};

function w2LiveMetric(slotProgress?: SlotProgressView[]): OverviewMetric | null {
  const w2 = slotProgress?.find((s) => s.workerId === "w2");
  if (!w2 || w2.taskId === null) return null;
  const value = w2.elapsedMs !== null ? `${w2.taskId} (${Math.round(w2.elapsedMs / 60000)}m)` : w2.taskId;
  return { label: "W2 live task", value, variant: "live" };
}

function waveModeMetric(workerControl?: WorkerControlView): OverviewMetric | null {
  if (!workerControl?.lastWaveKnown) return null;
  const value = workerControl.grantedOf <= 1 ? "sequential" : `parallel ${workerControl.granted}/${workerControl.grantedOf}`;
  return { label: "Wave mode", value, variant: "neutral" };
}

export const OverviewPanel = memo(function OverviewPanel({ metrics, slotProgress, workerControl }: Props) {
  const { t } = useI18n();
  const extraMetrics = [w2LiveMetric(slotProgress), waveModeMetric(workerControl)].filter(
    (m): m is OverviewMetric => m !== null,
  );
  const allMetrics = [...metrics, ...extraMetrics];
  return (
    <section className="panel">
      <h2>{t("Key signals")}</h2>
      <div className="summary">
        {allMetrics.map((m) => (
          <div key={m.label} className="metric">
            <div className="metric-label">{t(m.label)}</div>
            <div className="metric-value" title={m.title ? t(m.title) : undefined}>
              <Badge text={m.value} variant={m.variant} />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
});
