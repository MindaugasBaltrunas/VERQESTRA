import { memo, useMemo, useState } from "react";
import type { UiPolicyControl, UiPolicyGroup } from "../../../model/types";
import { fill } from "../../../model/fillTemplate";
import { Badge } from "../shared/Badge";
import { SelectMenu, type SelectMenuOption } from "../shared/SelectMenu";
import { useI18n } from "../../../i18n/I18nContext";

type Props = {
  groups: UiPolicyGroup[];
  onPropose?: (route: string, settingId: string, requestedValue: unknown) => Promise<void>;
};

type PolicyFilter = "all" | "editable" | "pending";

type Translate = (text: string) => string;

function formatValue(value: boolean | string | number, t: Translate): string {
  if (typeof value === "boolean") return value ? t("Yes") : t("No");
  return String(value);
}

function parseFormValue(currentValue: boolean | string | number, value: string): boolean | string | number {
  if (typeof currentValue === "boolean") return value === "true";
  if (typeof currentValue === "number") {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) throw new Error("Reikšmė turi būti skaičius");
    return parsed;
  }
  return value;
}

/**
 * Ar formos reikšmė sutampa su dabartine (2026-08-31 UI auditas, P1). Forma atsidaro ties
 * rekomenduojama reikšme, o ji dažnai JAU yra dabartinė — tada peržiūra rodė `layered → layered`,
 * „Siųsti" liko aktyvus, o serveris (task 103) tokį pasiūlymą atmeta 4xx. Vartotojui tai atrodė
 * kaip klaida ten, kur teisingas atsakymas yra „nėra ko siųsti".
 *
 * Lyginama PO `parseFormValue`, ne prieš: `"true"` ir `true`, `"3"` ir `3` yra ta pati reikšmė, tik
 * skirtingo užrašymo. Neparsinama reikšmė (skaitiniam nustatymui įvestas ne skaičius) no-op NĖRA —
 * ji yra klaida, ir ją turi parodyti siuntimo kelias, ne tyliai užrakintas mygtukas.
 */
function isUnchangedValue(currentValue: boolean | string | number, value: string): boolean {
  try {
    return parseFormValue(currentValue, value) === currentValue;
  } catch {
    return false;
  }
}

function formatPendingProposal(
  proposal: { requested_value: unknown } | string,
): string {
  if (typeof proposal === "string") return proposal;
  return String(proposal.requested_value);
}

const RECOMMENDED_VALUES: Record<string, boolean | string | number> = {
  strictness: "warn",
  single_responsibility: "warn",
  open_closed: "warn",
  liskov_substitution: "warn",
  dependency_inversion: "warn",
  interface_segregation: "warn",
  dry: "warn",
  kiss: "warn",
  yagni: "warn",
  separation_of_concerns: "warn",
  max_files_per_task: 10,
  max_responsibilities_per_task: 3,
  require_tests_for_code_changes: true,
  require_interface_contract_for_public_changes: true,
  broad_scope_requires_human_review: true,
  global_policy_changes_require_human_review: true,
};

function recommendedValue(control: UiPolicyControl): boolean | string | number {
  return RECOMMENDED_VALUES[control.id] ?? control.value;
}

/**
 * Variantai ateina TIK iš serverio (`allowed_values`) arba iš reikšmės tipo. Iki 2026-09-02 čia
 * gyveno atskiras `style` sąrašas: keturi įrašai, vienas jų (`modular_monolith`) domain'ui
 * nežinomas, o du domain'o išvedami (`modular-feature`, `pipeline`) — praleisti. Antra sąrašo
 * kopija naršyklėje visada anksčiau ar vėliau prasilenkia su tiesos šaltiniu.
 */
function availableValues(control: UiPolicyControl): string[] {
  if (control.allowed_values?.length) return control.allowed_values;
  if (typeof control.value === "boolean") return ["true", "false"];
  return [];
}

