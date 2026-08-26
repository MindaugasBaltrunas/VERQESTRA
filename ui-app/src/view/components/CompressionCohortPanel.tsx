import { useMemo } from "react";
import type { BenchmarkCompressionSection, BenchmarkCompressionVariant } from "../../model/types";
import { tProse, useI18n } from "../../i18n/I18nContext";

/**
 * Kompresijos kohorta: canary vs control (2026-08-24).
 *
 * `AG/benchmark` šią sekciją skaičiavo ir siuntė per `/api/benchmark/report`, o dashboard'as
 * neturėjo net jos tipo. Praktinė pasekmė: vienintelis eksperimentas, dėl kurio kompresijos nauda
 * apskritai FALSIFIKUOJAMA, ekrane neegzistavo — jį matydavo tik tas, kas paleisdavo ataskaitą
 * terminale.
 *
 * Trys taisyklės, kurios yra šios panelės kontraktas:
 *
 *   1. NEMATUOTA ≠ NULIS. `undefined` KPI rodomas kaip „—", o ne kaip 0: pastarasis reikštų
 *      IŠMATUOTĄ nulinę kainą, t. y. tiksliai priešingą teiginį nei „duomenų nėra".
 *   2. VERDIKTO PRIEŽASTYS RODOMOS KAIP KODAI. Jos neverčiamos ir neperfrazuojamos — būtent jų
 *      ieškoma ataskaitoje ir log'e.
 *   3. APRIBOJIMAI RODOMI VISADA. Sekcija, parodyta be to, ko ji negali teigti, kviečia perskaityti
 *      ją kaip įrodymą, kurio ji neneša.
 *
 * Nė vienas skaičius čia neperskaičiuojamas: deltas, rodiklius ir verdiktą suveda backend'as
 * (BENCH cost-KPI). Perskaičiavimas pastatytų prieš operatorių antrą, galimai nesutariantį atsakymą.
 */

type Formatters = { num: (value: number | undefined) => string; pct: (value: number | undefined) => string };

function VariantRow({
  variant,
  isBaseline,
  format,
}: {
  variant: BenchmarkCompressionVariant;
  isBaseline: boolean;
  format: Formatters & { delta: (value: number | undefined, relative: number | undefined) => string };
}) {
  const { t } = useI18n();
  const tone =
    variant.verdict === "accepted" ? "status-good" : variant.verdict === "rejected" ? "status-error" : "status-neutral";
  const delta = variant.billableTokensPerAcceptedTaskDelta;

  return (
    <tr className={isBaseline ? "compression-baseline" : undefined}>
      <th scope="row">
        <code>{variant.variantId}</code>
        {isBaseline && <span className="badge status-neutral">{t("baseline")}</span>}
        {/* Funkcijos yra varianto TAPATYBĖ, ne dekoracija: du variantai tuo pačiu vardu, bet
            skirtingomis funkcijomis, yra du skirtingi eksperimentai. */}
        {variant.features.length > 0 && <small>{variant.features.join(", ")}</small>}
      </th>
      <td><span className={`badge ${tone}`}>{t(variant.verdict)}</span></td>
      <td>
        {/* Vardiklis rodomas kartu su KPI: „kiek" be „iš kiek" neleidžia spręsti apie patikimumą. */}
        {variant.capturedUsageCount} / {variant.conclusiveCount} / {variant.sampleCount}
      </td>
      <td>{format.num(variant.billableTokensPerAcceptedTask)}</td>
      {/* Mažiau tokenų = geriau, todėl NEIGIAMAS delta yra teigiamas rezultatas. Spalva seka
          prasmę, ne ženklą. */}
      <td className={delta === undefined ? undefined : delta < 0 ? "delta-better" : "delta-worse"}>
        {format.delta(delta, variant.billableTokensPerAcceptedTaskRelativeDelta)}
      </td>
      <td>{format.num(variant.rawTokensPerAcceptedTask)}</td>
      <td>{format.pct(variant.acceptedRate)}</td>
      <td>{format.pct(variant.securityFailureRate)}</td>
    </tr>
  );
}

