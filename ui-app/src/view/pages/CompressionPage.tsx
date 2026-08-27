import { useCallback, useEffect, useState } from "react";
import { fetchCompression, setCompressionFeature } from "../../model/api";
import type { CompressionFeature, CompressionFeatureValue, CompressionIrPair, CompressionView } from "../../model/types";
import { useI18n } from "../../i18n/I18nContext";
import { Header, type Route } from "../components/Header";

/**
 * Kompresijos vėliavų valdymas ir jų shadow telemetrija.
 *
 * Kodėl šis ekranas egzistuoja: penki jungikliai `vq/config/context-compression.json` keičia, KOKS
 * kontekstas keliauja į vykdytoją, o sprendimas juos kelti remiasi matavimais, kurie iki šiol
 * gyveno tik `vq/logs/context-size.jsonl`. Operatorius turėjo redaguoti JSON ranka ir spėti.
 *
 * Trys taisyklės, kurių šis puslapis laikosi:
 *
 *   1. NIEKO NEPERSKAIČIUOJA. Kiekvienas skaičius atvaizduojamas toks, kokį jį atsiuntė serveris.
 *      Antras skaičiavimas čia reikštų du galimai nesutariančius atsakymus tam pačiam klausimui.
 *   2. SIŪLO TIK TAI, KĄ SERVERIS PRIIMS. `canary` variantas rodomas tik ten, kur `canarySupported`
 *      — `bash_output_digest` sprendimo taškas neturi task konteksto, tad canary ten būtų tyli
 *      „išjungta". Dropdown, siūlantis atmestiną reikšmę, yra blogesnis už jos nebuvimą.
 *   3. PO PERJUNGIMO PERSKAITO IŠ NAUJO. Rodoma serverio būsena, o ne optimistinis spėjimas: kitas
 *      dispatch'as skaitys tą patį failą, ir ekranas privalo sutapti su juo, o ne su noru.
 */

type Props = { activeRoute: Route; onNavigate: (route: Route) => void };

const FEATURE_HINTS: Record<string, string> = {
  worker_task_ir: "Canonical WorkerTaskIR instead of raw task Markdown",
  compact_dsl: "Compact worker DSL renderer",
  symbol_slices: "REF/SIG/SRC tiers in code context",
  bash_output_digest: "Bash/PowerShell output digest in the PostToolUse path",
  dispatch_tool_schema: "Smaller dispatch tool schemas",
};

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `<select>` reikšmės yra tekstas; konvertavimas gyvena VIENOJE vietoje abiem kryptim. */
function toOptionValue(value: CompressionFeatureValue): string {
  return value === "canary" ? "canary" : value ? "true" : "false";
}

function fromOptionValue(raw: string): CompressionFeatureValue {
  if (raw === "canary") return "canary";
  return raw === "true";
}

/** Tik tos `status-*` atmainos, kurioms yra CSS: `good`, `error`, `neutral`. */
function valueTone(value: CompressionFeatureValue): "good" | "neutral" {
  return value === true ? "good" : "neutral";
}

function formatPercent(value: number | undefined): string {
  return value === undefined ? "—" : `${value}%`;
}

/**
 * Verdiktą taria SERVERIS (`decideCompression`) — čia tik kodų vertimo žemėlapiai.
 * Puslapyje skaičiuoti verdiktą reikštų du galimai nesutariančius atsakymus tam pačiam klausimui.
 */
const PRESSURE_SENTENCES: Record<string, string> = {
  insufficient: "Too few samples to judge data pressure — let the loop run and come back",
  none: "No data pressure — packs fit the budget with room to spare",
  moderate: "Moderate pressure — the budget is filling up but not yet exceeded",
  high: "Real pressure — the budget is exceeded or nearly full",
};

const ACTION_LABELS: Record<string, string> = {
  enable: "Worth enabling",
  optional: "Safe but unnecessary now",
  hold: "Do not enable",
  insufficient: "Not enough data",
  unmeasured: "Not measured",
};

const ACTION_TONES: Record<string, "good" | "error" | "neutral"> = {
  enable: "good",
  hold: "error",
  optional: "neutral",
  insufficient: "neutral",
  unmeasured: "neutral",
};

/**
 * Verdikto šaltinio laukas ("kuri pora buvo naudota") verčiamas į sakinį, KAS lyginama — ne vien
 * skaičiai. Be šito operatorius mato „IR mažesnis 4/12" ir turi spėti, ar tai palyginta su tikru
 * worker prompt'u, ar tik senesniu task'o kūno fallback'u.
 */
const PAIR_SENTENCES: Record<CompressionIrPair, string> = {
  prompt: "Compared using the prompt-level pair — the same worker prompt the executor would receive.",
  task: "Compared using the task-level pair — the task body only, an older fallback used when no prompt-level pair was recorded.",
};

