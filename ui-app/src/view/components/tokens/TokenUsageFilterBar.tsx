import { useI18n } from "../../../i18n/I18nContext";

export type TokenUsageFilterBarProps = {
  model: string;
  phase: string;
  taskIdQuery: string;
  from: string;
  to: string;
  modelOptions: string[];
  phaseOptions: string[];
  onModelChange: (value: string) => void;
  onPhaseChange: (value: string) => void;
  onTaskIdQueryChange: (value: string) => void;
  onFromChange: (value: string) => void;
  onToChange: (value: string) => void;
  onDatePreset: (days: number | null) => void;
  onReset: () => void;
};

export function TokenUsageFilterBar({
  model,
  phase,
  taskIdQuery,
  from,
  to,
  modelOptions,
  phaseOptions,
  onModelChange,
  onPhaseChange,
  onTaskIdQueryChange,
  onFromChange,
  onToChange,
  onDatePreset,
  onReset,
}: TokenUsageFilterBarProps) {
  const { t } = useI18n();
  return (
    <section className="usage-filters" aria-label={t("Token usage filters")}>
      <div className="filter-presets" aria-label={t("Time period")}>
        <span>{t("Period")}</span>
        <button type="button" onClick={() => onDatePreset(1)}>{t("Today")}</button>
        <button type="button" onClick={() => onDatePreset(7)}>7 d.</button>
        <button type="button" onClick={() => onDatePreset(30)}>30 d.</button>
        <button type="button" onClick={() => onDatePreset(null)}>{t("All time")}</button>
      </div>
      <div className="filter-bar">
      <div className="filter-field">
        <label htmlFor="token-usage-filter-model">{t("Model")}</label>
        <select
          id="token-usage-filter-model"
          className="range-input"
          value={model}
          onChange={(e) => onModelChange(e.target.value)}
        >
            <option value="">{t("All")}</option>
          {modelOptions.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </div>
      <div className="filter-field">
        <label htmlFor="token-usage-filter-phase">{t("Phase")}</label>
        <select
          id="token-usage-filter-phase"
          className="range-input"
          value={phase}
          onChange={(e) => onPhaseChange(e.target.value)}
        >
            <option value="">{t("All")}</option>
          {phaseOptions.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </div>
      <div className="filter-field">
        <label htmlFor="token-usage-filter-task">{t("Task ID")}</label>
        <input
          id="token-usage-filter-task"
          className="range-input"
          type="text"
          placeholder={t("Search...")}
          value={taskIdQuery}
          onChange={(e) => onTaskIdQueryChange(e.target.value)}
        />
      </div>
      {/* DATOS FORMATAS NEPRIKLAUSO NUO PUSLAPIO (2026-08-24, operatoriaus radinys „lieka
          mm/dd/yyyy"). `<input type="date">` vietos ženklą piešia naršyklė pagal SAVO sąsajos
          kalbą; nei `document.lang`, nei `navigator.languages`, nei CSS jo nekeičia. Patikrinta
          gyvai: puslapio `lang` yra `lt`, o laukas vis tiek rodė amerikietišką tvarką.

          Iki 2026-09-02 šalia lauko stovėjo sakinys „Datos formatas — YYYY-MM-DD", o pats laukas
          rodė `mm/dd/yyyy`: du vienu metu matomi formatai, kurių vienas tvirtino kitą esant
          klaidingą (UI auditas 2026-08-31, P3). Prieštara pašalinta ne kovojant su picker'iu, o
          atskiriant du skirtingus dalykus: laukas yra ĮVESTIS (jos išvaizda — naršyklės
          reikalas), o po juo rodoma REIKŠMĖ, kuri iš tikrųjų keliauja į filtrą — visada ISO.
          Pagalbinis tekstas dėl to kalba tik apie siunčiamą reikšmę ir nebeteigia, kaip laukas
          atrodo. */}
      <div className="filter-field">
        <label htmlFor="token-usage-filter-from">{t("From")}</label>
        <input
          id="token-usage-filter-from"
          className="range-input"
          type="date"
          aria-describedby={
            from === "" ? "token-usage-date-format" : "token-usage-from-iso token-usage-date-format"
          }
          value={from}
          onChange={(e) => onFromChange(e.target.value)}
        />
        {from !== "" && (
          <small id="token-usage-from-iso" className="filter-field-iso">
            {t("Sent as")} <code>{from}</code>
          </small>
        )}
      </div>
      <div className="filter-field">
        <label htmlFor="token-usage-filter-to">{t("To")}</label>
        <input
          id="token-usage-filter-to"
          className="range-input"
          type="date"
          aria-describedby={
            to === "" ? "token-usage-date-format" : "token-usage-to-iso token-usage-date-format"
          }
          value={to}
          onChange={(e) => onToChange(e.target.value)}
        />
        {to !== "" && (
          <small id="token-usage-to-iso" className="filter-field-iso">
            {t("Sent as")} <code>{to}</code>
          </small>
        )}
        <small id="token-usage-date-format" className="filter-field-hint">
          {t("The filter is sent as YYYY-MM-DD; the calendar itself is drawn by your browser.")}
        </small>
      </div>
      <button className="button ghost small-button filter-reset" type="button" onClick={onReset}>
        {t("Reset filters")}
      </button>
      </div>
    </section>
  );
}