/**
 * Vienintelis pasirinkimo kanalas (2026-08-28). Anksčiau ta pati informacija ekrane kartojosi
 * trimis pavidalais: „Available values" kodų juostelė, „Recommended" sakinys ir tik po to laukas,
 * į kurį reikšmė realiai įvedama. Dabar variantai gyvena TEN, kur renkami — `SelectMenu` sąraše —
 * o rekomendacija yra varianto `tag` ženklelis, ne atskiras aiškinamasis sakinys šalia kortelės.
 *
 * Boolean nustatymai eina tuo pačiu keliu: variantai yra `"true"`/`"false"` eilutės, o tikru
 * boolean'u reikšmė virsta `parseFormValue`, prieš pat siunčiant. Etiketė imama iš `formatValue`,
 * tad dabartinė reikšmė kortelėje ir pasirinkimas sąraše rašomi vienodai.
 */
function valueOptions(control: UiPolicyControl, t: Translate): SelectMenuOption[] {
  const recommended = String(recommendedValue(control));
  return availableValues(control).map((value) => ({
    value,
    label: typeof control.value === "boolean" ? formatValue(value === "true", t) : t(value),
    ...(value === recommended ? { tag: t("Recommended") } : {}),
  }));
}

export const PolicyControlsPanel = memo(function PolicyControlsPanel({ groups, onPropose }: Props) {
  const { t } = useI18n();
  const [openFormId, setOpenFormId] = useState<string | null>(null);
  const [formValue, setFormValue] = useState("");
  const [formError, setFormError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<PolicyFilter>("all");
  const controls = groups.flatMap((group) => group.controls);
  const editableCount = controls.filter((control) => control.editable).length;
  const pendingCount = controls.filter((control) => control.pending_proposal).length;
  const visibleGroups = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return groups
      .map((group) => ({
        ...group,
        controls: group.controls.filter((control) => {
          const matchesQuery = !normalizedQuery
            || `${control.label} ${control.id} ${control.source}`.toLocaleLowerCase().includes(normalizedQuery);
          const matchesFilter = filter === "all"
            || (filter === "editable" && control.editable)
            || (filter === "pending" && Boolean(control.pending_proposal));
          return matchesQuery && matchesFilter;
        }),
      }))
      .filter((group) => group.controls.length > 0);
  }, [filter, groups, query]);

  function openForm(control: UiPolicyControl) {
    setOpenFormId(control.id);
    setFormValue(String(recommendedValue(control)));
    setFormError("");
  }

  function closeForm() {
    setOpenFormId(null);
    setFormValue("");
    setFormError("");
  }

  async function handleSubmit(route: string, settingId: string, currentValue: boolean | string | number) {
    if (!onPropose) return;
    setSubmitting(true);
    setFormError("");
    try {
      // `parseFormValue` meta, kai skaitiniam nustatymui įvedamas ne skaičius. Anksčiau ji buvo
      // kviečiama kaip argumentas TRY viduje, bet `catch` bloko nebuvo — klaida virsdavo
      // neapdorota promise rejection (`void handleSubmit(...)`), forma likdavo atidaryta ir
      // NIEKO nevykdavo: nei pranešimo, nei užklausos. Atrodė kaip pakibęs mygtukas.
      const requestedValue = parseFormValue(currentValue, formValue);
      await onPropose(route, settingId, requestedValue);
      closeForm();
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="panel policy-workspace" aria-labelledby="policy-governance-title">
      <div className="panel-header policy-workspace-header">
        <div>
          <p className="usage-eyebrow">{t("Governance controls")}</p>
          <h2 id="policy-governance-title">{t("Change policy")}</h2>
          <p className="panel-subtitle">{t("Review the current value, propose a justified change, and track it through approval.")}</p>
        </div>
        <div className="policy-workspace-stats" aria-label={t("Policy summary")}>
          <span><strong>{editableCount}</strong>{t("Editable")}</span>
          {/* „Nustatymų", o ne „Laukia sprendimo": šis skaičius skaičiuoja NUSTATYMUS su bent
              vienu laukiančiu pasiūlymu, o sprendimų eilė skaičiuoja PASIŪLYMUS. Vienas
              nustatymas gali turėti kelis, tad du skaičiai teisėtai skiriasi — bet iki
              2026-08-24 abu vadinosi vienodai, ir ekranas atrodė prieštaringas. */}
          <span className={pendingCount ? "has-pending" : ""}>
            <strong>{pendingCount}</strong>{t("settings awaiting a decision")}
          </span>
        </div>
      </div>
      <div className="policy-toolbar">
        <label className="policy-search">
          <span>{t("Search policies")}</span>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("Search by name, ID, or source...")}
          />
        </label>
        <div className="segmented-control policy-filter" aria-label={t("Filter policies")}>
          {([
            ["all", t("All policies"), controls.length],
            ["editable", t("Editable"), editableCount],
            ["pending", t("Awaiting decision"), pendingCount],
          ] as const).map(([value, label, count]) => (
            <button
              key={value}
              type="button"
              className={filter === value ? "active" : ""}
              aria-pressed={filter === value}
              onClick={() => setFilter(value)}
            >
              {label} <b>{count}</b>
            </button>
          ))}
        </div>
      </div>
      {visibleGroups.length === 0 && (
        <div className="policy-empty">
          <strong>{t("No policies match this view")}</strong>
          <p>{t("Change the filter or clear the search query.")}</p>
          <button className="button ghost small-button" type="button" onClick={() => { setQuery(""); setFilter("all"); }}>
            {t("Clear filters")}
          </button>
        </div>
      )}
      {visibleGroups.map((group) => (
        <details
          key={`${group.group}-${filter}-${query.trim() ? "search" : "browse"}`}
          className="policy-group"
          open={Boolean(query.trim()) || filter !== "all" || group.group === "architecture-style"}
        >
          <summary><span>{t(group.label)}</span><b>{group.controls.length} {t("settings")}</b></summary>
          <div className="policy-controls-grid">
            {group.controls.map((control) => {
              const options = valueOptions(control, t);
              const valueFieldName = `${t(control.label)} ${t("New value")}`;
              const previewValue = options.find((option) => option.value === formValue)?.label ?? formValue;
              const unchanged = isUnchangedValue(control.value, formValue);
              const unchangedHintId = `${control.id}-unchanged`;
              return (
              <article key={control.id} className={`policy-control-card${control.pending_proposal ? " is-pending" : ""}`}>
                <div className="policy-control-topline">
                  <div>
                    {/* Vardas turi `id`, nes formos laukai jį pasiima į savo PRIEINAMĄ vardą
                        (`aria-labelledby`): matoma etiketė sako „Nauja reikšmė", o ekrano
                        skaitytuvas girdi „Maksimalūs bandymai Nauja reikšmė". Pakartoti vardą
                        matomai būtų triukšmas — jis stovi tiesiai virš lauko. */}
                    <div className="metric-label" id={`${control.id}-name`}>{t(control.label)}</div>
                    <code>{control.id}</code>
                  </div>
                  <Badge text={control.editable ? t("Editable") : t("Read-only")} variant="neutral" />
                </div>
                {/* Viena eilutė „dabartinė → laukianti", o ne trys stulpeliai su aiškinimais.
                    Be laukiančio pasiūlymo dešinės pusės NĖRA: `:only-child` išplečia dabartinę
                    reikšmę per visą plotį, ir kortelė nelieka su tuščiu langeliu. */}
                <div className="policy-value-flow">
                  <div>
                    <span>{t("Current value")}</span>
                    <strong>{formatValue(control.value, t)}</strong>
                  </div>
                  {control.pending_proposal && (
                    <>
                      <span className="policy-flow-arrow" aria-hidden="true">→</span>
                      <div className="pending">
                        <span>{t("Pending proposal")}</span>
                        <strong>{formatPendingProposal(control.pending_proposal)}</strong>
                        {/* Suspaudimas iki naujausio ĮVARDIJAMAS: be to eilėje matomi keli to
                            paties nustatymo įrašai atrodo kaip dublikatas, o čia rodoma
                            reikšmė — kaip vienintelė. */}
                        {control.pending_proposal_count !== undefined && control.pending_proposal_count > 1 && (
                          <small>
                            {fill(t("{count} proposals for this setting; the newest is shown."), {
                              count: control.pending_proposal_count,
                            })}
                          </small>
                        )}
                      </div>
                    </>
                  )}
                </div>
                {openFormId === control.id && control.route && (
                  <form className="policy-change-form"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void handleSubmit(control.route!, control.id, control.value);
                    }}
                  >
                    {/* MATOMA ETIKETĖ, ne placeholder (2026-08-24, operatoriaus radinys).
                        Placeholder dingsta vos pradėjus rašyti, tad laukas, į kurį jau kažkas
                        įvesta, nebeturi vardo — o būtent tada jo reikia, tikrinant prieš siunčiant.
                        `aria-label` tą vardą duodavo tik ekrano skaitytuvui; regintis operatorius
                        jo neturėjo. `<label for>` aptarnauja abu. */}
                    <label className="policy-field-label" id={`${control.id}-value-label`} htmlFor={`${control.id}-value`}>
                      {t("New value")}
                    </label>
                    {options.length > 0 ? (
                      <SelectMenu
                        id={`${control.id}-value`}
                        value={formValue}
                        onChange={setFormValue}
                        options={options}
                        disabled={submitting}
                        aria-label={valueFieldName}
                      />
                    ) : (
                      <input
                        id={`${control.id}-value`}
                        aria-labelledby={`${control.id}-name ${control.id}-value-label`}
                        type="text"
                        value={formValue}
                        onChange={(e) => setFormValue(e.target.value)}
                        disabled={submitting}
                      />
                    )}
                    {/* Priežasties lauko čia NĖRA (2026-08-28, operatoriaus sprendimas): pasiūlymą
                        rašo ir tvirtina tas pats žmogus, tad prievolė pagrįsti pakeitimą sau pačiam
                        buvo tik trintis. Serveris priežasties nebereikalauja, forma — irgi. */}
                    <p className="policy-form-preview">
                      <span>{t("Proposed change")}</span>
                      <strong>{formatValue(control.value, t)} → {previewValue || "—"}</strong>
                    </p>
                    {formError ? (
                      <p className="policy-form-error" role="alert">
                        {formError}
                      </p>
                    ) : null}
                    {/* Priežastis stovi ŠALIA užrakinto mygtuko ir yra su juo susieta
                        (`aria-describedby`): užrakintas mygtukas be paaiškinimo atrodo kaip
                        sugedęs, o ekrano skaitytuvui jis apskritai nutyla. */}
                    {unchanged && (
                      <p className="policy-form-hint" id={unchangedHintId}>
                        {t("Choose a different value")}
                      </p>
                    )}
                    <div className="policy-form-actions">
                      <button
                        className="button small-button"
                        type="submit"
                        disabled={submitting || unchanged}
                        aria-describedby={unchanged ? unchangedHintId : undefined}
                      >
                        {submitting ? t("Sending...") : t("Send")}
                      </button>
                      <button
                        className="button ghost small-button"
                        type="button"
                        onClick={closeForm}
                        disabled={submitting}
                      >
                        {t("Cancel")}
                      </button>
                    </div>
                  </form>
                )}
                <div className="policy-control-footer">
                  <span>{t("Source")}: <code>{control.source}</code></span>
                  {control.editable && onPropose && control.route && openFormId !== control.id && (
                    <button className="button ghost small-button" type="button" onClick={() => openForm(control)}>
                      {control.pending_proposal ? t("Propose another change") : t("Propose change")}
                    </button>
                  )}
                </div>
              </article>
              );
            })}
          </div>
        </details>
      ))}
    </section>
  );
});
