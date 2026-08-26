// Benchmark palyginimo VAIZDAS: kas su kuo lyginama, kieno rezultatai geresni ir ką visa tai
// reiškia (2026-08-26 operatoriaus užsakymas: aiški diagrama + apibendrinančios išvados +
// paaiškinimai).
//
// Trys sąžiningumo taisyklės, kurios čia yra dizainas, o ne detalės:
//   1. NUGALĖTOJAS skaičiuojamas tik tarp ag-loop ir agent-solo — deterministic-control pagal
//      paties raporto deklaraciją yra „a floor rather than a competitor", tad jo stulpelis
//      rodomas, bet varžybose nedalyvauja (kitaip nulinė kaina „laimėtų" kiekvieną kainos eilutę).
//   2. Loop-only metrikos (repairRate, humanReviewRate) į dvikovą NEĮTRAUKIAMOS: solo nulis ten
//      reiškia „mechanizmo nėra", ne „pasiekta" — tai deklaruota paties raporto differences
//      sekcijoje („a zero that means absent, not achieved").
//   3. Puslapis neperskaičiuoja nė vienos METRIKOS — jis tik lygina dvi jau suskaičiuotas
//      reikšmes tarpusavyje (prezentacinis „kuri didesnė"), o autoritetingas verdiktas lieka
//      serverio badge'as.

import { useMemo } from "react";
import { useI18n } from "../../i18n/I18nContext";
import type { BenchmarkMetricRow, BenchmarkModeSection } from "../../model/types";

type Direction = "higher" | "lower";

type ComparedMetric = {
  metric: string;
  betterWhen: Direction;
  /** Loop-only mechanizmas: rodomas, bet dvikovoje nedalyvauja (žr. taisyklę 2). */
  loopOnly?: boolean;
};

/** Kuriuos rodiklius lyginame ir kuria kryptimi „geriau". Tvarka = atvaizdavimo tvarka. */
const COMPARED_METRICS: readonly ComparedMetric[] = [
  { metric: "acceptedRate", betterWhen: "higher" },
  { metric: "firstPassRate", betterWhen: "higher" },
  { metric: "outOfScopeRate", betterWhen: "lower" },
  { metric: "architectureFailureRate", betterWhen: "lower" },
  { metric: "securityFailureRate", betterWhen: "lower" },
  { metric: "testFailureRate", betterWhen: "lower" },
  { metric: "repairRate", betterWhen: "lower", loopOnly: true },
  { metric: "humanReviewRate", betterWhen: "lower", loopOnly: true },
  { metric: "perVerifiedAcceptedChange.billableTokens", betterWhen: "lower" },
  { metric: "perVerifiedAcceptedChange.llmCalls", betterWhen: "lower" },
  { metric: "perVerifiedAcceptedChange.durationMs", betterWhen: "lower" },
];

/** Dvikovos dalyviai (taisyklė 1). */
const COMPETITORS = ["ag-loop", "agent-solo"] as const;
const FLOOR_MODE = "deterministic-control";

function rowOf(section: BenchmarkModeSection | undefined, metric: string): BenchmarkMetricRow | undefined {
  return section?.metrics.find((row) => row.metric === metric);
}

function winnerOf(
  spec: ComparedMetric,
  loop: BenchmarkMetricRow | undefined,
  solo: BenchmarkMetricRow | undefined,
): (typeof COMPETITORS)[number] | "tie" | undefined {
  if (spec.loopOnly) return undefined;
  const a = loop?.current;
  const b = solo?.current;
  if (a === undefined || b === undefined) return undefined;
  if (a === b) return "tie";
  const loopWins = spec.betterWhen === "higher" ? a > b : a < b;
  return loopWins ? "ag-loop" : "agent-solo";
}

/**
 * Kompaktiška „kurį naudoti" eilutė VERDIKTO paneliui (2026-08-26 operatoriaus pastaba:
 * atsakymas „kas naudingiau" privalo matytis pirmame ekrane, ne tik kortelėje žemiau).
 * Ta pati trijų šakų logika kaip vertės kortelės verdiktas — vienas sprendimas, dvi vietos.
 */
