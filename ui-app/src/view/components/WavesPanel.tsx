import { memo } from "react";
import type { UiWaveSlot, UiWaveSlotState, UiWavesView } from "../../model/types";
import { formatAge } from "../../model/slotProgressFormat";
import { useI18n } from "../../i18n/I18nContext";

/** Būsenų rodymo tvarka: pirma tai, kas reikalauja dėmesio, paskiausiai tai, kas jau baigta. */
const STATE_ORDER: Record<UiWaveSlotState, number> = {
  failed: 0,
  running: 1,
  provisioned: 2,
  released: 3,
};

const STATE_LABELS: Record<UiWaveSlotState, string> = {
  provisioned: "Provisioned",
  running: "Running",
  failed: "Failed",
  released: "Released",
};

/** Rikiavimas TIK vaizdui — serverio `slots` tvarka atitinka lease'ų skaitymo tvarką. */
function sortSlots(slots: readonly UiWaveSlot[]): UiWaveSlot[] {
  return [...slots].sort((left, right) =>
    STATE_ORDER[left.state] - STATE_ORDER[right.state] || left.worker_id.localeCompare(right.worker_id),
  );
}

type Props = {
  /**
   * Duomenys ateina TIK iš `DashboardPage` (task 1233): tas pats `/api/waves` atsakymas maitina ir
   * srautų korteles, ir šią panelę, per vieną pollingo srautą. Vidinis `useWavesController` kelias
   * pašalintas (task 053-a-02) — jis niekada nebuvo pasiekiamas, nes `onReload` visada paduodamas.
   */
  data?: UiWavesView | null;
  error?: string | null;
  loading?: boolean;
  onReload: () => void;
};

/**
 * `#/system` bangų vaizdas (task 1208/1207/1228/1233): slot'ų būsenos, atmetimų priežastys ir
 * wave-events uodega. Eilės srauto lenta yra ATSKIRA sekcija (`QueuePipelineBoard`), nes jos
 * duomenys ateina daugiausia iš `/api/dashboard` ir neturi dingti dėl bangų endpoint'o gedimo.
 * Read-only — čia nėra jokio veiksmo, kuris keistų bangos ar lease'o būseną; ta logika lieka
 * `application/scheduling/*`.
 *
 * Lentelė VIENA: kai serveris grąžina `slots`, rodomos slot'ų eilutės (jose lease'as jau yra), o kai
 * negrąžina — senoji lease'ų lentelė. Dvi lentelės tuos pačius workerius rodytų dukart.
 */
