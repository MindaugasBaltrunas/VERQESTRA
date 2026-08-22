import { memo } from "react";
import type { OperatorToast } from "../../controller/useOperatorActions";
import { useI18n } from "../../i18n/I18nContext";

type Props = {
  toasts: readonly OperatorToast[];
  onDismiss: (id: number) => void;
};

/**
 * Veiksmų rezultatų krūvelė. Grynas vaizdas: nei laikmačių, nei užklausų — kada pranešimas dingsta,
 * sprendžia `useOperatorActions`.
 *
 * Klaida gauna `role="alert"`, o sėkmė — `role="status"`: pirmoji nutraukia skaitytuvą, nes reikalauja
 * veiksmo, antroji tik patvirtina jau įvykusį dalyką.
 */
export const ToastStack = memo(function ToastStack({ toasts, onDismiss }: Props) {
  const { t } = useI18n();
  if (toasts.length === 0) return null;

  return (
    <div className="toast-stack" aria-live="polite">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`toast toast-${toast.tone}`}
          role={toast.tone === "error" ? "alert" : "status"}
        >
          <span>{toast.message}</span>
          <button
            className="button ghost small-button" type="button"
            aria-label={t("Dismiss")}
            onClick={() => onDismiss(toast.id)}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
});
