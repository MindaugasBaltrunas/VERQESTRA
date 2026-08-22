import { memo } from "react";
import type { SlotProgressView } from "../../model/slotProgressViewModel";
import { SlotProgressCard } from "./SlotProgressCard";
import { useI18n } from "../../i18n/I18nContext";

/** Skeleton'ų tiek, kiek srautų daugiausiai gali būti — kad atsiradę duomenys nešokdintų išdėstymo. */
const SKELETON_SLOTS = [1, 2];

type Props = {
  views: readonly SlotProgressView[];
  /**
   * Tikrų duomenų dar nėra: srauto valdiklio serveris neatsiuntė, o bangos dar neatsakė. Tokios
   * kortelės būtų sudarytos iš numatytųjų reikšmių, tad vietoj jų rodomas skeleton'as — spėjimas,
   * atrodantis kaip faktas, yra blogiau nei matomas laukimas.
   */
  awaitingData?: boolean;
};

/**
 * Srautų santrauka `#/` ekrane (task 1233): kompaktiškos kortelės šalia grandinės rodinio.
 *
 * Mygtukų čia NĖRA sąmoningai — srautų valdymas turi vieną šeimininką `#/system`, o antra veiksmų
 * vieta reikštų du kelius tam pačiam veiksmui.
 */
export const SlotStreamsOverview = memo(function SlotStreamsOverview({ views, awaitingData = false }: Props) {
  const { t } = useI18n();

  return (
    <section className="panel" aria-labelledby="slot-streams-overview-title">
      <div className="panel-header">
        <div>
          <h2 id="slot-streams-overview-title">{t("Loop streams overview")}</h2>
          <p className="panel-subtitle">{t("Real-time execution status")}</p>
        </div>
      </div>
      <div className="runtime-grid">
        {awaitingData
          ? SKELETON_SLOTS.map((slot) => (
              <article key={slot} className="runtime-card slot-card slot-card--compact" aria-hidden="true">
                <div className="skeleton skeleton-line" />
                <div className="skeleton skeleton-line" />
              </article>
            ))
          : views.map((view) => <SlotProgressCard key={view.workerId} view={view} variant="compact" />)}
      </div>
    </section>
  );
});
