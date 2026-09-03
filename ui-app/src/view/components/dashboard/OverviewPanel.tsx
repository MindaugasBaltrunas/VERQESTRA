import { memo } from "react";
import type { OverviewMetric, WorkerControlView } from "../../../model/dashboardViewModel";
import type { SlotProgressView } from "../../../model/slotProgressViewModel";
import { Badge } from "../shared/Badge";
import { useI18n } from "../../../i18n/I18nContext";

type Props = {
  metrics: OverviewMetric[];
  slotProgress?: SlotProgressView[];
  workerControl?: WorkerControlView;
};

/**
 * Gyvos užduotys per KIEKVIENĄ srautą. Iki 2026-09-02 čia buvo tik W2: W1 gyva užduotis ekrane
 * egzistavo vien per pirminio medžio žymę, kuri worktree bangų metu rodė svetimą task'ą.
 * Etiketės raktai (`W1 live task`, `W2 live task`) gyvena žodyne — srautų yra lygiai du.
 */
function slotLiveMetrics(slotProgress?: SlotProgressView[]): OverviewMetric[] {
  return (slotProgress ?? [])
    .filter((slot) => slot.taskId !== null)
    .map((slot) => ({
      label: `${slot.workerId.toUpperCase()} live task`,
      value: slot.elapsedMs !== null ? `${slot.taskId} (${Math.round(slot.elapsedMs / 60000)}m)` : `${slot.taskId}`,
      variant: "live" as const,
    }));
}

function slotFailureMetrics(slotProgress?: SlotProgressView[]): OverviewMetric[] {
  return (slotProgress ?? [])
    .flatMap((slot) =>
      slot.lastError === null
        ? []
        : [
            {
              label: `${slot.workerId.toUpperCase()} last failure`,
              value: slot.lastError.reason,
              title: `${slot.lastError.ts} — ${slot.lastError.taskId}`,
              variant: "error" as const,
            },
          ],
    );
}

/**
 * `parallel 1/2` skaitėsi kaip „dirba lygiagrečiai", nors antras slot'as buvo ATMESTAS. Kai
 * išduota mažiau nei prašyta, tai pasakoma pačioje reikšmėje; priežastis lieka `#/system` kortelėje.
 */
function waveModeMetric(workerControl?: WorkerControlView): OverviewMetric | null {
  if (!workerControl?.lastWaveKnown) return null;
  const { granted, grantedOf } = workerControl;
  const value =
    grantedOf <= 1
      ? "sequential"
      : granted >= grantedOf
        ? `parallel ${granted}/${grantedOf}`
        : `parallel ${granted}/${grantedOf} granted`;
  return { label: "Wave mode", value, variant: granted >= grantedOf || grantedOf <= 1 ? "neutral" : "warning" };
}

export const OverviewPanel = memo(function OverviewPanel({ metrics, slotProgress, workerControl }: Props) {
  const { t } = useI18n();
  const waveMode = waveModeMetric(workerControl);
  // Gyvi srautai eina PIRMI: jie atsako į „kas vyksta dabar", o pirminio medžio įrašai — į „kuo
  // baigėsi ankstesnis bėgimas" (jų etiketes tai jau sako).
  const allMetrics = [
    ...slotLiveMetrics(slotProgress),
    ...(waveMode === null ? [] : [waveMode]),
    ...metrics,
    ...slotFailureMetrics(slotProgress),
  ];
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
