import type { PeriodComparison, ReworkProxyStats } from "../../model/tokenUsageViewModel";
import { useI18n } from "../../i18n/I18nContext";

type Props = {
  comparison: PeriodComparison;
  rework: ReworkProxyStats;
  isPartial: boolean;
};

function Delta({
  value,
  percentagePoints = false,
  favorableIncrease = false,
}: {
  value: number | null;
  percentagePoints?: boolean;
  favorableIncrease?: boolean;
}) {
  if (value === null) return <span className="analytics-delta neutral">—</span>;
  const formatted = percentagePoints
    ? `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1, signDisplay: "always" }).format(value * 100)} pp`
    : new Intl.NumberFormat(undefined, { style: "percent", maximumFractionDigits: 1, signDisplay: "always" }).format(value);
  const favorable = value !== 0 && (favorableIncrease ? value > 0 : value < 0);
  return (
    <span className={`analytics-delta ${value === 0 ? "neutral" : favorable ? "favorable" : "unfavorable"}`}>
      {formatted}
    </span>
  );
}

export function AnalyticsDecisionPanel({ comparison, rework, isPartial }: Props) {
  const { t, locale } = useI18n();
  const number = (value: number) => value.toLocaleString(locale, { maximumFractionDigits: 0 });
  const percent = (value: number) => value.toLocaleString(locale, { style: "percent", maximumFractionDigits: 1 });

  return (
    <section className="analytics-decision-panel" aria-labelledby="decision-intelligence-title">
      <div className="analytics-decision-heading">
        <div>
          <p className="usage-eyebrow">{t("Decision intelligence")}</p>
          <h3 id="decision-intelligence-title">{t("Period change and rework signals")}</h3>
          <p>
            {comparison.available
              ? `${t("Latest")} ${comparison.daysPerPeriod} ${t("days")} ${t("compared with the previous equal period")}.`
              : t("At least two days of data are needed for period comparison.")}
          </p>
        </div>
        {isPartial && <span className="data-scope-badge">{t("Loaded records only")}</span>}
      </div>
      <div className="analytics-decision-grid">
        <article>
          <span>{t("Token volume change")}</span>
          <strong>{comparison.available ? number(comparison.current.totalTokens) : "—"}</strong>
          <Delta value={comparison.tokenDelta} />
          <small>{t("vs previous equal period")}</small>
        </article>
        <article>
          <span>{t("Tokens per task change")}</span>
          <strong>{comparison.available ? number(comparison.current.tokensPerTask) : "—"}</strong>
          <Delta value={comparison.tokensPerTaskDelta} />
          <small>{t("Lower is generally more efficient")}</small>
        </article>
        <article>
          <span>{t("Cache hit-rate change")}</span>
          <strong>{comparison.available ? percent(comparison.current.cacheHitRate) : "—"}</strong>
          <Delta value={comparison.cacheHitRateDelta} percentagePoints favorableIncrease />
          <small>{t("Higher means more prompt reuse")}</small>
        </article>
        <article>
          <span>{t(rework.isExact ? "Retry tokens" : "Diagnostic / rework proxy")}</span>
          <strong>{number(rework.isExact ? rework.exactRetryTokens : rework.diagnosisTokens)}</strong>
          <span className="analytics-delta neutral">
            {percent(rework.isExact ? rework.exactRetryTokenShare : rework.diagnosisTokenShare)}
          </span>
          <small>
            {rework.isExact
              ? `${rework.retryAttempts} ${t("retry attempts")} · ${rework.failedRetryAttempts} ${t("failed")}.`
              : `${rework.tasksWithDiagnosis} ${t("tasks")} · ${percent(rework.taskShare)}. ${t("Counts only model-backed diagnose tokens; it is not a waste metric.")}`}
          </small>
          {!rework.isExact && rework.metadataCoverage > 0 && (
            <small>{t("Exact retry metadata coverage")}: {percent(rework.metadataCoverage)}</small>
          )}
          {/* „Kiek" be „kodėl" pasako, kad problema yra, bet ne kur ji yra: 40 pakartojimų dėl
              `rate-limit` ir 40 dėl `gate-failed` reikalauja priešingų veiksmų. Rodomos trys
              dažniausios — pilnas sąrašas priklauso žurnalui, ne suvestinei. Kodai NEVERČIAMI. */}
          {rework.retryReasons.length > 0 && (
            <small className="rework-reasons">
              {t("Why")}:{" "}
              {rework.retryReasons.slice(0, 3).map((entry) => (
                <span key={entry.reason}>
                  <code>{entry.reason}</code> {entry.count}{" "}
                </span>
              ))}
            </small>
          )}
        </article>
      </div>
    </section>
  );
}