export function BenchmarkWorthLine({ modes }: { modes: BenchmarkModeSection[] }) {
  const { t, locale } = useI18n();
  const percent = useMemo(() => new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 1 }), [locale]);
  const compact = useMemo(() => new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 }), [locale]);
  const decimal = useMemo(() => new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }), [locale]);

  const loop = modes.find((mode) => mode.mode === "ag-loop");
  const solo = modes.find((mode) => mode.mode === "agent-solo");
  const accLoop = rowOf(loop, "acceptedRate")?.current;
  const accSolo = rowOf(solo, "acceptedRate")?.current;
  const costLoop = rowOf(loop, "perVerifiedAcceptedChange.billableTokens")?.current;
  const costSolo = rowOf(solo, "perVerifiedAcceptedChange.billableTokens")?.current;
  if (accLoop === undefined || accSolo === undefined || costLoop === undefined || costSolo === undefined || costSolo <= 0) {
    return null;
  }

  const quality = `${percent.format(accLoop)} ${t("vs")} ${percent.format(accSolo)}`;
  const price = `${compact.format(costLoop)} ${t("vs")} ${compact.format(costSolo)} tok. ${t("per verified accepted change")}`;

  return (
    <p className="benchmark-verdict-tokens">
      <strong>{t("Worth using")}:</strong>{" "}
      {accLoop > accSolo && costLoop >= costSolo ? (
        <>
          <strong>ag-loop</strong> — +{decimal.format((accLoop - accSolo) * 100)} p.p. {t("quality")} ({quality}){" "}
          {t("for")} +{percent.format(costLoop / costSolo - 1)} {t("price")} ({price}).{" "}
          {t("Cheaper per attempt does not mean cheaper per result once quality is counted.")}
        </>
      ) : accLoop >= accSolo && costLoop < costSolo ? (
        <><strong>ag-loop</strong> — {t("both better and cheaper")} ({quality}; {price}).</>
      ) : (
        <><strong>agent-solo</strong> — {t("cheaper per successful change")} ({price}), {t("quality")}: {quality}.</>
      )}
    </p>
  );
}