export const WavesPanel = memo(function WavesPanel({ data = null, error = null, loading = false, onReload: reload }: Props) {
  const { t } = useI18n();

  // Klaida čia matoma TIK kai dar nėra jokių sėkmingai gautų duomenų — jei jie jau yra, klaida
  // rodoma juosta žemiau, o ne šia vieta pakeičia paskutinius matytus duomenis.
  if (error && !data) {
    return (
      <section className="panel" aria-labelledby="waves-title">
        <div className="panel-header"><h2 id="waves-title">{t("Waves")}</h2></div>
        <div className="notice notice-warning" role="alert">
          {t("Failed to load waves")}: {error}
          <button className="button ghost small-button" type="button" onClick={() => void reload()} disabled={loading}>
            {loading ? t("Loading...") : t("Try again")}
          </button>
        </div>
      </section>
    );
  }

  if (!data) {
    return (
      <section className="panel" aria-labelledby="waves-title">
        <div className="panel-header"><h2 id="waves-title">{t("Waves")}</h2></div>
        <p className="panel-subtitle">{t("Loading...")}</p>
      </section>
    );
  }

  const slots = sortSlots(data.slots ?? []);

  return (
    <section className="panel" aria-labelledby="waves-title">
      <div className="panel-header">
        <div>
          <h2 id="waves-title">{t("Waves")}</h2>
          <p className="panel-subtitle">{t("Slot leases, rejection reasons, and wave events")}</p>
        </div>
      </div>

      {error && (
        <div className="notice notice-warning" role="alert">
          {t("Failed to load waves")}: {error}
          <button className="button ghost small-button" type="button" onClick={() => void reload()} disabled={loading}>
            {loading ? t("Loading...") : t("Try again")}
          </button>
        </div>
      )}

      {data.degraded.length > 0 && (
        <p className="runtime-explanation">
          ⚠ {t("Some wave sources could not be read")}: {data.degraded.join(", ")}
        </p>
      )}

      <div className="usage-table-scroll">
        {slots.length > 0 ? (
          <table className="usage-table">
            <caption className="visually-hidden">{t("Worker lease slots")}</caption>
            <thead>
              <tr>
                <th>{t("Worker")}</th>
                <th>{t("Task")}</th>
                <th>{t("State")}</th>
                <th>{t("Heartbeat")}</th>
                <th>{t("Lease expires")}</th>
                <th>{t("Worktree")}</th>
                <th>{t("Last failure")}</th>
              </tr>
            </thead>
            <tbody>
              {slots.map((slot) => (
                <tr key={slot.worker_id}>
                  <td data-label={t("Worker")}>{slot.worker_id}</td>
                  <td data-label={t("Task")}>{slot.task_id}</td>
                  <td data-label={t("State")} data-state={slot.state}>{t(STATE_LABELS[slot.state])}</td>
                  <td data-label={t("Heartbeat")}>
                    {formatAge(slot.heartbeat_age_ms)}
                    {slot.stale ? ` ⚠ ${t("Stale lease")}` : ""}
                  </td>
                  <td data-label={t("Lease expires")}>{slot.expires_at}</td>
                  <td data-label={t("Worktree")}>{slot.has_worktree ? t("Yes") : t("No")}</td>
                  <td data-label={t("Last failure")} title={slot.last_failure?.reason ?? ""}>
                    {slot.last_failure ? `${slot.last_failure.ts} — ${slot.last_failure.reason}` : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <table className="usage-table">
            <caption className="visually-hidden">{t("Worker lease slots")}</caption>
            <thead>
              <tr>
                <th>{t("Worker")}</th>
                <th>{t("Task")}</th>
                <th>{t("Status")}</th>
                <th>{t("Lease expires")}</th>
                <th>{t("Worktree")}</th>
              </tr>
            </thead>
            <tbody>
              {data.leases.length === 0 ? (
                <tr><td colSpan={5}>{t("No active leases")}</td></tr>
              ) : (
                data.leases.map((lease) => (
                  <tr key={lease.worker_id}>
                    <td data-label={t("Worker")}>{lease.worker_id}</td>
                    <td data-label={t("Task")}>{lease.task_id}</td>
                    <td data-label={t("Status")}>{lease.status}</td>
                    <td data-label={t("Lease expires")}>{lease.expires_at}</td>
                    <td data-label={t("Worktree")}>{lease.has_worktree ? t("Yes") : t("No")}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        )}
      </div>

      {/* Uodegos NIEKAS neištrynė — jos tiesiog nustojo būti pagrindinis eilės vaizdas ir suskleistos
          po vienu skėčiu: failų vardų sąrašas atsako į „kas įvyko", o ne į „kas vyksta dabar". */}
      <details className="policy-group">
        <summary><span>{t("Wave details")}</span></summary>

        <div>
          <h3>{t("Recent rejections")}</h3>
          {data.last_rejections.length === 0 ? (
            <p className="panel-subtitle">{t("No rejections recorded")}</p>
          ) : (
            <ul className="system-signal-list">
              {data.last_rejections.map((rejection, index) => (
                <li key={`${rejection.task_id}-${index}`}>
                  <code>{rejection.task_id}</code> {rejection.reason}
                  {rejection.detail ? ` — ${rejection.detail}` : ""}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div>
          <h3>{t("Refill decisions")}</h3>
          {/* `hard_capped` yra SKAIČIUS (kiek slot'ų nukirsta), ne vėliava, todėl rodomas kaip yra. */}
          {(data.refill_decisions ?? []).length === 0 ? (
            <p className="panel-subtitle">{t("No refill decisions recorded")}</p>
          ) : (
            <ul className="system-signal-list">
              {(data.refill_decisions ?? []).map((decision, index) => (
                <li key={`${decision.episode}-${decision.worker_id}-${index}`}>
                  <code>{decision.task_id}</code> {decision.worker_id} — {decision.reason}
                  {decision.hard_capped > 0 ? ` (hard_capped=${decision.hard_capped})` : ""}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div>
          <h3>{t("Wave events")}</h3>
          {data.events.length === 0 ? (
            <p className="panel-subtitle">{t("No wave events recorded")}</p>
          ) : (
            <ul className="system-signal-list">
              {data.events.map((event, index) => (
                <li key={`${event.ts}-${index}`}>
                  {event.ts} — {event.event}
                  {event.task_id ? ` (${event.task_id})` : ""}
                  {event.reason ? `: ${event.reason}` : ""}
                </li>
              ))}
            </ul>
          )}
        </div>
      </details>
    </section>
  );
});