const REASON_SENTENCES: Record<string, string> = {
  "ir-larger-on-average":
    "Shadow comparison says the IR form is larger than raw on average — the size guard would refuse every compiled body and dispatch the raw task anyway, so enabling buys nothing",
  "ir-smaller-under-pressure":
    "The IR form is smaller on average and the budget is under pressure — enabling shrinks packs where it matters",
  "ir-smaller-no-pressure":
    "The IR form is smaller on average, but the budget is not under pressure — enabling is safe yet buys nothing right now",
  "too-few-ir-comparisons": "Too few shadow comparisons to decide",
  "no-shadow-measurement": "No shadow measurement exists for this flag yet — there is no data to decide with",
  "larger-on-average":
    "Shadow comparison says the compiled form is larger than raw on average — enabling buys nothing",
  "smaller-under-pressure":
    "The compiled form is smaller on average and the budget is under pressure — enabling shrinks packs where it matters",
  "smaller-no-pressure":
    "The compiled form is smaller on average, but the budget is not under pressure — enabling is safe yet buys nothing right now",
  "too-few-comparisons": "Too few shadow comparisons to decide",
};

export function CompressionPage({ activeRoute, onNavigate }: Props) {
  const { t } = useI18n();
  const [data, setData] = useState<CompressionView | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [pending, setPending] = useState<string | undefined>(undefined);

  const load = useCallback(async () => {
    try {
      setData(await fetchCompression());
      setError(undefined);
    } catch (cause) {
      setError(toMessage(cause));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const change = useCallback(
    async (feature: CompressionFeature, raw: string) => {
      setPending(feature.key);
      setError(undefined);
      try {
        await setCompressionFeature(feature.key, fromOptionValue(raw));
        // Perskaitoma IŠ NAUJO: rodoma serverio tiesa, ne optimistinis spėjimas.
        await load();
      } catch (cause) {
        setError(toMessage(cause));
        // Nepavykus reikšmė lieka sena — `value` ateina iš `data`, kurio nekeitėme.
      } finally {
        setPending(undefined);
      }
    },
    [load],
  );

  return (
    <>
      <Header root="" onRefresh={() => void load()} activeRoute={activeRoute} onNavigate={onNavigate} />
      <main>
        <div className="page-heading">
          <div>
            <p className="page-eyebrow">{t("Engineering intelligence")}</p>
            <h2>{t("Compression")}</h2>
            <p>{t("Context compression flags and the shadow measurements behind them.")}</p>
          </div>
        </div>

        {error && (
          <div className="notice notice-error" role="alert">
            {t("Could not load compression settings")}: {error}{" "}
            <button className="button ghost small-button" type="button" onClick={() => void load()}>
              {t("Try again")}
            </button>
          </div>
        )}
        {!data && !error && <div className="panel">{t("Loading...")}</div>}

        {data && (
          <>
            {data.degraded.length > 0 && (
              <div className="notice notice-warning" role="status">
                {t("Some sources could not be read")}: {data.degraded.join("; ")}
              </div>
            )}

            <section className="panel" aria-labelledby="compression-decision-heading">
              <h3 id="compression-decision-heading" className="panel-header">{t("Is compression worth enabling?")}</h3>
              <p
                className={data.decision.pressure.level === "high" ? "notice notice-warning" : "notice"}
                role="status"
              >
                {t(PRESSURE_SENTENCES[data.decision.pressure.level] ?? data.decision.pressure.level)}
                {" — "}
                {t("avg")} {formatPercent(data.telemetry.avg_budget_percent)}, {t("peak")}{" "}
                {formatPercent(data.telemetry.max_budget_percent)}, {t("exceeded")}{" "}
                {data.telemetry.exceeded_count}/{data.telemetry.sample_count}
              </p>
              <table>
                <thead>
                  <tr>
                    <th scope="col">{t("Flag")}</th>
                    <th scope="col">{t("Recommendation")}</th>
                    <th scope="col">{t("Why")}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.decision.recommendations.map((rec) => (
                    <tr key={rec.key}>
                      <td>
                        <strong>{rec.key}</strong>
                      </td>
                      <td>
                        <span className={`badge status-${ACTION_TONES[rec.action] ?? "neutral"}`}>
                          {t(ACTION_LABELS[rec.action] ?? rec.action)}
                        </span>
                      </td>
                      <td>
                        {t(REASON_SENTENCES[rec.reason] ?? rec.reason)}
                        {rec.key === "worker_task_ir" && data.telemetry.ir_compared_count > 0 && (
                          <>
                            {" "}
                            <span className="muted">
                              ({t("IR smaller in")} {data.telemetry.ir_smaller_count}/{data.telemetry.ir_compared_count}
                              {data.telemetry.avg_ir_delta_percent === undefined
                                ? ""
                                : `, ${t("avg delta")} ${data.telemetry.avg_ir_delta_percent > 0 ? "+" : ""}${data.telemetry.avg_ir_delta_percent}%`}
                              )
                            </span>
                          </>
                        )}
                        {rec.pair !== undefined && (
                          <>
                            <br />
                            <span className="muted">
                              <code>{rec.pair}</code> {t(PAIR_SENTENCES[rec.pair])}
                            </span>
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>

            <section className="panel" aria-labelledby="compression-flags-heading">
              <h3 id="compression-flags-heading" className="panel-header">{t("Feature flags")}</h3>
              <p className="panel-subtitle">
                {t("Changing a flag changes what reaches the executor. The context pack cache keys on this config, so a switch invalidates it automatically.")}
              </p>
              <table>
                <thead>
                  <tr>
                    <th scope="col">{t("Flag")}</th>
                    <th scope="col">{t("Current")}</th>
                    <th scope="col">{t("Set to")}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.features.map((feature) => (
                    <tr key={feature.key}>
                      <td>
                        <strong>{feature.key}</strong>
                        <br />
                        <span className="muted">{t(FEATURE_HINTS[feature.key] ?? feature.key)}</span>
                      </td>
                      <td>
                        <span className={`badge status-${valueTone(feature.value)}`}>
                          {t(toOptionValue(feature.value))}
                        </span>
                      </td>
                      <td>
                        <label className="visually-hidden" htmlFor={`compression-${feature.key}`}>
                          {feature.key}
                        </label>
                        <select
                          id={`compression-${feature.key}`}
                          value={toOptionValue(feature.value)}
                          disabled={pending !== undefined}
                          onChange={(event) => void change(feature, event.target.value)}
                        >
                          <option value="false">{t("false")}</option>
                          <option value="true">{t("true")}</option>
                          {/* Canary rodomas TIK ten, kur serveris jį priims. */}
                          {feature.canary_supported && <option value="canary">{t("canary")}</option>}
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="panel-subtitle">
                {t("Canary cohort")}: {data.canary.percent}%
                {data.canary.salt ? ` · salt "${data.canary.salt}"` : ` · ${t("no salt set")}`}
              </p>
            </section>

            <section className="panel" aria-labelledby="compression-telemetry-heading">
              <h3 id="compression-telemetry-heading" className="panel-header">{t("Shadow telemetry")}</h3>
              <p className="panel-subtitle">
                {t("Measured from context-size.jsonl even while every flag is off — that is what makes deciding possible before enabling.")}
              </p>
              <table>
                <tbody>
                  <tr>
                    <th scope="row">{t("Samples")}</th>
                    <td>{data.telemetry.sample_count}</td>
                  </tr>
                  <tr>
                    <th scope="row">{t("Avg budget used")}</th>
                    <td>{formatPercent(data.telemetry.avg_budget_percent)}</td>
                  </tr>
                  <tr>
                    <th scope="row">{t("Peak budget used")}</th>
                    <td>{formatPercent(data.telemetry.max_budget_percent)}</td>
                  </tr>
                  <tr>
                    <th scope="row">{t("Budget exceeded")}</th>
                    <td>
                      <span className={`badge status-${data.telemetry.exceeded_count > 0 ? "error" : "good"}`}>
                        {data.telemetry.exceeded_count}
                      </span>
                    </td>
                  </tr>
                  <tr>
                    <th scope="row">{t("IR smaller")}</th>
                    <td>
                      {data.telemetry.ir_smaller_count}/{data.telemetry.ir_compared_count}
                    </td>
                  </tr>
                  <tr>
                    <th scope="row">{t("Avg IR delta")}</th>
                    <td>
                      {data.telemetry.avg_ir_delta_percent === undefined
                        ? "—"
                        : `${data.telemetry.avg_ir_delta_percent > 0 ? "+" : ""}${data.telemetry.avg_ir_delta_percent}%`}
                    </td>
                  </tr>
                  {data.telemetry.ir_pair !== undefined && (
                    <tr>
                      <th scope="row">{t("Compared pair")}</th>
                      <td>
                        <code>{data.telemetry.ir_pair}</code>{" "}
                        <span className="muted">{t(PAIR_SENTENCES[data.telemetry.ir_pair])}</span>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
              {data.telemetry.latest_ts && (
                <p className="panel-subtitle">
                  {t("Latest sample")}: {data.telemetry.latest_ts}
                </p>
              )}
            </section>
          </>
        )}
      </main>
    </>
  );
}