export function BenchmarkInsights({ modes }: { modes: BenchmarkModeSection[] }) {
  const { t, locale } = useI18n();
  const percent = useMemo(() => new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 1 }), [locale]);
  const compact = useMemo(() => new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 }), [locale]);
  const decimal = useMemo(() => new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }), [locale]);

  const bySection = useMemo(() => new Map(modes.map((mode) => [mode.mode, mode])), [modes]);
  const loop = bySection.get("ag-loop");
  const solo = bySection.get("agent-solo");
  const floor = bySection.get(FLOOR_MODE);

  const formatValue = (metric: string, kind: "rate" | "cost" | undefined, value: number | undefined): string => {
    if (value === undefined) return "n/a";
    if (kind === "rate") return percent.format(value);
    if (metric.endsWith(".durationMs")) return `${decimal.format(value / 1000)} s`;
    if (metric.endsWith(".llmCalls")) return decimal.format(value);
    return `${compact.format(value)} tok.`;
  };

  // Stulpelio plotis — santykis su didžiausia rodoma reikšme toje eilutėje; nulinė reikšmė gauna
  // simbolinį minimumą, kad stulpelis egzistuotų kaip „išmatuotas nulis", ne kaip tuštuma.
  const widthOf = (value: number | undefined, max: number): number => {
    if (value === undefined || max <= 0) return 0;
    return Math.max(3, Math.round((value / max) * 100));
  };

  const duel = COMPARED_METRICS.map((spec) => {
    const rows = {
      "ag-loop": rowOf(loop, spec.metric),
      "agent-solo": rowOf(solo, spec.metric),
      [FLOOR_MODE]: rowOf(floor, spec.metric),
    };
    return { spec, rows, winner: winnerOf(spec, rows["ag-loop"], rows["agent-solo"]) };
  });

  const wins = {
    "ag-loop": duel.filter((entry) => entry.winner === "ag-loop").length,
    "agent-solo": duel.filter((entry) => entry.winner === "agent-solo").length,
    tie: duel.filter((entry) => entry.winner === "tie").length,
  };

  // Apibendrinimo skaičiai — tik iš JAU rodomų reikšmių (taisyklė 3).
  const accLoop = rowOf(loop, "acceptedRate")?.current;
  const accSolo = rowOf(solo, "acceptedRate")?.current;
  const costLoop = rowOf(loop, "perVerifiedAcceptedChange.billableTokens")?.current;
  const costSolo = rowOf(solo, "perVerifiedAcceptedChange.billableTokens")?.current;
  const scopeLoop = rowOf(loop, "outOfScopeRate")?.current;
  const scopeSolo = rowOf(solo, "outOfScopeRate")?.current;

  const haveDuel = loop !== undefined && solo !== undefined;

  return (
    <>
      {haveDuel && (
        <section className="panel benchmark-conclusions" aria-label={t("Conclusions")}>
          <div className="panel-header">
            <div>
              <h2>{t("Which mode is worth using?")}</h2>
              <p className="panel-subtitle">{t("Quality and token price side by side. Price per verified accepted change already includes every failed attempt — it is the honest cost of one successful change.")}</p>
            </div>
            <span className="benchmark-score">
              ag-loop <strong>{wins["ag-loop"]}</strong> : <strong>{wins["agent-solo"]}</strong> agent-solo
              {wins.tie > 0 ? ` (${t("ties")}: ${wins.tie})` : ""}
            </span>
          </div>

          {/* Vertės kortelė: kokybė + drausmė + kaina už PAVYKUSĮ pakeitimą, greta, su 🏆 prie
              geresnės pusės kiekvienoje eilutėje. */}
          <div className="table-scroll">
            <table className="benchmark-value-table">
              <thead>
                <tr>
                  <th />
                  <th>ag-loop</th>
                  <th>agent-solo</th>
                  <th>{t("Difference")}</th>
                </tr>
              </thead>
              <tbody>
                {accLoop !== undefined && accSolo !== undefined && (
                  <tr>
                    <td>{t("Quality")} <small>({t("verifier acceptance")})</small></td>
                    <td className={accLoop > accSolo ? "value-winner" : ""}>{percent.format(accLoop)}{accLoop > accSolo ? " 🏆" : ""}</td>
                    <td className={accSolo > accLoop ? "value-winner" : ""}>{percent.format(accSolo)}{accSolo > accLoop ? " 🏆" : ""}</td>
                    <td>+{decimal.format(Math.abs(accLoop - accSolo) * 100)} p.p.</td>
                  </tr>
                )}
                {scopeLoop !== undefined && scopeSolo !== undefined && (
                  <tr>
                    <td>{t("Discipline")} <small>({t("out-of-scope changes")})</small></td>
                    <td className={scopeLoop < scopeSolo ? "value-winner" : ""}>{percent.format(scopeLoop)}{scopeLoop < scopeSolo ? " 🏆" : ""}</td>
                    <td className={scopeSolo < scopeLoop ? "value-winner" : ""}>{percent.format(scopeSolo)}{scopeSolo < scopeLoop ? " 🏆" : ""}</td>
                    <td>{scopeLoop > 0 && scopeSolo > 0 ? `${decimal.format(Math.max(scopeLoop, scopeSolo) / Math.min(scopeLoop, scopeSolo))}×` : `+${decimal.format(Math.abs(scopeLoop - scopeSolo) * 100)} p.p.`}</td>
                  </tr>
                )}
                {costLoop !== undefined && costSolo !== undefined && (
                  <tr>
                    <td>{t("Price per successful change")} <small>(billable tok.)</small></td>
                    <td className={costLoop < costSolo ? "value-winner" : ""}>{compact.format(costLoop)}{costLoop < costSolo ? " 🏆" : ""}</td>
                    <td className={costSolo < costLoop ? "value-winner" : ""}>{compact.format(costSolo)}{costSolo < costLoop ? " 🏆" : ""}</td>
                    <td>{costSolo > 0 ? `${costLoop >= costSolo ? "+" : "−"}${percent.format(Math.abs(costLoop / costSolo - 1))}` : "n/a"}</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {accLoop !== undefined && accSolo !== undefined && costLoop !== undefined && costSolo !== undefined && costSolo > 0 && (
            <p className="benchmark-value-verdict">
              {accLoop > accSolo && costLoop >= costSolo ? (
                <>
                  <strong>ag-loop</strong> {t("charges")} +{percent.format(costLoop / costSolo - 1)}{" "}
                  {t("more per successful change, and that premium buys")}{" "}
                  +{decimal.format((accLoop - accSolo) * 100)} p.p. {t("quality")}
                  {scopeLoop !== undefined && scopeSolo !== undefined && scopeLoop < scopeSolo && (
                    <> {t("and")} {scopeLoop > 0 ? `${decimal.format(scopeSolo / scopeLoop)}×` : ""} {t("fewer scope violations")}</>
                  )}
                  . {t("For unattended work the orchestrator is worth the price; for cheap supervised experiments the solo agent is.")}
                </>
              ) : accLoop >= accSolo && costLoop < costSolo ? (
                <><strong>ag-loop</strong> {t("is both better and cheaper per successful change — there is no trade-off in this run.")}</>
              ) : (
                <><strong>agent-solo</strong> {t("delivers a successful change cheaper in this run — check the discipline row before trusting it unattended.")}</>
              )}
            </p>
          )}
        </section>
      )}

      <section className="panel benchmark-duel" aria-label={t("Mode duel")}>
        <div className="panel-header">
          <div>
            <h2>{t("Who is better, metric by metric")}</h2>
            <p className="panel-subtitle">
              {t("Bars show the current run. The trophy marks the better of the two paid modes; deterministic-control is the harness floor, not a competitor.")}
            </p>
          </div>
        </div>
        <div className="benchmark-duel-grid">
          {duel.map(({ spec, rows, winner }) => {
            const values = [rows["ag-loop"]?.current, rows["agent-solo"]?.current, rows[FLOOR_MODE]?.current];
            const max = Math.max(...values.filter((value): value is number => value !== undefined), 0);
            const kind = rows["ag-loop"]?.kind ?? rows["agent-solo"]?.kind;
            return (
              <div key={spec.metric} className="benchmark-duel-row">
                <div className="benchmark-duel-label">
                  <span>{spec.metric}</span>
                  <small>
                    {spec.loopOnly
                      ? t("ag-loop only: the solo mode has no such mechanism, its zero means absent")
                      : spec.betterWhen === "higher" ? t("higher is better") : t("lower is better")}
                  </small>
                </div>
                <div className="benchmark-duel-bars">
                  {([...COMPETITORS, FLOOR_MODE] as const).map((mode) => {
                    const row = rows[mode];
                    const isWinner = winner === mode;
                    const isFloor = mode === FLOOR_MODE;
                    return (
                      <div key={mode} className={`benchmark-duel-bar${isFloor ? " floor" : ""}${isWinner ? " winner" : ""}`}>
                        <span className="benchmark-duel-mode">{mode}{isWinner ? " 🏆" : ""}</span>
                        <div className="benchmark-duel-track">
                          <div className={`benchmark-duel-fill mode-${mode}`} style={{ width: `${widthOf(row?.current, max)}%` }} />
                        </div>
                        <span className="benchmark-duel-value">{formatValue(spec.metric, kind, row?.current)}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section className="panel benchmark-glossary" aria-label={t("What is being compared")}>
        <div className="panel-header">
          <div>
            <h2>{t("What is being compared, and why")}</h2>
            <p className="panel-subtitle">{t("Every mode, metric and term on this page, explained.")}</p>
          </div>
        </div>

        <details open>
          <summary>{t("Execution modes")}</summary>
          <dl className="benchmark-glossary-list">
            <dt>ag-loop</dt>
            <dd>{t("The full VERQESTRA orchestrator: task queue, preflight, context pack, quality gates, repair loop and verification. This is the system being measured — its value must show up here.")}</dd>
            <dt>agent-solo</dt>
            <dd>{t("The same agent and model with no orchestration: one prompt, one attempt, no gates. The control that answers what the orchestrator adds on top of the raw model.")}</dd>
            <dt>deterministic-control</dt>
            <dd>{t("No model at all — a scripted reaction to the scenario. It bounds what the harness itself costs and what share of the suite is solvable without intelligence; it competes with nobody.")}</dd>
          </dl>
        </details>

        <details>
          <summary>{t("Quality metrics")}</summary>
          <dl className="benchmark-glossary-list">
            <dt>acceptedRate</dt>
            <dd>{t("Share of cells an independent verifier accepted. The verifier's word, never the agent's — an agent claiming success counts for nothing here.")}</dd>
            <dt>firstPassRate</dt>
            <dd>{t("Share accepted on the first attempt, before any repair. High first-pass with high accepted means the loop rarely needs its safety nets.")}</dd>
            <dt>repairRate</dt>
            <dd>{t("Share of cells where the loop's repair cycle ran. Only ag-loop has one; a rise means first attempts are getting worse.")}</dd>
            <dt>humanReviewRate</dt>
            <dd>{t("Share of cells the loop parked for a human decision instead of claiming success. This is a safety valve, not a failure — but a high rate means the loop under-claims finished work.")}</dd>
          </dl>
        </details>

        <details>
          <summary>{t("Discipline metrics")}</summary>
          <dl className="benchmark-glossary-list">
            <dt>outOfScopeRate</dt>
            <dd>{t("Share of cells that changed files outside the scenario's declared boundary. The orchestrator enforces the boundary with gates; the solo agent has only the prompt.")}</dd>
            <dt>architectureFailureRate</dt>
            <dd>{t("Share of cells that broke the fixture's architecture rules (layer imports, forbidden dependencies).")}</dd>
            <dt>securityFailureRate</dt>
            <dd>{t("Share of cells that failed a security check (leaked secrets, skipped validation).")}</dd>
            <dt>testFailureRate</dt>
            <dd>{t("Share of cells whose scenario checks (tests) failed at the end.")}</dd>
          </dl>
        </details>

        <details>
          <summary>{t("Cost metrics")}</summary>
          <dl className="benchmark-glossary-list">
            <dt>perAcceptedChange.*</dt>
            <dd>{t("Total cost of the whole population divided by changes the AGENT claimed. Cheap-looking when the agent claims generously.")}</dd>
            <dt>perVerifiedAcceptedChange.*</dt>
            <dd>{t("The same cost divided by changes the VERIFIER granted. The honest price of one usable change — and the gap between the two cost bases is itself a measurement of over- or under-claiming.")}</dd>
            <dt>billableTokens / llmCalls / durationMs</dt>
            <dd>{t("What one verified accepted change costs in paid tokens, model calls and wall-clock time, including every failed attempt that led to it.")}</dd>
          </dl>
        </details>

        <details>
          <summary>{t("Terms")}</summary>
          <dl className="benchmark-glossary-list">
            <dt>{t("Cell")}</dt>
            <dd>{t("One scenario in one mode, once. The suite runs 24 scenarios x 3 modes x 3 repetitions; every number on this page is an aggregate over cells.")}</dd>
            <dt>{t("Baseline")}</dt>
            <dd>{t("A sealed earlier run this run is compared against. Stable means nothing got worse versus that seal; the verdict badge at the top is that comparison's result.")}</dd>
            <dt>{t("Repetitions")}</dt>
            <dd>{t("Nondeterministic scenarios run three times (BENCH-9), so a lucky single run cannot pass as a result.")}</dd>
            <dt>{t("Unmeasured cell")}</dt>
            <dd>{t("A cell that produced no valid telemetry is stored as unmeasured, never as a zero — an absent number and a measured zero are different facts.")}</dd>
          </dl>
        </details>
      </section>
    </>
  );
}
