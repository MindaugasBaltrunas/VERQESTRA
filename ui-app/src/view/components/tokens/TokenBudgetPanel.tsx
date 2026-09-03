import type { UiTokenBudget } from "../../../model/types";
import { useI18n } from "../../../i18n/I18nContext";

/**
 * Token biudžeto lubos ir suvartojimas (2026-08-24: „viskas matoma").
 *
 * Serveris `controlPlane.token_budget` siuntė nuo pat pirmo audito rato, o klientas jo nerodė. Tai
 * buvo brangiausias iš nerodomų blokų: jis vienintelis atsako į klausimą „kodėl dispatch'as
 * pristabdytas arba neleistas". Be jo operatorius matydavo sustojusį ciklą ir neturėdavo kur
 * pažiūrėti priežasties.
 *
 * DU BLOKAI NESULIEJAMI sąmoningai — juos rašo skirtingi momentai (`budget_enforcement` yra
 * konteksto/įrankių vartų verdiktas, `llm_call_authorization` — paskutinio prieš-kvietimo).
 * Bendras skaičius, sudėtas iš dviejų laiko taškų, meluotų apie abu.
 */

/** `null` reiškia „neribota" — tai KITAS faktas nei „nežinoma", tad rodomas savo ženklu. */
function limitText(
  value: number | null | undefined,
  unlimited: string,
  unknown: string,
  numberFormat: Intl.NumberFormat,
): string {
  if (value === null) return unlimited;
  if (value === undefined) return unknown;
  return numberFormat.format(value);
}

export function TokenBudgetPanel({ budget }: { budget: UiTokenBudget | undefined }) {
  const { t, locale } = useI18n();
  const NUMBER = new Intl.NumberFormat(locale);
  const enforcement = budget?.budget_enforcement;
  const authorization = budget?.llm_call_authorization;

  // Nė vieno bloko nebuvimas reiškia, kad vartai dar nė karto nerašė — tai normali pradinė
  // būsena, o ne gedimas, todėl sakoma būtent taip, o ne rodomi melagingi nuliai.
  if (!enforcement && !authorization) {
    return (
      <section className="panel" aria-labelledby="token-budget-title">
        <div className="panel-header">
          <div>
            <p className="usage-eyebrow">{t("Cost control")}</p>
            <h2 id="token-budget-title">{t("Token budget")}</h2>
          </div>
        </div>
        <p className="panel-subtitle">{t("The budget gates have not recorded a verdict yet.")}</p>
      </section>
    );
  }

  const reasons = [...(enforcement?.reasons ?? []), ...(authorization?.hard_reasons ?? [])];
  const softReasons = [...(enforcement?.soft_reasons ?? []), ...(authorization?.soft_reasons ?? [])];
  const blocked = enforcement?.ok === false || authorization?.allowed === false;
  const reduceContext = enforcement?.reduce_context === true || authorization?.reduce_context === true;

  return (
    <section className="panel" aria-labelledby="token-budget-title">
      <div className="panel-header">
        <div>
          <p className="usage-eyebrow">{t("Cost control")}</p>
          <h2 id="token-budget-title">{t("Token budget")}</h2>
          <p className="panel-subtitle">{t("Why the next dispatch is allowed, throttled, or refused.")}</p>
        </div>
        <span className={`badge ${blocked ? "status-error" : reduceContext ? "status-warning" : "status-good"}`}>
          {t(blocked ? "blocked" : reduceContext ? "reduce context" : "within budget")}
        </span>
      </div>

      {enforcement && (
        <div className="budget-block">
          <h3>{t("Whole-task budget")}</h3>
          <div className="budget-grid">
            <div>
              <span>{t("LLM calls")}</span>
              <strong>
                {NUMBER.format(enforcement.total_llm_calls ?? 0)} /{" "}
                {limitText(enforcement.limits?.max_total_llm_calls, t("unlimited"), t("unknown"), NUMBER)}
              </strong>
            </div>
            <div>
              {/* BILLABLE, ne RAW: kietų lubų bazė yra `input + output + cache_creation`, o
                  `total_tokens` su `cache_read` yra diagnostika. Sumaišius juos, ekranas rodytų
                  perviršį ten, kur jo nėra. */}
              <span>{t("Billable tokens")}</span>
              <strong>
                {NUMBER.format(enforcement.billable_tokens ?? 0)} /{" "}
                {limitText(enforcement.limits?.max_total_tokens, t("unlimited"), t("unknown"), NUMBER)}
              </strong>
            </div>
            {enforcement.profile && (
              <div>
                <span>{t("Profile")}</span>
                <strong>{enforcement.profile}</strong>
              </div>
            )}
            {enforcement.model && (
              <div>
                <span>{t("Model")}</span>
                <strong>{enforcement.model}</strong>
              </div>
            )}
          </div>
        </div>
      )}

      {authorization && (
        <div className="budget-block">
          <h3>{t("Last call authorization")}</h3>
          <div className="budget-grid">
            <div>
              <span>{t("Phase")}</span>
              <strong>{authorization.phase ?? "—"}</strong>
            </div>
            <div>
              <span>{t("Remaining calls")}</span>
              <strong>{limitText(authorization.remaining_total_llm_calls, t("unlimited"), t("unknown"), NUMBER)}</strong>
            </div>
            <div>
              <span>{t("Remaining tokens")}</span>
              <strong>{limitText(authorization.remaining_total_tokens, t("unlimited"), t("unknown"), NUMBER)}</strong>
            </div>
          </div>
        </div>
      )}

      {/* Priežastys yra VARTŲ KODAI, ne sakiniai: jie neverčiami, nes būtent jų ieškoma žurnale. */}
      {reasons.length > 0 && (
        <div className="budget-reasons" role="alert">
          <strong>{t("Refused because")}:</strong>
          <ul>{reasons.map((reason) => <li key={reason}><code>{reason}</code></li>)}</ul>
        </div>
      )}
      {softReasons.length > 0 && (
        <div className="budget-reasons">
          <strong>{t("Warnings")}:</strong>
          <ul>{softReasons.map((reason) => <li key={reason}><code>{reason}</code></li>)}</ul>
        </div>
      )}
    </section>
  );
}
