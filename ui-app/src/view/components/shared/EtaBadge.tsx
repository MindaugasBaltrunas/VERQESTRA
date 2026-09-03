import { memo } from "react";
import { fill } from "../../../model/fillTemplate";
import { formatEtaRange } from "../../../model/slotProgressFormat";
import type { SlotEtaView } from "../../../model/slotProgressViewModel";
import { useI18n } from "../../../i18n/I18nContext";

/** Patikimumas → ženkliuko spalva. `low` lieka neutralus: raudona reikštų gedimą, o ne mažą imtį. */
const CONFIDENCE_CLASS: Record<"high" | "medium" | "low", string> = {
  high: "status-good",
  medium: "status-warning",
  low: "status-neutral",
};

type Props = { eta: SlotEtaView };

export const EtaBadge = memo(function EtaBadge({ eta }: Props) {
  const { t } = useI18n();

  if (eta.state === "unavailable") {
    // Visos trys priežastys vartotojui reiškia tą patį — prognozės nėra. Konkretus kodas lieka
    // `title` atribute diagnostikai, o ne ekrane, kur atrodytų kaip klaida.
    return (
      <span className="slot-eta slot-eta--unavailable" title={eta.reason}>
        {t("ETA: not enough data")}
      </span>
    );
  }

  return (
    <span className="slot-eta">
      {t("ETA")}: {formatEtaRange(eta.lowMs, eta.highMs)}{" "}
      <span className={`badge ${CONFIDENCE_CLASS[eta.confidence]}`}>
        {fill(t("Estimate confidence: {level}"), { level: t(eta.confidence) })}
      </span>
    </span>
  );
});
