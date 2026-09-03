import { memo, type ReactNode } from "react";
import type { LoopControlView, LoopSlotView, StatusVariant } from "../../../model/dashboardViewModel";
import { fill } from "../../../model/fillTemplate";
import { fixActionId, slotActionId } from "../../../model/loopControlsViewModel";
import type { SlotProgressView } from "../../../model/slotProgressViewModel";
// `LoopSlotState` yra bendras kontraktas iš `types`, o ne rodinio tipas: `dashboardViewModel` jį tik
// vartoja ir NEeksportuoja, tad importas per jį lūžta `tsc -b` metu (vitest tipų netikrina).
import type { LoopSlotState, LoopWorkerId } from "../../../model/types";
import { Badge } from "../shared/Badge";
import { ConfirmButton } from "../shared/ConfirmButton";
import { SlotProgressCard } from "./SlotProgressCard";
import { useI18n } from "../../../i18n/I18nContext";

/** Tuščias rinkinys yra pastovus: naujas `Set` kiekvienam renderiui griautų `memo` prasmę. */
const NO_PENDING: ReadonlySet<string> = new Set<string>();

/** Būsenos raktai rašomi ANGLIŠKAI, nes anglų kalba yra `t()` vertimų raktų kalba. */
const SLOT_STATE_LABEL: Record<LoopSlotState, string> = {
  running: "Running",
  draining: "Draining",
  aborting: "Aborting",
  idle: "Idle",
};

const SLOT_STATE_VARIANT: Record<LoopSlotState, StatusVariant> = {
  running: "live",
  draining: "warning",
  aborting: "error",
  idle: "neutral",
};

type Props = {
  loopControl: LoopControlView;
  onStopSlot?: (workerId: LoopWorkerId) => void;
  onResumeSlot?: (workerId: LoopWorkerId) => void;
  onAbortSlot?: (workerId: LoopWorkerId) => void;
  /**
   * Progreso rodinys — PAPILDOMAS blokas, o ne nauja prielaida: be jo (arba be įrašo konkrečiam
   * srautui) kortelė lieka tiksliai tokia, kokia buvo, su tuo pačiu tekstu ir tais pačiais mygtukais.
   */
  slotProgress?: readonly SlotProgressView[];
  /**
   * Užduotys, kurias serveris realiai leidžia grąžinti į eilę (`human-review`). Be šio rinkinio
   * „Taisyk" mygtukas NErodomas — žr. `streamBody`.
   */
  fixableTaskIds?: ReadonlySet<string>;
  onFixTask?: (taskId: string) => void;
  pendingActions?: ReadonlySet<string>;
};

/**
 * Srautų (loop slot'ų) gyvavimo ciklas — task 0052, iškeltas iš `RuntimePanel` (task 1233).
 *
 * Task 1235: VISO ciklo veiksmai (paleisti / sustabdyti / perkrauti / srautų skaičius) iš čia
 * išsikraustė į `LoopControls`. Šiai panelei lieka tik tai, ką galima padaryti VIENAM srautui —
 * taip vienas ketinimas nebeturi dviejų šeimininkų.
 */
