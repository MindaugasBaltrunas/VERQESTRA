// Bangos slot'ų DISPATCH'as (etalonas: AG_loop orchestrator/loop/loop-wave-dispatch.ts).
//
// Du dalykai viename gyvavimo cikle: kuriuos slot'us apskritai paleisti (`planWaveDispatch`) ir
// kaip juos sukti lygiagrečiai nesugriaunant bendros būsenos (`dispatchWaveSlots`).
//
// PLANAVIMAS tik SIAURINA pool'o planą — keturios taisyklės:
//   1. fantominis slot'as nedispatch'inamas niekada; verdiktą priėmė pool'o planavimas, tad čia
//      jis nei perskaičiuojamas, nei ginčijamas. Prefikso jis NENUKERTA: fantomas nėra operatoriaus
//      sprendimas, o gretimas slot'as su savo darbo kopija lieka pilnai izoliuotas;
//   2. operatoriaus valdiklis vertinamas kaip PREFIKSAS — taip pat, kaip planuojant: slot'ai
//      išduodami iš eilės, tad sustabdžius `w1` tolesni irgi nedispatch'inami, kitaip antrasis
//      task'as pasisavintų pirmojo slot'o vietą, kurios operatorius kaip tik neleido;
//   3. antrinis slot'as be izoliuotos darbo kopijos sulaikomas — lygiagretus vykdymas tame pačiame
//      medyje yra būtent tai, ko visi vartai neleidžia;
//   4. tuščias pool'o planas reiškia VIENĄ slot'ą pasirinktam task'ui.

import { resolveSlotMode, type LoopControlState } from "./loop-control-store.js";
import type { SlotChildOutcome } from "./slot-task-runner.js";
import type { WaveSelection } from "./wave-scheduler-contract.js";
import type { WaveDispatchPlan, WaveDispatchSlot, WaveSlotResult, WaveWithheldSlot } from "./wave-dispatch-model.js";

export type { WaveDispatchPlan, WaveDispatchSlot, WaveSlotResult, WaveWithheldSlot } from "./wave-dispatch-model.js";

export function planWaveDispatch(
  selection: Extract<WaveSelection, { kind: "task" }>,
  control: LoopControlState,
  absolutePath: (relativeFile: string) => string,
): WaveDispatchPlan {
  const planned: WaveDispatchSlot[] =
    selection.pool.slots.length > 0
      ? selection.pool.slots.map((slot) => ({
          worker_id: slot.worker_id,
          task_id: slot.task_id,
          file: slot.file,
          absoluteFile: absolutePath(slot.file),
          ...(slot.worktree_path === undefined ? {} : { worktree_path: slot.worktree_path }),
          ...(slot.lease_id === undefined ? {} : { lease_id: slot.lease_id }),
          ...(slot.attempt_ref === undefined ? {} : { attempt_ref: slot.attempt_ref }),
        }))
      : [
          {
            worker_id: "w1",
            task_id: selection.task.task_id,
            file: selection.task.file,
            absoluteFile: selection.absoluteFile,
          },
        ];

  const dispatch: WaveDispatchSlot[] = [];
  const withheld: WaveWithheldSlot[] = [];
  let stopped = false;

  for (const [index, slot] of planned.entries()) {
    const phantom = selection.phantom?.find(
      (entry) => entry.worker_id === slot.worker_id && entry.task_id === slot.task_id,
    );
    if (phantom !== undefined) {
      withheld.push({ worker_id: slot.worker_id, task_id: slot.task_id, reason: `phantom:${phantom.reason}`, phantom: true });
      continue;
    }

    const mode = resolveSlotMode(control, slot.worker_id);
    if (stopped || mode !== "run") {
      stopped = true;
      withheld.push({ worker_id: slot.worker_id, task_id: slot.task_id, mode, reason: `${slot.worker_id}:${mode}` });
      continue;
    }

    // Pozicija imama iš PLANO, ne iš jau dispatch'intų kiekio: sulaikius pirmąjį slot'ą (fantomą)
    // antrasis vis tiek lieka antrasis, ir jo darbo kopijos reikalavimas negali dingti vien todėl,
    // kad prieš jį niekas nedirba — pirminiame medyje jis nedirba niekada.
    if (index > 0 && slot.worktree_path === undefined) {
      stopped = true;
      withheld.push({ worker_id: slot.worker_id, task_id: slot.task_id, reason: "missing-worktree" });
      continue;
    }
    dispatch.push(slot);
  }

  return { dispatch, withheld, halted: dispatch.length === 0 };
}

