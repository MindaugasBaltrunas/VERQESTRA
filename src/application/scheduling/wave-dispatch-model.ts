// Bangos DISPATCH'o tipai (etalonas: AG_loop orchestrator/loop/loop-wave-dispatch.ts tipų dalis).
//
// Tipai gyvena atskirai nuo `wave-dispatch` vykdymo, nes juos naudoja ir papildymas
// (`wave-refill`), ir planuoklio kontraktas — o vykdymas savo ruožtu remiasi kontraktu. Bendras
// failas uždarytų importų ciklą.

import type { AttemptRef } from "./worker-limits.js";
import type { LoopSlotMode } from "./loop-control-store.js";

export type WaveDispatchSlot = {
  worker_id: string;
  task_id: string;
  /** Repo-relative task failas — toks, koks jis yra pool'o plane. */
  file: string;
  absoluteFile: string;
  /**
   * Izoliuota darbo kopija. Pirminis slot'as jos neturi (jis dirba pačiame medyje); kiekvienas
   * tolesnis be jos NIEKADA nedispatch'inamas — ta pati sąlyga, kurią pool'as vadina
   * `missing-worktree`.
   */
  worktree_path?: string;
  /**
   * Pool'o slot'ui išduoto lease ID. Tik identifikatorius sutapdinimui: nuosavybės įrodymas
   * (fencing token) VISADA imamas šviežiu store skaitymu prieš vaiko paleidimą — slot'as jo
   * niekada nekopijuoja.
   */
  lease_id?: string;
  /** Atskiras `run/worker/task/attempt` namespace, kuriame gyvena šio slot'o įrodymai. */
  attempt_ref?: AttemptRef;
};

/** Slot'as, kuris buvo suplanuotas, bet NEdispatch'intas — su įvardinta priežastimi. */
export type WaveWithheldSlot = {
  worker_id: string;
  task_id: string;
  /** Operatoriaus režimas, jei slot'ą sulaikė būtent valdiklis. */
  mode?: LoopSlotMode;
  reason: string;
  /**
   * `true`, kai slot'as sulaikytas kaip FANTOMAS, o ne valdikliu ar trūkstama kopija. Skirtumas
   * nėra kosmetinis: „drain" yra operatoriaus sprendimas, o fantomas — plano ir tikrovės
   * nesutapimas, ir jį reikia taisyti, ne laukti.
   */
  phantom?: boolean;
};

export type WaveDispatchPlan = {
  dispatch: WaveDispatchSlot[];
  withheld: WaveWithheldSlot[];
  /** `true`, kai nedispatch'inamas NĖ VIENAS slot'as — tada banga apskritai neprasideda. */
  halted: boolean;
};

export type WaveSlotResult = { slot: WaveDispatchSlot; ok: boolean };
