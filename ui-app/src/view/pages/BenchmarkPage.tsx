import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchBenchmarkReport } from "../../model/api";
import type {
  BenchmarkComparisonVerdict,
  BenchmarkMetricRow,
  BenchmarkModeSection,
  BenchmarkReportView,
  BenchmarkScenarioSection,
} from "../../model/types";
import { tProse, useI18n } from "../../i18n/I18nContext";
import { BenchmarkInsights } from "../components/BenchmarkInsights";
import { CompressionCohortPanel } from "../components/CompressionCohortPanel";
import { Header, type Route } from "../components/Header";

// Read-only view over the backend's authoritative benchmark report
// (BENCH-10, BENCH-11). Every number shown here is read off `report` as the
// backend computed it; this page must never re-derive a rate, a delta or a
// verdict, or it would put a second, possibly disagreeing, answer in front of
// the operator.

type Props = { activeRoute: Route; onNavigate: (route: Route) => void };

const HEADLINE_MODE_PREFERENCE = "ag-loop";

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function verdictTone(verdict: BenchmarkComparisonVerdict): "good" | "error" | "neutral" {
  if (verdict === "improved" || verdict === "stable") return "good";
  if (verdict === "regressed") return "error";
  return "neutral";
}

function findMetric(mode: BenchmarkModeSection | undefined, metric: string): BenchmarkMetricRow | undefined {
  return mode?.metrics.find((row) => row.metric === metric);
}

function abbreviateCommit(commit: string): string {
  return commit === "" ? "—" : commit.slice(0, 12);
}


/**
 * Žinomi palyginimo priežasčių kodai → sakiniai operatoriui. Nepažįstamas kodas grąžinamas
 * žalias: techninis faktas geriau nei nutylėjimas, o naujo kodo atsiradimas serveryje
 * neturi tyliai virsti tuščiu sąrašu.
 */
function humanizeVerdictReason(reason: string, t: (text: string) => string): string {
  if (reason === "within-thresholds") {
    return t("Every compared metric stayed inside its allowed threshold — nothing got worse versus the baseline.");
  }
  if (reason === "no-baseline-comparison") {
    return t("There was no baseline to compare against, so no verdict about change can be drawn.");
  }
  return reason;
}

