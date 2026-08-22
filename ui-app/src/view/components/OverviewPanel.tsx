import { memo } from "react";
import type { OverviewMetric } from "../../model/dashboardViewModel";
import { Badge } from "./Badge";
import { useI18n } from "../../i18n/I18nContext";

type Props = { metrics: OverviewMetric[] };

export const OverviewPanel = memo(function OverviewPanel({ metrics }: Props) {
  const { t } = useI18n();
  return (
    <section className="panel">
      <h2>{t("Key signals")}</h2>
      <div className="summary">
        {metrics.map((m) => (
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