export function CompressionCohortPanel({ section }: { section: BenchmarkCompressionSection | undefined }) {
  const { t, locale } = useI18n();

  const format = useMemo(() => {
    const number = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 });
    const percent = new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 1 });
    const signedPercent = new Intl.NumberFormat(locale, {
      style: "percent",
      maximumFractionDigits: 1,
      signDisplay: "always",
    });
    const signedNumber = new Intl.NumberFormat(locale, { maximumFractionDigits: 2, signDisplay: "always" });
    return {
      num: (value: number | undefined) => (value === undefined ? "—" : number.format(value)),
      pct: (value: number | undefined) => (value === undefined ? "—" : percent.format(value)),
      delta: (value: number | undefined, relative: number | undefined) => {
        if (value === undefined) return "—";
        const absolute = signedNumber.format(value);
        return relative === undefined ? absolute : `${absolute} (${signedPercent.format(relative)})`;
      },
    };
  }, [locale]);

  // Sekcijos nebuvimas NĖRA „kompresija nieko nedavė": ataskaita, kurios kohortos niekas nesuvedė,
  // apie kompresiją nesako nieko. Tylėti čia teisingiau nei parodyti tuščią lentelę, kurią galima
  // perskaityti kaip nulinį rezultatą.
  if (!section) return null;

  const rejected = section.variants.filter((variant) => variant.verdict === "rejected");

  return (
    <section className="panel" aria-labelledby="compression-cohort-title">
      <div className="panel-header">
        <div>
          <p className="usage-eyebrow">{t("Canary vs control")}</p>
          <h2 id="compression-cohort-title">{t("Compression cohort")}</h2>
          <p className="panel-subtitle">{t("Whether context compression actually paid for itself.")}</p>
        </div>
        <span className="badge status-neutral">{t("Cost KPI")} v{section.costKpiVersion}</span>
      </div>

      {section.variants.length === 0 ? (
        <p className="panel-subtitle">{t("The cohort declares no variants.")}</p>
      ) : (
        <div className="table-scroll">
          <table className="diagnostics-table">
            <thead>
              <tr>
                <th scope="col">{t("Variant")}</th>
                <th scope="col">{t("Verdict")}</th>
                <th scope="col">{t("Usable / conclusive / samples")}</th>
                <th scope="col">{t("Billable per accepted task")}</th>
                <th scope="col">{t("Delta vs baseline")}</th>
                <th scope="col">{t("Raw per accepted task")}</th>
                <th scope="col">{t("Accepted rate")}</th>
                <th scope="col">{t("Security failures")}</th>
              </tr>
            </thead>
            <tbody>
              {section.variants.map((variant) => (
                <VariantRow
                  key={variant.variantId}
                  variant={variant}
                  isBaseline={variant.variantId === section.baselineVariantId}
                  format={format}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {section.combination && (
        <div className="compression-combination">
          <h3>
            {t("Feature contributions")} <code>{section.combination.variantId}</code>
          </h3>
          {/* Ženklas čia PRIEŠINGAS lentelės deltoms: tai sutaupymas, todėl teigiamas skaičius yra
              neišleisti tokenai. Perverstas ženklas skaitytojui reikštų tiksliai atvirkščiai, tad
              jis paliekamas toks, kokį suvedė paketas, ir įvardijamas paantraštėje. */}
          <p className="panel-subtitle">{t("Positive means tokens not spent. Contributions do not add up.")}</p>
          <ul>
            {section.combination.featureContributions.map((entry) => (
              <li key={entry.feature}>
                <code>{entry.feature}</code>{" "}
                {/* Funkcija, niekada nepaleista atskirai, yra „—", o ne atimtis iš derinio:
                    pastaroji paskelbtų aritmetinę tapatybę kaip matavimą. */}
                {entry.variantId === ""
                  ? t("no single-feature variant was run")
                  : `${format.num(entry.contribution)} (${format.pct(entry.relativeContribution)})`}
              </li>
            ))}
          </ul>
          <p className="panel-subtitle">
            {t("Sum of measured contributions")}: {format.num(section.combination.sumOfSingleFeatureContributions)}
            {" · "}
            {t("Observed")}: {format.num(section.combination.observedCombinationContribution)}
            {" · "}
            {t("Interaction residual")}: {format.num(section.combination.interactionResidual)}
          </p>
        </div>
      )}

      {rejected.length > 0 && (
        <div className="budget-reasons">
          <strong>{t("Rejected variants")}</strong>
          <ul>
            {rejected.map((variant) => (
              <li key={variant.variantId}>
                <code>{variant.variantId}</code>{" "}
                {variant.reasons.length === 0
                  ? t("No reason recorded")
                  : variant.reasons.map((reason) => <code key={reason}>{reason}</code>)}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Nepriskirti bandymai NEĮĖJO į jokį agregatą — tylėti apie juos reikštų rodyti dalinę
          imtį kaip pilną. */}
      {section.unattributedSampleCount > 0 && (
        <p className="notice notice-warning" role="status">
          {t("Samples outside every declared variant")}: {section.unattributedSampleCount}
        </p>
      )}

      {section.limitations.length > 0 && (
        <div className="budget-reasons">
          <strong>{t("This section cannot claim")}</strong>
          {/* Serverio proza verčiama per tProse (2026-08-26) — eilutės ateina duomenyse. */}
          <ul>{section.limitations.map((line) => <li key={line}>{tProse(t, line)}</li>)}</ul>
        </div>
      )}
    </section>
  );
}