/**
 * Bangos pasirinkimas, perrašytas KONKREČIAM slot'ui.
 *
 * `beginTask` kontraktas nesikeičia — jis ir toliau priima vieną pasirinkimą. Antrajam slot'ui jo
 * ready task'as paimamas iš to paties plano, tad į ledger'į ir checkpoint'ą patenka būtent tas
 * task'as, kurį slot'as realiai suka.
 */
export function waveSelectionForSlot(
  selection: Extract<WaveSelection, { kind: "task" }>,
  slot: WaveDispatchSlot,
): Extract<WaveSelection, { kind: "task" }> {
  const task = selection.plan.ready.find((entry) => entry.task_id === slot.task_id) ?? selection.task;
  return { ...selection, task, absoluteFile: slot.absoluteFile };
}

export type WaveDispatchDeps = {
  /** Ledger'io/checkpoint'o įrašas prieš paleidžiant slot'ą. */
  beginTask: (slot: WaveDispatchSlot) => Promise<void>;
  /**
   * Pats vykdymas. Baigtis STRUKTŪRINĖ, ne `boolean`: `task-failed` ir `infrastructure` yra
   * skirtingi faktai (task'o kaltė vs aplinkos gedimas su exit kodu), o suplotas į `false` jų
   * skirtumas žūdavo būtent čia — baigties apskaita toliau nebeturėjo iš ko atskirti usage
   * limito nuo raudonų testų (2026-09-01: 20 task'ų į human-review per 14 min).
   */
  runTask: (slot: WaveDispatchSlot) => Promise<SlotChildOutcome>;
  /**
   * Terminalinės baigties fiksavimas. Kviečiama po vieną, net kai slot'ai baigia vienu metu.
   * Gauna TĄ PAČIĄ baigtį, kurią grąžino `runTask` — dispatch'as jos neinterpretuoja.
   */
  recordOutcome: (taskId: string, outcome: SlotChildOutcome) => Promise<void>;
  /**
   * Papildymas atsilaisvinusiam slot'ui. Kviečiama TIK: (a) po to, kai `recordOutcome` užfiksavo
   * baigtį, (b) TOJE PAČIOJE serializavimo sekcijoje, (c) tik kai bent vienas KITAS lane'as dar
   * vykdo `runTask`. `undefined` = papildymo nėra, lane'as baigiasi.
   */
  refill?: (freed: WaveDispatchSlot) => Promise<WaveDispatchSlot | undefined>;
  /**
   * Lane klaidos matomumas. Kviečiamas KLAIDOS MOMENTU, prieš baigties įrašą — kitaip klaida
   * iškyla tik po `Promise.all`, kai kiti lane'ai baigia, ir „kada bei kuris lane'as žlugo" tampa
   * neatsakoma. Jo paties klaida praryjama, kad nepaslėptų originalios.
   */
  onLaneError?: (slot: WaveDispatchSlot, error: unknown) => Promise<void>;
};

/**
 * Paleidžia visus suteiktus slot'us LYGIAGREČIAI ir grąžina jų baigtis.
 *
 * Kas lygiagretu ir kas ne — tyčia:
 *   - `beginTask` kviečiamas NUOSEKLIAI ir plano tvarka: jis rašo bendrą snapshot'ą bei
 *     checkpoint'ą, tad lygiagretus kvietimas duotų dvi to paties failo versijas;
 *   - `runTask` kviečiamas visiems vienu metu — tai ir yra visa šios funkcijos prasmė;
 *   - `recordOutcome` serializuojamas: jis keičia bendrą bangos būseną ir persistuoja snapshot'ą.
 *     Fiksuojama vis tiek TADA, kai slot'as realiai baigia, o ne po visų — todėl „vienas dar
 *     dirba" ir „visi terminaliniai" lieka atskiri, matomi bangos momentai.
 *
 * Metimas (infrastruktūros klaida) nutraukia run'ą — bet tik PALAUKUS kitų slot'ų: palikti gyvą
 * lygiagretų vykdymą be priežiūros reikštų, kad jo darbas dingsta be jokio įrašo. Metančiam
 * slot'ui baigtis nefiksuojama sąmoningai: metimas nėra terminalinė task'o baigtis, o run'o pabaiga.
 */