export function BenchmarkPage({ activeRoute, onNavigate }: Props) {
  const { t, locale } = useI18n();
  const percent = useMemo(() => new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 1 }), [locale]);
  const compact = useMemo(() => new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 }), [locale]);
  const decimal = useMemo(() => new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }), [locale]);
  const [data, setData] = useState<BenchmarkReportView>();
  const [error, setError] = useState<string>();
  const [selectedMode, setSelectedMode] = useState<string>();
  const [selectedScenarioKey, setSelectedScenarioKey] = useState<string>();

  const load = useCallback(async () => {
    setError(undefined);
    try {
      setData(await fetchBenchmarkReport());
    } catch (nextError) {
      setError(toMessage(nextError));
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const report = data?.report;
  const modes = useMemo(() => report?.modes ?? [], [report]);
  const scenarios = useMemo(() => report?.scenarios ?? [], [report]);

  useEffect(() => {
    if (modes.length === 0) { setSelectedMode(undefined); return; }
    setSelectedMode((current) => (current && modes.some((mode) => mode.mode === current) ? current : modes[0].mode));
  }, [modes]);
  useEffect(() => {
    if (scenarios.length === 0) { setSelectedScenarioKey(undefined); return; }
    const key = (scenario: BenchmarkScenarioSection) => `${scenario.scenarioId}/${scenario.mode}`;
    setSelectedScenarioKey((current) =>
      current && scenarios.some((scenario) => key(scenario) === current) ? current : key(scenarios[0]));
  }, [scenarios]);

  const activeModeSection = modes.find((mode) => mode.mode === selectedMode);
  const headlineMode = modes.find((mode) => mode.mode === HEADLINE_MODE_PREFERENCE) ?? modes[0];
  const selectedScenario = scenarios.find((scenario) => `${scenario.scenarioId}/${scenario.mode}` === selectedScenarioKey);
  const regressedScenarios = scenarios.filter((scenario) => scenario.verdict === "regressed");

  const formatRate = useCallback((value: number | undefined) => (value === undefined ? "n/a" : percent.format(value)), [percent]);
  const formatTokens = useCallback((value: number | undefined) => (value === undefined ? "n/a" : compact.format(value)), [compact]);
  // VIENETAI pagal metriką (2026-08-26 auditas, L3): visi `cost` langeliai buvo formatuojami vienu
  // compact skaičiumi — `durationMs` rodėsi „147.9K" be „ms", ir skaitytojas negalėjo atskirti
  // tokenų nuo milisekundžių nuo kvietimų skaičiaus. Vienetas išvedamas iš metrikos VARDO, nes
  // wire kontraktas kind'ų smulkiau neskiria — vardas yra vienintelis vieneto šaltinis.
  const formatCost = useCallback((metric: string, value: number | undefined) => {
    if (value === undefined) return "n/a";
    if (metric.endsWith(".durationMs")) return `${decimal.format(value / 1000)} s`;
    if (metric.endsWith(".llmCalls")) return decimal.format(value);
    return `${compact.format(value)} tok.`;
  }, [compact, decimal]);
  const formatDelta = useCallback((row: BenchmarkMetricRow | undefined) => {
    if (!row) return undefined;
    if (row.relativeDelta !== undefined) {
      return new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 1, signDisplay: "always" }).format(row.relativeDelta);
    }
    // BENCH-7: santykinis delta neegzistuoja, kai baseline nulis — bet absoliutus tada VIS TIEK
    // išmatuotas (pvz. securityFailureRate 0 → 0). Rodyti n/a čia reikštų „nepalyginta", nors
    // palyginta ir nepasikeitė; rate rodomas procentiniais punktais, cost — skaičiumi.
    if (row.absoluteDelta === undefined) return undefined;
    if (row.kind === "rate") {
      const points = new Intl.NumberFormat(locale, { maximumFractionDigits: 1, signDisplay: "always" }).format(row.absoluteDelta * 100);
      return `${points} p.p.`;
    }
    return new Intl.NumberFormat(locale, { maximumFractionDigits: 1, signDisplay: "always" }).format(row.absoluteDelta);
  }, [locale]);

  return (
    <>
      <Header root="" onRefresh={() => void load()} activeRoute={activeRoute} onNavigate={onNavigate} />
      <main>
        <div className="page-heading">
          <div>
            <p className="page-eyebrow">{t("Engineering intelligence")}</p>
            <h2>{t("Benchmark")}</h2>
            <p>{t("Authoritative benchmark verdict, reliability, and baseline comparison for VERQESTRA.")}</p>
          </div>
        </div>

        {error && (
          <div className="notice notice-error" role="alert">
            {t("Could not load benchmark report")}: {error}{" "}
            <button className="button ghost small-button" type="button" onClick={() => void load()}>{t("Try again")}</button>
          </div>
        )}
        {!data && !error && <div className="panel">{t("Loading...")}</div>}

        {data && (data.state === "missing" || data.state === "corrupt") && (
          <div className="panel inbox-zero">
            <span>{data.state === "missing" ? "○" : "!"}</span>
            <strong>{t("No benchmark report available")}</strong>
            <p>{data.reason}</p>
            <p><code>{data.source.command}</code></p>
          </div>
        )}

        {data && report && (
          <div className="benchmark-page">
            {/* Stale banner'is PAŠALINTAS (2026-08-26, operatoriaus sprendimas): aktyviame repo
                jis degė beveik visada ir tapo triukšmu. Šviežumo tiesa lieka matoma be jo —
                proveniencijos kortelė rodo, kuriam commit'ui verdiktas galioja, o serveris
                (`/api/benchmark/report`, CLI) `state: "stale"` toliau deklaruoja pilnai. */}

            {/* Verdikto panelis atsako TRIS klausimus žmogaus kalba (2026-08-26 operatoriaus
                pastaba: „within-thresholds yra nesąmonė"): 1) KAS su kuo lyginta, 2) koks
                NUOSPRENDIS ir ką jis reiškia, 3) koks TOKENŲ rezultatas. Vidiniai priežasčių
                kodai verčiami sakiniais; nepažįstamas kodas rodomas žalias — geriau techninis
                faktas nei nutylėjimas. Visi skaičiai — jau esami raporto laukai, jokių
                perskaičiavimų. */}
            <section className="panel" aria-label={t("Benchmark verdict")}>
              <div className="panel-header">
                <div>
                  <h2>{t("Verdict")}</h2>
                  <p className="panel-subtitle">
                    {report.verdictBasis === "no-baseline"
                      ? t("No baseline comparison was supplied.")
                      : report.baseline
                        ? `${t("Compared")}: ${t("current run")} (${abbreviateCommit(report.current.identity.agCommit)}, ${report.current.sampleCount} ${t("samples")}) ${t("vs")} baseline (${abbreviateCommit(report.baseline.identity.agCommit)}, ${report.baseline.sampleCount} ${t("samples")}) · ${report.scenarios.length} ${t("scenario comparisons")}`
                        : t("Compared against the stored baseline.")}
                  </p>
                </div>
                <span className={`badge status-${verdictTone(report.verdict)}`}>{t(report.verdict)}</span>
              </div>
              {report.reasons.length > 0 && (
                <ul className="benchmark-reasons">
                  {report.reasons.map((reason) => <li key={reason}>{humanizeVerdictReason(reason, t)}</li>)}
                </ul>
              )}
            </section>

            <section className="benchmark-kpis" aria-label={t("Headline metrics")}>
              {/* L5 (2026-08-26): KPI yra VIENO režimo pjūvis — be šios eilutės skaitytojas juos
                  palaikytų viso rinkinio rodikliais. */}
              {headlineMode && <p className="panel-subtitle benchmark-kpi-caption">{t("Headline mode")}: <strong>{headlineMode.mode}</strong></p>}
              <BenchmarkKpi label={t("Accepted rate")} row={findMetric(headlineMode, "acceptedRate")} format={formatRate} delta={formatDelta} />
              <BenchmarkKpi label={t("First-pass rate")} row={findMetric(headlineMode, "firstPassRate")} format={formatRate} delta={formatDelta} />
              {/* 2026-08-26: metrikos vardas suderintas su REALIU serverio raportu —
                  `.billableTokens`, ne `.tokens` (pastarasis buvo nusirašytas nuo pasenusio
                  modelio doc pavyzdžio ir niekada neegzistavo emituojamame JSON). */}
              <BenchmarkKpi label={t("Tokens per verified accepted change")} row={findMetric(headlineMode, "perVerifiedAcceptedChange.billableTokens")} format={formatTokens} delta={formatDelta} />
              <BenchmarkKpi label={t("Human review rate")} row={findMetric(headlineMode, "humanReviewRate")} format={formatRate} delta={formatDelta} />
            </section>

            {/* Proveniencijos/run-facts blokas PAŠALINTAS visas (2026-08-26, operatoriaus
                sprendimas): kas lyginta su kuo — verdikto paantraštėje, o pilna proveniencija
                lieka serverio JSON'e ir CLI raporte tiems, kam jos prireiks. */}

            {/* Išvados + dvikovos diagrama + žodynėlis (2026-08-26): kas su kuo lyginama ir kas
                laimi — PRIEŠ žalią lentelių sieną, nes skaitytojo pirmas klausimas yra verdiktas
                žmogaus kalba, o ne 11 metrikų sąrašas. */}
            <BenchmarkInsights modes={modes} />

            {modes.length > 0 && (
              <section className="panel">
                <div className="panel-header">
                  <div><h2>{t("Mode comparison")}</h2><p className="panel-subtitle">{t("Every BENCH-7 metric, baseline vs. current, one execution mode at a time.")}</p></div>
                </div>
                <div className="segmented-control" aria-label={t("Execution modes")}>
                  {modes.map((mode) => (
                    <button key={mode.mode} type="button" className={selectedMode === mode.mode ? "active" : ""} aria-pressed={selectedMode === mode.mode} onClick={() => setSelectedMode(mode.mode)}>
                      {mode.mode}
                    </button>
                  ))}
                </div>
                {activeModeSection && (
                  <>
                    {/* A5: aprėptis prie tab'o — kiek celių kiekvienoje pusėje šis režimas turi. */}
                    <p className="panel-subtitle">
                      {t("Samples")}: {t("Baseline")} {activeModeSection.baselineSampleCount ?? "n/a"} · {t("Current")} {activeModeSection.currentSampleCount ?? "n/a"}
                    </p>
                    {activeModeSection.differences.length > 0 && (
                      <ul className="benchmark-mode-differences">
                        {/* Serverio proza verčiama per tProse (2026-08-26): detail sakiniai
                            ateina raporto duomenyse, ne per statinius i18n raktus. */}
                        {activeModeSection.differences.map((difference) => (
                          <li key={`${difference.aspect}/${difference.code}`}><strong>{t(difference.aspect)}</strong>: {tProse(t, difference.detail)}</li>
                        ))}
                      </ul>
                    )}
                    <div className="table-scroll">
                      <table>
                        <thead><tr><th>{t("Metric")}</th><th>{t("Baseline")}</th><th>{t("Current")}</th><th>{t("Change")}</th></tr></thead>
                        <tbody>
                          {activeModeSection.metrics.map((row) => (
                            <tr key={row.metric}>
                              <td>{row.metric}</td>
                              <td>{row.kind === "rate" ? formatRate(row.baseline) : formatCost(row.metric, row.baseline)}</td>
                              <td>{row.kind === "rate" ? formatRate(row.current) : formatCost(row.metric, row.current)}</td>
                              <td>{formatDelta(row) ?? "n/a"}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </>
                )}
              </section>
            )}

            <section className="panel">
              {/* L4: distribucijos matas įvardytas — mediana/vidurkis yra billable TOKENAI vienai
                  celei (paketo DEFAULT_SCENARIO_MEASURE), ne trukmė ir ne kvietimai. */}
              <div className="panel-header"><div><h2>{t("Scenario results")}</h2><p className="panel-subtitle">{t("Select a scenario to see its full distribution.")} {t("Values are billable tokens per cell.")}</p></div></div>
              {scenarios.length === 0 ? (
                <div className="inbox-zero"><span>○</span><strong>{t("No scenario results in this report")}</strong></div>
              ) : (
                <>
                  <div className="table-scroll">
                    <table>
                      <thead><tr><th>{t("Scenario")}</th><th>{t("Mode")}</th><th>{t("Verdict")}</th><th>{t("Baseline median")}</th><th>{t("Current median")}</th><th>{t("Success")}</th></tr></thead>
                      <tbody>
                        {scenarios.map((scenario) => {
                          const key = `${scenario.scenarioId}/${scenario.mode}`;
                          const isSelected = selectedScenarioKey === key;
                          return (
                            <tr key={key} className={`benchmark-scenario-row${isSelected ? " selected" : ""}`}>
                              <td>
                                <button
                                  type="button"
                                  className="benchmark-scenario-row-trigger"
                                  aria-pressed={isSelected}
                                  onClick={() => setSelectedScenarioKey(key)}
                                  onKeyDown={(event) => {
                                    if (event.key !== "Enter" && event.key !== " ") return;
                                    event.preventDefault();
                                    setSelectedScenarioKey(key);
                                  }}
                                >
                                  {scenario.scenarioId}
                                </button>
                              </td>
                              <td>{scenario.mode}</td>
                              <td><span className={`badge status-${verdictTone(scenario.verdict)}`}>{t(scenario.verdict)}</span></td>
                              <td>{decimal.format(scenario.baseline.median)}</td>
                              <td>{decimal.format(scenario.current.median)}</td>
                              <td>{scenario.current.successCount}/{scenario.current.count}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  {selectedScenario && (
                    <div className="benchmark-scenario-detail">
                      <div className="panel-header"><div><h3>{selectedScenario.scenarioId} · {selectedScenario.mode}</h3></div><span className={`badge status-${verdictTone(selectedScenario.verdict)}`}>{t(selectedScenario.verdict)}</span></div>
                      {selectedScenario.reasons.length > 0 && (
                        <ul className="benchmark-reasons">{selectedScenario.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
                      )}
                      <div className="table-scroll">
                        <table>
                          <thead><tr><th /><th>{t("Count")}</th><th>{t("Median")}</th><th>{t("Mean")}</th><th>{t("Min")}</th><th>{t("Max")}</th><th>{t("Std. deviation")}</th><th>{t("Successes")}</th></tr></thead>
                          <tbody>
                            <tr>
                              <td>{t("Baseline")}</td>
                              <td>{selectedScenario.baseline.count}</td>
                              <td>{decimal.format(selectedScenario.baseline.median)}</td>
                              <td>{decimal.format(selectedScenario.baseline.mean)}</td>
                              <td>{decimal.format(selectedScenario.baseline.min)}</td>
                              <td>{decimal.format(selectedScenario.baseline.max)}</td>
                              <td>{decimal.format(selectedScenario.baseline.standardDeviation)}</td>
                              <td>{selectedScenario.baseline.successCount}</td>
                            </tr>
                            <tr>
                              <td>{t("Current")}</td>
                              <td>{selectedScenario.current.count}</td>
                              <td>{decimal.format(selectedScenario.current.median)}</td>
                              <td>{decimal.format(selectedScenario.current.mean)}</td>
                              <td>{decimal.format(selectedScenario.current.min)}</td>
                              <td>{decimal.format(selectedScenario.current.max)}</td>
                              <td>{decimal.format(selectedScenario.current.standardDeviation)}</td>
                              <td>{selectedScenario.current.successCount}</td>
                            </tr>
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                </>
              )}
            </section>

            <section className="panel">
              <div className="panel-header"><div><h2>{t("Regression reasons")}</h2></div></div>
              {regressedScenarios.length === 0 ? (
                <p>{t("No regressions in this report.")}</p>
              ) : (
                <ul className="benchmark-regression-list">
                  {regressedScenarios.map((scenario) => (
                    <li key={`${scenario.scenarioId}/${scenario.mode}`}>
                      <strong>{scenario.scenarioId} · {scenario.mode}</strong>
                      <ul className="benchmark-reasons">{scenario.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {/* Kompresijos kohorta rodoma PO scenarijų ir PRIEŠ metodologiją: tai rezultatas, o
                ne prielaida. `report.compression` yra neprivalomas — kai jo nėra, panelė nieko
                nepiešia, nes „nesuvesta kohorta" ir „kompresija nepadėjo" yra skirtingi teiginiai. */}
            <CompressionCohortPanel section={report.compression} />

            <section className="panel">
              <div className="panel-header"><div><h2>{t("Methodology and limitations")}</h2></div></div>
              <ul className="benchmark-reasons">{report.limitations.map((limitation) => <li key={limitation}>{tProse(t, limitation)}</li>)}</ul>
              <p className="benchmark-reproduction"><span>{t("Reproduction")}</span><code>{report.reproduction.command}</code></p>
            </section>
          </div>
        )}
      </main>
    </>
  );
}

function BenchmarkKpi({
  label,
  row,
  format,
  delta,
}: {
  label: string;
  row: BenchmarkMetricRow | undefined;
  format: (value: number | undefined) => string;
  delta: (row: BenchmarkMetricRow | undefined) => string | undefined;
}) {
  const deltaText = delta(row);
  return (
    <article className="benchmark-kpi">
      <span>{label}</span>
      <strong>{format(row?.current)}</strong>
      <small>{deltaText ? `${deltaText} vs. ${format(row?.baseline)}` : format(row?.baseline)}</small>
    </article>
  );
}