export const LoopStreamCards = memo(function LoopStreamCards({
  loopControl,
  onStopSlot,
  onResumeSlot,
  onAbortSlot,
  slotProgress,
  fixableTaskIds,
  onFixTask,
  pendingActions = NO_PENDING,
}: Props) {
  const { t } = useI18n();

  const streamBody = (slot: LoopSlotView): ReactNode => {
    // Dvi visiškai skirtingos „nieko nevyksta" priežastys: operatoriaus sprendimas ir bangos
    // atsisakymas. Jos NIEKADA nerodomos viena vietoj kitos.
    const drainNote = slot.desired === "drain"
      ? t("Stopped by the operator: the running attempt finishes and no new task is assigned to this stream.")
      : null;
    const waveNote = slot.desired === "run" && slot.lastWave && !slot.lastWave.granted
      ? fill(t("This stream was not granted by the last wave: {reason}"), { reason: slot.lastWave.rejectedReason ?? t("unknown") })
      : null;
    // Srautai atrodo simetriški, bet `w1` nėra lygiavertis: paleidimo sąlyga tikrina veikiančių
    // srautų PREFIKSĄ, tad jį sustabdžius lieka 0 slot'ų ir ciklo procesas baigiasi. Sakinys
    // rodomas VISADA, o ne tik po sustabdymo: jo reikia PRIEŠ paspaudimą, ir jis pataiso
    // `drainNote` frazę „šiam srautui". Ta pati riba nurodo, ar `drain` turi reikalauti
    // patvirtinimo (žr. `stopsWholeLoop` žemiau).
    const stopsWholeLoop = slot.workerId === "w1";
    const loopGateNote = stopsWholeLoop
      ? fill(t("Stream {stream} gates the whole loop: stopping it stops the loop process, not just this stream."), {
          stream: slot.index,
        })
      : null;

    const drainBusy = pendingActions.has(slotActionId(slot.workerId, "drain"));
    const resumeBusy = pendingActions.has(slotActionId(slot.workerId, "run"));
    const abortBusy = pendingActions.has(slotActionId(slot.workerId, "abort"));
    // „Taisyk" rodomas TIK tada, kai užduotis realiai yra `human-review`: serveris leidžia vien
    // `human-review -> queue`, tad kitu atveju vienintelė galima paspaudimo baigtis būtų 409. Amžinai
    // pilkas mygtukas kiekvienoje kortelėje mokytų, kad UI moka tai, ko nemoka, o išjungtas mygtukas
    // be paaiškinimo yra klausimas be atsakymo. Vykdomai užduočiai sąžiningi veiksmai — „Stabdyti"
    // ir „Nutraukti" — jau stovi toje pačioje kortelėje.
    const fixableTaskId =
      slot.taskId !== null && onFixTask !== undefined && fixableTaskIds?.has(slot.taskId) ? slot.taskId : null;
    const fixBusy = fixableTaskId !== null && pendingActions.has(fixActionId(fixableTaskId));

    /**
     * Ar srautas apskritai turi vykdomą bandymą.
     *
     * Iki 2026-08-28 šis rinkinys uždarydavo IR `drain`, IR `abort` tuščiam srautui — argumentas
     * buvo, kad abu veikia tik vykdomą bandymą, tad tuščiam srautui jie nekeičia nieko. Tai buvo
     * neteisinga `drain` atžvilgiu: `desired: "drain"` yra NORIMOS būsenos įrašas (žr. toliau),
     * kuris uždraudžia slot'ui imti KITĄ užduotį — prasminga net kai dabar jis tuščias. Task 050
     * (audito radinys) tą sąlygą nuima nuo `drain`. `abort` ją išlaiko: kol jis lieka atskiras
     * pavadinimas tam pačiam poveikiui (žr. `ConfirmButton` žemiau), keisti jo elgesį reikštų
     * spėlioti apie kontraktą, kurio ši užduotis nekeičia.
     */
    const hasWork = slot.taskId !== null;

    // `drain` tuščiam slot'ui nuo 2026-08-28 lieka aktyvus (žr. `hasWork` komentarą aukščiau) —
    // sąlyga nebepriklauso nuo `hasWork`.
    const drainDisabled = !onStopSlot || slot.desired !== "run" || drainBusy;
    /**
     * `w1` sustabdymas sustabdo VISĄ ciklą, ne tik šį srautą (`loopGateNote` aukščiau) — tad jam
     * vieno paspaudimo `drain` yra pavojingas patvirtinimo trūkumas (audito radinys, task 050).
     * Kitiems srautams `drain` paliečia TIK juos, tad vieno paspaudimo elgesys lieka teisingas.
     */
    const drainButton = stopsWholeLoop ? (
      <ConfirmButton
        label={t("Stop stream (drain)")}
        confirmLabel={t("Confirm: stops the whole loop")}
        cancelLabel={t("Cancel")}
        tone="ghost"
        disabled={drainDisabled}
        busy={drainBusy}
        onConfirm={() => onStopSlot?.(slot.workerId)}
      />
    ) : (
      <button
        className="button ghost small-button" type="button"
        disabled={drainDisabled}
        aria-busy={drainBusy || undefined}
        onClick={() => onStopSlot?.(slot.workerId)}
      >
        {t("Stop stream (drain)")}
        {drainBusy && <span className="button-spinner" aria-hidden="true" />}
      </button>
    );

    return (
      <>
        {drainNote && <p className="runtime-explanation">{drainNote}</p>}
        {waveNote && <p className="runtime-explanation">{waveNote}</p>}
        {loopGateNote && <p className="runtime-explanation">{loopGateNote}</p>}
        <div className="toolbar">
          {drainButton}
          <button
            className="button ghost small-button" type="button"
            disabled={!onResumeSlot || slot.desired === "run" || resumeBusy}
            aria-busy={resumeBusy || undefined}
            onClick={() => onResumeSlot?.(slot.workerId)}
          >
            {t("Resume stream")}
            {resumeBusy && <span className="button-spinner" aria-hidden="true" />}
          </button>
          {/* Grąžinimas į eilę patvirtinimo NETURI — vienas paspaudimas. `human-review -> queue` yra
              grįžtamas ir nieko nesunaikina, o užstrigusi užduotis turi būti atrakinama iš tos pačios
              kortelės, kurioje ji matoma. `HumanReviewPanel` tas pats veiksmas patvirtinamas
              sąmoningai: ten jis stovi šalia terminalinio „Complete" ir yra žmogaus verdiktas. */}
          {fixableTaskId !== null && (
            <button
              className="button success small-button" type="button"
              disabled={fixBusy}
              aria-busy={fixBusy || undefined}
              onClick={() => onFixTask?.(fixableTaskId)}
            >
              {t("Fix (requeue)")}
              {fixBusy && <span className="button-spinner" aria-hidden="true" />}
            </button>
          )}
          {/* Nutraukimas patvirtinamas DVIEM paspaudimais toje pačioje vietoje, kur jis vykdomas:
              modalinis `window.confirm` būtų ir netestuojamas, ir atitrūkęs nuo srauto, kurį liečia.
              `tone="danger"` čia BUVO klaidinantis (audito radinys, task 050): mygtukas žadėjo
              realų priverstinį nutraukimą, kurio nėra — panelės paantraštė žemiau tai jau
              paaiškina. Pavadinimo NEkeičiame: `RuntimePanel.test.tsx` (šios užduoties `## Failai`
              ribos NEAPIMA) ieško mygtuko būtent pagal šį tekstą, tad tekstinis pervadinimas jį
              nutylomis nulaužtų. Sprendimas — nuimti tik `tone`, palikti neutralų `ghost`. */}
          <ConfirmButton
            label={t("Abort stream")}
            confirmLabel={t("Confirm abort")}
            cancelLabel={t("Cancel")}
            tone="ghost"
            disabled={!onAbortSlot || !hasWork}
            busy={abortBusy}
            onConfirm={() => onAbortSlot?.(slot.workerId)}
          />
        </div>
      </>
    );
  };

  return (
    <section className="panel" aria-labelledby="loop-streams-title">
      <div className="panel-header">
        <div>
          <h2 id="loop-streams-title">{t("Loop streams")}</h2>
          {/* Sakinys apie abort'ą stovi šalia paties mygtuko: valdiklis vykdomo bandymo
              NENUTRAUKIA — nuo `drain` jis skiriasi tik rodoma būsena, todėl žadėti stabdymą
              reikštų meluoti apie tai, ką mygtukas padarys. */}
          <p className="panel-subtitle">
            {t("Abort does not stop a running attempt — it finishes exactly as with drain, and only the reported state differs. A real force-abort is not implemented.")}
          </p>
        </div>
      </div>
      {loopControl.invalid && (
        <p className="runtime-explanation">
          ⚠ {t("The loop control file is unreadable; every stream defaults to run.")}
        </p>
      )}
      <div className="runtime-grid">
        {loopControl.slots.map((slot) => {
          const streamName = `${t("Stream")} ${slot.index}`;
          const progress = slotProgress?.find((view) => view.workerId === slot.workerId);

          return progress ? (
            <SlotProgressCard key={slot.workerId} view={progress} variant="full">
              {streamBody(slot)}
            </SlotProgressCard>
          ) : (
            <article key={slot.workerId} className="runtime-card" aria-label={streamName}>
              <div className="runtime-card-top">
                <div>
                  <h3>{streamName}</h3>
                  <p>
                    {slot.taskId
                      ? fill(t("Task {task}, attempt {attempt}"), { task: slot.taskId, attempt: slot.attempt ?? "—" })
                      : t("No task assigned")}
                  </p>
                </div>
                <Badge text={t(SLOT_STATE_LABEL[slot.state])} variant={SLOT_STATE_VARIANT[slot.state]} />
              </div>
              {streamBody(slot)}
            </article>
          );
        })}
      </div>
    </section>
  );
});