export async function dispatchWaveSlots(
  slots: readonly WaveDispatchSlot[],
  deps: WaveDispatchDeps,
): Promise<WaveSlotResult[]> {
  for (const slot of slots) await deps.beginTask(slot);

  // Nuoseklinimo grandinė. Ankstesnio įrašo KLAIDA neužkerta kelio kito slot'o rezultatui:
  // priešingu atveju vienas nepavykęs snapshot'o rašymas paslėptų antro slot'o baigtį, ir banga
  // niekada neužsidarytų. Pati klaida nedingsta — ją gauna savo slot'o iškvietėjas.
  let tail: Promise<unknown> = Promise.resolve();
  const serialize = <T>(work: () => Promise<T>): Promise<T> => {
    const next = tail.then(work, work);
    tail = next;
    return next;
  };

  type Settlement = { slot: WaveDispatchSlot } & ({ ok: boolean } | { error: unknown });
  // Kiek lane'ų dar turi neužfiksuotą baigtį. Skaitiklis keičiamas TIK serializuotoje sekcijoje
  // (arba metimo kelyje, kuris papildymo nebeprašo), tad lenktynių tarp lane'ų nėra.
  let active = slots.length;
  // Baigtys laikomos PAGAL LANE'Ą: taip pirmoji klaida lieka randama plano tvarka net tada, kai
  // lane'as per savo gyvenimą apdorojo kelis task'us.
  const laneSettlements: Settlement[][] = slots.map(() => []);

  await Promise.all(
    slots.map(async (first, lane): Promise<void> => {
      const settlements = laneSettlements[lane] ?? [];
      let current: WaveDispatchSlot | undefined = first;

      while (current !== undefined) {
        const running: WaveDispatchSlot = current;
        let outcome: SlotChildOutcome;
        try {
          outcome = await deps.runTask(running);
        } catch (error) {
          // Žurnalas PRIEŠ baigties įrašą — klaida matoma jos momentu, ne po visų lane'ų.
          if (deps.onLaneError !== undefined) await deps.onLaneError(running, error).catch(() => undefined);
          settlements.push({ slot: running, error });
          active -= 1;
          return;
        }

        let next: WaveDispatchSlot | undefined;
        try {
          next = await serialize(async (): Promise<WaveDispatchSlot | undefined> => {
            try {
              await deps.recordOutcome(running.task_id, outcome);
            } finally {
              // Skaitiklis mažinamas `finally`, kad nepavykęs įrašas nepaliktų amžinai „aktyvaus"
              // lane'o — kiti slot'ai tada niekada nesulauktų tylos.
              active -= 1;
            }
            // Paskutinis lane'as niekada nepapildomas: valdymas privalo grįžti į išorinį loop'o
            // ciklą, kur veikia nešvaraus medžio vartas ir pilnas bangos perskaičiavimas.
            //
            // Papildymas eina PO pilnai užbaigto `recordOutcome`, ir tai kontraktas, ne eiliškumo
            // atsitiktinumas: inkrementinė integracija vykdoma BŪTENT `recordOutcome` viduje, tad
            // atsilaisvinęs indeksas negali būti užpildytas suliejimo metu — kitaip papildytas
            // vaikas gautų darbo kopiją nuo bazės, kuri jam po kojomis pajuda.
            if (active === 0 || deps.refill === undefined) return undefined;
            const candidate = await deps.refill(running);
            if (candidate === undefined) return undefined;
            // Skaitiklis didinamas TIK po sėkmingo `beginTask`.
            await deps.beginTask(candidate);
            active += 1;
            return candidate;
          });
        } catch (error) {
          // Fiksavimo (ar papildymo) klaida tampa šio lane'o baigtimi, o run'as nutraukiamas tik
          // palaukus kitų lane'ų.
          if (deps.onLaneError !== undefined) await deps.onLaneError(running, error).catch(() => undefined);
          settlements.push({ slot: running, error });
          return;
        }

        settlements.push({ slot: running, ok: outcome.status === "succeeded" });
        current = next;
      }
    }),
  );

  const settlements = laneSettlements.flat();

  // Pirmoji klaida PLANO tvarka, o ne baigimo tvarka: ta pati įvestis privalo duoti tą pačią
  // išvestį, kad diagnozė būtų atkuriama.
  const failed = settlements.find((entry): entry is { slot: WaveDispatchSlot; error: unknown } => "error" in entry);
  if (failed !== undefined) throw failed.error;

  return settlements.filter((entry): entry is WaveSlotResult => "ok" in entry);
}
