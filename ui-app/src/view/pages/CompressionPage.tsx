import { useCallback, useEffect, useState } from "react";
import { fetchCompression, setCompressionFeature } from "../../model/api";
import type { CompressionFeature, CompressionFeatureValue, CompressionView } from "../../model/types";
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
 * Shadow IR verdiktas viena eilute.
 *
 * Neigiama delta = IR mažesnis už raw (kompresija duotų naudos). Teigiama = didesnis (žala). Be
 * šito sakinio operatorius matytų du skaičius ir turėtų juos interpretuoti pats.
 */
function irVerdict(view: CompressionView): { key: string; warn: boolean } {
  const { ir_compared_count: compared, ir_smaller_count: smaller, avg_ir_delta_percent: delta } = view.telemetry;
  if (compared === 0) return { key: "No shadow samples yet — enable nothing on a guess", warn: false };
  if (delta !== undefined && delta > 0) {
    return { key: "IR is larger on average — enabling worker_task_ir would grow the pack", warn: true };
  }
  if (smaller === compared) return { key: "IR is smaller in every sample", warn: false };
  return { key: "IR helps only some tasks — check before enabling", warn: true };
}

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
                </tbody>
              </table>
              {(() => {
                const verdict = irVerdict(data);
                return (
                  <p className={verdict.warn ? "notice notice-warning" : "notice"} role="status">
                    {t(verdict.key)}
                  </p>
                );
              })()}
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
