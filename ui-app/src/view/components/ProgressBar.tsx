import { memo } from "react";
import { formatPercentLabel } from "../../model/slotProgressFormat";
import type { SlotProgressBar } from "../../model/slotProgressViewModel";
import { useI18n } from "../../i18n/I18nContext";

/**
 * Biudžeto lygis → juostos spalva. `normal` sąmoningai lieka be modifikatoriaus (numatytasis
 * akcentas): žalia „viskas gerai" meluotų, nes neišnaudotas biudžetas dar nieko nesako apie
 * rezultatą — jis sako tik tiek, kad riba dar nepasiekta.
 */
const BUDGET_MODIFIER: Record<"normal" | "warning" | "over", string> = {
  normal: "",
  warning: " progress-bar--warning",
  over: " progress-bar--error",
};

type Props = {
  progress: SlotProgressBar;
  /**
   * Nenurodyta — juosta be teksto eilutės (procentas lieka `title` atribute). Nurodyta, bet `null`,
   * reiškia „eilutė reikalinga, teksto nėra": nežinomas progresas tada gauna savo paaiškinimą, nes
   * be jo apie nežinomybę pasakotų tik animacija.
   */
  label?: string | null;
};

export const ProgressBar = memo(function ProgressBar({ progress, label }: Props) {
  const { t } = useI18n();

  // „Signalo nėra" NĖRA nulinis progresas: `role="progressbar"` su 0 % sakytų, kad darbas
  // neprasidėjo. Tokiu atveju juostos nėra iš viso, o kortelė parašo, kad duomenų nėra.
  if (progress.signal === "none") return null;

  if (progress.signal === "indeterminate") {
    // Be `aria-valuenow`: reikšmės NĖRA, o bet koks skaičius čia būtų prasimanytas.
    //
    // Užrašas rodomas ir tekstu, o ne vien judesiu: prašant mažiau judesio animacija sustoja, ir
    // vien juosta tada atrodytų kaip įvykdytas progresas. Judesys NIEKADA nėra vienintelis
    // informacijos nešėjas.
    const unknownLabel = t("Progress unknown");
    return (
      <>
        <div
          className="progress-bar progress-bar--indeterminate"
          role="progressbar"
          aria-label={unknownLabel}
          title={unknownLabel}
        >
          <span className="progress-bar__fill" />
        </div>
        {label !== undefined ? <p className="progress-bar__label"><span>{label ?? unknownLabel}</span></p> : null}
      </>
    );
  }

  // Grandinės juosta visada „gera": ji rodo nueitą kelią, o ne sunaudotą resursą.
  const modifier = progress.signal === "chain" ? " progress-bar--good" : BUDGET_MODIFIER[progress.level];
  const percentLabel = formatPercentLabel(progress.percent);

  return (
    <>
      <div
        className={`progress-bar${modifier}`}
        role="progressbar"
        aria-label={t("Progress")}
        aria-valuenow={progress.percent}
        aria-valuemin={0}
        aria-valuemax={100}
        title={percentLabel}
      >
        {/* Procentas keliauja CSS kintamuoju: `width` kiekviename kadre verstų naršyklę
            perskaičiuoti išdėstymą, o `scaleX(var(--progress))` lieka kompozitoriaus sluoksnyje. */}
        <span className="progress-bar__fill" style={{ ["--progress" as string]: progress.percent / 100 }} />
      </div>
      {label ? (
        <p className="progress-bar__label">
          <span>{label}</span>
          <span>{percentLabel}</span>
        </p>
      ) : null}
    </>
  );
});
