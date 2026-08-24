import type { DashboardData, UiConfigControl, UiStackDecision } from "../../model/types";
import { useI18n } from "../../i18n/I18nContext";

/**
 * Diagnostikos blokas (2026-08-24: „viskas matoma").
 *
 * Čia sueina laukai, kuriuos serveris siuntė nuo pat pradžių ir kurių NIEKAS nerodė:
 * `statusFiles`, `claudeLogUpdatedAt`/`Bytes`/`Source`, `supervisorResume`, `claudeResume`,
 * `controlPlane.config_controls` ir `controlPlane.stack_decision`.
 *
 * Visi jie atsako į vieną klausimą — „ką sistema apie save žino ir kada tai užrašė". Todėl jie
 * stovi kartu ir `#/system` ekrane, o ne išbarstyti: būsenos failo mtime be resume taško nieko
 * nepasako, o kartu jie parodo, ar įrodymai apskritai švieži.
 */

function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return "—";
  return new Intl.NumberFormat("lt-LT", { notation: "compact", maximumFractionDigits: 1 }).format(bytes) + " B";
}

function formatStamp(iso: string | null | undefined, locale: string): string {
  if (!iso) return "—";
  const parsed = Date.parse(iso);
  // Neparsinamas antspaudas rodomas ŽALIAS: „—" paslėptų faktą, kad įraše yra šiukšlė.
  return Number.isFinite(parsed) ? new Date(parsed).toLocaleString(locale) : iso;
}

function StackDecision({ decision }: { decision: UiStackDecision }) {
  const { t } = useI18n();
  return (
    <div className="diagnostics-block">
      <h3>{t("Stack decision")}</h3>
      <div className="budget-grid">
        <div><span>{t("Language")}</span><strong>{decision.selected_language ?? "—"}</strong></div>
        <div><span>{t("Framework")}</span><strong>{decision.selected_framework ?? "—"}</strong></div>
        <div><span>{t("Architecture style")}</span><strong>{decision.architecture_style}</strong></div>
        <div><span>{t("Confidence")}</span><strong>{t(decision.confidence)}</strong></div>
      </div>
      {/* Žmogaus peržiūros reikalavimas yra SPRENDIMAS, ne detalė: jis pasako, kad automatika
          pati savęs neįteisino. */}
      {decision.human_review_required && (
        <p className="notice notice-warning" role="status">
          ⚠ {t("This stack decision requires a human review")}: {decision.reason}
        </p>
      )}
    </div>
  );
}

function ConfigControls({ controls }: { controls: readonly UiConfigControl[] }) {
  const { t } = useI18n();
  if (controls.length === 0) return null;
  return (
    <div className="diagnostics-block">
      <h3>{t("Automation policy")}</h3>
      <table className="diagnostics-table">
        <caption className="visually-hidden">{t("Automation policy")}</caption>
        <thead>
          <tr><th scope="col">{t("Setting")}</th><th scope="col">{t("Value")}</th><th scope="col">{t("Source")}</th></tr>
        </thead>
        <tbody>
          {controls.map((control) => (
            <tr key={control.id}>
              <th scope="row">{t(control.label)}</th>
              <td><strong>{String(control.value)}</strong></td>
              {/* `command` yra vienintelis būdas šią reikšmę pakeisti — jis rodomas, o ne
                  nutylimas, nes valdiklis be kelio jį pakeisti yra tik pranešimas. */}
              <td><code title={control.command ?? undefined}>{control.source}</code></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function DiagnosticsPanel({ data }: { data: DashboardData }) {
  const { t, locale } = useI18n();
  const statusFiles = data.statusFiles ?? [];
  const stack = data.controlPlane?.stack_decision;
  const config = data.controlPlane?.config_controls ?? [];

  return (
    <section className="panel" aria-labelledby="diagnostics-title">
      <div className="panel-header">
        <div>
          <p className="usage-eyebrow">{t("Evidence")}</p>
          <h2 id="diagnostics-title">{t("Diagnostics")}</h2>
          <p className="panel-subtitle">{t("What the system knows about itself, and when it wrote it down.")}</p>
        </div>
      </div>

      <div className="diagnostics-block">
        <h3>{t("Executor log")}</h3>
        <div className="budget-grid">
          <div><span>{t("Updated")}</span><strong>{formatStamp(data.claudeLogUpdatedAt, locale)}</strong></div>
          <div><span>{t("Size")}</span><strong>{formatBytes(data.claudeLogBytes)}</strong></div>
          {/* `legacy` reiškia, kad antspaudas gali priklausyti KITAM task'ui — kilmė rodoma. */}
          <div><span>{t("Source")}</span><strong>{data.claudeLogSource ?? "—"}</strong></div>
        </div>
      </div>

      <div className="diagnostics-block">
        <h3>{t("Resume points")}</h3>
        <div className="budget-grid">
          <div>
            <span>{t("Supervisor")}</span>
            <strong>{data.supervisorResume.status ?? "—"}</strong>
          </div>
          <div>
            <span>{t("Executor")}</span>
            <strong>{data.claudeResume.status ?? "—"}</strong>
          </div>
          <div>
            <span>{t("Next action")}</span>
            <strong>{data.claudeResume.next_action ?? data.supervisorResume.next_action ?? "—"}</strong>
          </div>
        </div>
      </div>

      {statusFiles.length > 0 && (
        <div className="diagnostics-block">
          <h3>{t("State files")}</h3>
          <table className="diagnostics-table">
            <caption className="visually-hidden">{t("State files")}</caption>
            <thead>
              <tr><th scope="col">{t("File")}</th><th scope="col">{t("Size")}</th><th scope="col">{t("Updated")}</th></tr>
            </thead>
            <tbody>
              {statusFiles.map((file) => (
                // Nesamas failas rodomas AIŠKIAI: tuščia eilutė atrodytų kaip nulinis dydis, o tai
                // kitas faktas nei „įrašo nėra".
                <tr key={file.name} className={file.present ? undefined : "state-file-missing"}>
                  <th scope="row"><code>{file.name}</code></th>
                  <td>{file.present ? formatBytes(file.bytes) : t("missing")}</td>
                  <td>{formatStamp(file.updatedAt, locale)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {stack && <StackDecision decision={stack} />}
      <ConfigControls controls={config} />
    </section>
  );
}
