import { memo } from "react";
import type { FastPathStats, TokenDistributionStats, TokenUsageTotals } from "../../model/tokenUsageViewModel";
import { useI18n } from "../../i18n/I18nContext";

type Props = {
  totals: TokenUsageTotals;
  fastPathStats: FastPathStats;
  perRecordTokenStats: TokenDistributionStats;
  perTaskTokenStats: TokenDistributionStats;
};

function formatNumber(value: number, locale: string): string {
  return Math.round(value).toLocaleString(locale);
}

function formatPercent(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 1 }).format(value);
}

function formatRatio(value: number, locale: string): string {
  return `${new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value)}×`;
}

export const TokenUsageSummaryPanel = memo(function TokenUsageSummaryPanel({
  totals,
  fastPathStats,
  perRecordTokenStats,
  perTaskTokenStats,
}: Props) {
  const { t, locale, language } = useI18n();
  const metrics = [
    { label: t("Total tokens"), value: formatNumber(totals.totalTokens, locale), hint: "Input, output, cache read, and cache creation tokens." },
    { label: t("Unique tasks"), value: formatNumber(totals.uniqueTasks, locale), hint: "Number of distinct task IDs." },
    { label: t("Tokens / task"), value: formatNumber(totals.tokensPerTask, locale), hint: "Total tokens divided by unique tasks." },
    { label: t("Tokens / record"), value: formatNumber(totals.tokensPerRecord, locale), hint: "Total tokens divided by telemetry records." },
    { label: t("Output / uncached input"), value: formatRatio(totals.outputInputRatio, locale), hint: "output_tokens / input_tokens" },
    { label: t("Cache hit rate"), value: formatPercent(totals.cacheHitRate, locale), hint: "cache_read / (input + cache_read + cache_creation)" },
  ];

  const tokenDetails = [
    { label: t("Input"), value: totals.inputTokens },
    { label: t("Output"), value: totals.outputTokens },
    { label: t("Cache read"), value: totals.cacheReadTokens },
    { label: t("Cache creation"), value: totals.cacheCreationTokens },
  ];

  return (
    <section className="panel usage-summary-panel">
      <div className="usage-section-heading">
        <div>
          <h2>{t("Efficiency summary")}</h2>
          <p>{t("Selected-period volume and cache effectiveness")}</p>
        </div>
        <div className="usage-record-coverage" title="Visi telemetrijos įrašai, įskaitant fazes be usage duomenų">
          {formatNumber(totals.records, locale)} {t("Telemetry records").toLowerCase()}
        </div>
      </div>
      <div className="summary">
        {metrics.map((m) => (
          <div key={m.label} className="metric" title={m.hint}>
            <div className="metric-label">{m.label}</div>
            <div className="metric-value">{m.value}</div>
          </div>
        ))}
      </div>
      <div className="token-detail-strip" aria-label={t("Token composition")}>
        {tokenDetails.map((item) => (
          <div key={item.label}>
            <span>{item.label}</span>
            <strong>{formatNumber(item.value, locale)}</strong>
          </div>
        ))}
      </div>

      {/* TIKROJI kaina doleriais. Telemetrija `total_cost_usd` neša nuo pat pradžių, o visas šis
          ekranas — apie kainą — rodė tik tokenus. Rodoma TIK kai bent vienas įrašas ją turi:
          `$0.00` iš nekainuotos imties yra išmatuotas teiginys apie nemokamą darbą. Kai kainą
          turi ne visi įrašai, vardiklis stovi šalia — dalinai kainuota imtis kitaip skaitoma
          kaip visa sąskaita. */}
      {totals.costRecords > 0 && (
        <p className="usage-cost-line">
          <span>{t("Recorded cost")}</span>{" "}
          <strong>
            {new Intl.NumberFormat(locale, { style: "currency", currency: "USD" }).format(totals.costUsd)}
          </strong>{" "}
          {totals.costRecords < totals.records && (
            <small>
              ({t("priced records")}: {formatNumber(totals.costRecords, locale)} /{" "}
              {formatNumber(totals.records, locale)})
            </small>
          )}
        </p>
      )}

      <p className="usage-cache-explainer">
        <strong>{t("Cache hit rate")}</strong> = cache_read / (input + cache_read + cache_creation) —{" "}
        {language === "lt"
          ? "prompto tokenų dalis, perskaityta iš cache vietoj pakartotinio apdorojimo. Cache atsiperka, kai skaitymų daugiau nei rašymų:"
          : "the share of prompt tokens read from cache instead of processed again. Cache pays off when reads exceed writes:"}{" "}
        <strong>{formatRatio(totals.cacheReadToCreationRatio, locale)}</strong>{" "}
        ({formatNumber(totals.cacheReadTokens, locale)} read vs{" "}
        {formatNumber(totals.cacheCreationTokens, locale)} creation).
      </p>

      <div className="usage-insights">
        <div>
          <span>{t("Fast-path (preflight)")}</span>
          <strong>{formatPercent(fastPathStats.preflightFastPathRate, locale)}</strong>
          <b>
            {formatNumber(fastPathStats.preflightFastPath, locale)} / {formatNumber(fastPathStats.preflightTotal, locale)} {t("without LLM")}
          </b>
        </div>
        <div>
          <span>{t("Fast-path (diagnose)")}</span>
          <strong>{formatPercent(fastPathStats.diagnoseFastPathRate, locale)}</strong>
          <b>
            {formatNumber(fastPathStats.diagnoseFastPath, locale)} / {formatNumber(fastPathStats.diagnoseTotal, locale)} {t("without full LLM")}
          </b>
        </div>
        <div>
          <span>Tokens / record (mean / median / p95)</span>
          <strong>{formatNumber(perRecordTokenStats.mean, locale)}</strong>
          <b>
            med {formatNumber(perRecordTokenStats.median, locale)} · p95 {formatNumber(perRecordTokenStats.p95, locale)}
          </b>
        </div>
        <div>
          <span>Tokens / task (mean / median / p95)</span>
          <strong>{formatNumber(perTaskTokenStats.mean, locale)}</strong>
          <b>
            med {formatNumber(perTaskTokenStats.median, locale)} · p95 {formatNumber(perTaskTokenStats.p95, locale)}
          </b>
        </div>
      </div>
    </section>
  );
});
