import { memo, useMemo, useState } from "react";
import type { UiPolicyControl, UiPolicyGroup } from "../../model/types";
import { Badge } from "./Badge";
import { useI18n } from "../../i18n/I18nContext";

type Props = {
  groups: UiPolicyGroup[];
  onPropose?: (route: string, settingId: string, requestedValue: unknown, reason: string) => Promise<void>;
};

type PolicyFilter = "all" | "editable" | "pending";

function formatValue(value: boolean | string | number): string {
  if (typeof value === "boolean") return value ? "taip" : "ne";
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
  dependency_inversion: "warn",
  interface_segregation: "warn",
  dry: "warn",
  yagni: "warn",
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

function availableValues(control: UiPolicyControl): string[] {
  if (control.allowed_values?.length) return control.allowed_values;
  if (typeof control.value === "boolean") return ["true", "false"];
  if (control.id === "style") return ["clean_architecture", "layered", "modular_monolith", "hexagonal"];
  return [];
}

const CODING_PRINCIPLES_GROUP = "coding-principles";
const CODING_PRINCIPLES_HELP =
  "advisory = tik rekomendacija, nevykdo prievarta; warn = review signalas peržiūrai; block = griežtas vykdymas, pažeidimas stabdo užduotį.";

function HelpPopover({ text }: { text: string }) {
  return (
    <span className="help-popover" tabIndex={0}>
      <span className="help-popover-icon" aria-hidden="true">?</span>
      <span className="help-popover-text" role="tooltip">{text}</span>
    </span>
  );
}

export const PolicyControlsPanel = memo(function PolicyControlsPanel({ groups, onPropose }: Props) {
  const { t } = useI18n();
  const [openFormId, setOpenFormId] = useState<string | null>(null);
  const [formValue, setFormValue] = useState("");
  const [formReason, setFormReason] = useState("");
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
    setFormReason("");
    setFormError("");
  }

  function closeForm() {
    setOpenFormId(null);
    setFormValue("");
    setFormReason("");
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
      await onPropose(route, settingId, requestedValue, formReason);
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
          <span className={pendingCount ? "has-pending" : ""}><strong>{pendingCount}</strong>{t("Awaiting decision")}</span>
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
            {group.controls.map((control) => (
              <article key={control.id} className={`policy-control-card${control.pending_proposal ? " is-pending" : ""}`}>
                <div className="policy-control-topline">
                  <div>
                    <div className="metric-label">{t(control.label)}</div>
                    <code>{control.id}</code>
                  </div>
                  <Badge text={control.editable ? t("Editable") : t("Read-only")} variant="neutral" />
                </div>
                <div className="policy-value-guide">
                  <div className="current"><span>{t("Current value")}</span><strong>{formatValue(control.value)}</strong></div>
                  <div className="recommended">
                    <span>{t("Recommended")}</span>
                    <strong>{formatValue(recommendedValue(control))}</strong>
                    <small>{t(RECOMMENDED_VALUES[control.id] === undefined ? "Keep the current value unless a planned architecture change requires otherwise." : "Balanced best-practice default for quality and safe delivery.")}</small>
                  </div>
                  <div className="available">
                    <span>{t("Available values")}</span>
                    {availableValues(control).length > 0 ? (
                      <div className="policy-value-options">
                        {availableValues(control).map((value) => <code key={value}>{t(value)}</code>)}
                      </div>
                    ) : (
                      <small>{t(typeof control.value === "number" ? "Enter a numeric limit." : "Enter a custom value.")}</small>
                    )}
                  </div>
                </div>
                {control.pending_proposal && (
                  <div className="policy-pending-change">
                    <span>{t("Pending proposal")}</span>
                    <strong>{formatValue(control.value)} <i aria-hidden="true">→</i> {formatPendingProposal(control.pending_proposal)}</strong>
                  </div>
                )}
                <div className="policy-control-footer">
                  <span>{t("Source")}: <code>{control.source}</code></span>
                  {control.editable && onPropose && control.route && openFormId !== control.id && (
                    <button className="button ghost small-button" type="button" onClick={() => openForm(control)}>
                      {control.pending_proposal ? t("Propose another change") : t("Propose change")}
                    </button>
                  )}
                </div>
                {openFormId === control.id && control.route && (
                  <form className="policy-change-form"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void handleSubmit(control.route!, control.id, control.value);
                    }}
                  >
                    {availableValues(control).length > 0 ? (
                      <div className="policy-field-with-help">
                        <select
                          aria-label={`${control.label} ${t("New value").toLowerCase()}`}
                          value={formValue}
                          onChange={(e) => setFormValue(e.target.value)}
                          disabled={submitting}
                        >
                          {availableValues(control).map((allowedValue) => (
                            <option key={allowedValue} value={allowedValue}>
                              {t(allowedValue)}
                            </option>
                          ))}
                        </select>
                        {group.group === CODING_PRINCIPLES_GROUP && <HelpPopover text={CODING_PRINCIPLES_HELP} />}
                      </div>
                    ) : (
                      <input
                        aria-label={`${control.label} ${t("New value").toLowerCase()}`}
                        type="text"
                        value={formValue}
                        onChange={(e) => setFormValue(e.target.value)}
                        placeholder={t("New value")}
                        disabled={submitting}
                      />
                    )}
                    <textarea
                      aria-label={`${control.label} ${t("Change reason").toLowerCase()}`}
                      value={formReason}
                      onChange={(e) => setFormReason(e.target.value)}
                      placeholder={t("Reason")}
                      rows={2}
                      disabled={submitting}
                    />
                    <p className="policy-form-preview">
                      <span>{t("Proposed change")}</span>
                      <strong>{formatValue(control.value)} → {formValue || "—"}</strong>
                    </p>
                    {formError ? (
                      <p className="policy-form-error" style={{ color: "var(--error)" }} role="alert">
                        {formError}
                      </p>
                    ) : null}
                    <div className="policy-form-actions">
                      <button
                        className="button small-button"
                        type="submit"
                        disabled={submitting || !formReason.trim()}
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
              </article>
            ))}
          </div>
        </details>
      ))}
    </section>
  );
});
