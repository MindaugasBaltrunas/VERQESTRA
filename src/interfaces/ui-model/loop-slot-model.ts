// Loop slot'ų projekcija dashboard'ui (etalonas: AG_loop interfaces/cli/ui/index.ts
// `deriveLoopSlots`).
//
// GRYNA funkcija: visi skaitymai lieka kvietėjo pusėje, tad derivaciją galima ištestuoti be
// darbinio medžio. Modulis atsako į vienintelį klausimą — „ką kiekvienas srautas daro ŠIUO
// METU" — sudėdamas tris nepriklausomus šaltinius, kurių nė vienas atskirai atsakymo neturi:
//
//   valdiklis (`loop-control.json`) — ko operatorius NORI iš srauto;
//   bangos snapshot'as               — ką banga IŠDAVĖ ir kas realiai sukasi (`live_slots`);
//   worker lease'ai                  — atsarginis priskyrimo įrodymas senesniam snapshot'ui.
//
// `desired` ir `state` NESULIEJAMI sąmoningai: „operatorius sustabdė" ir „banga slot'o neišdavė"
// ekrane atrodo vienodai (nieko nevyksta), bet reikalauja skirtingo veiksmo. Antrąjį paaiškina
// `lastWave.rejected_reason`.

import {
  LOOP_SLOT_KEYS,
  resolveSlotMode,
  type LoopControlState,
  type LoopSlotMode,
} from "../../application/scheduling/loop-control-store.js";

export type UiLoopSlotState = "running" | "draining" | "aborting" | "idle";

/** Vieno srauto vaizdas operatoriui. Laukų vardai — wire kontraktas su `ui-app`. */
export type UiLoopSlot = {
  worker_id: string;
  worker_index: number;
  desired: LoopSlotMode;
  /** `aborting`, o ne `aborted`: valdiklis vykdomo bandymo NENUTRAUKIA (žr. loop-control-store). */
  state: UiLoopSlotState;
  task_id: string | null;
  attempt: number | null;
  /** `granted` yra bangos IŠDUOTŲ slot'ų SKAIČIUS (ne šio slot'o vėliava) — klientas ją išveda pats. */
  lastWave: { wave_id: string; granted: number; rejected_reason: string | null } | null;
};

/** Bangos snapshot'o pjūvis, kurio reikia slot'ams — struktūrinis, be loop sluoksnio importo. */
export type LoopSlotSnapshotView = {
  worker_pool?:
    | {
        wave_id: string;
        granted: number;
        rejected?: readonly { reason: string }[] | undefined;
        slots?: readonly { worker_id: string; task_id: string; attempt: number }[] | undefined;
      }
    | undefined;
  tasks?: readonly { task_id: string; state: string }[] | undefined;
  live_slots?: readonly { worker_id: string; task_id: string; attempt: number }[] | undefined;
};

/** Lease'o pjūvis: tas pats worker/task/attempt trejetas, tik iš kito šaltinio. */
export type LoopSlotLeaseView = {
  worker_id: string;
  task_id: string;
  attempt: number;
  status: string;
};

type SlotAssignment = { task_id: string; attempt: number };

export type DeriveLoopSlotsInput = {
  control: LoopControlState;
  snapshot?: LoopSlotSnapshotView | undefined;
  leases?: readonly LoopSlotLeaseView[] | undefined;
};

/**
 * Slot'ų vaizdas iš trijų šaltinių.
 *
 * Vykdymo ĮRODYMAS yra `live_slots`: jis rodo, kas dirba ŠIUO METU, įskaitant papildymus
 * (refill), kurie jokiam bangos planui nepriklauso, tad `worker_pool.slots` jų neturi. Kai jo
 * įrašo nėra (senesnis snapshot'as be šio lauko), krentama į SENĄJĮ įrodymą — bangos plano
 * slot'ą, kurio task'as snapshot'e yra `running`. Todėl idle slot'ui `task_id` grąžinamas
 * `null`: pasenęs plano įrašas be jokio vykdymo įrodymo atrodytų kaip vykstantis darbas.
 */
export function deriveLoopSlots(input: DeriveLoopSlotsInput): UiLoopSlot[] {
  const pool = input.snapshot?.worker_pool;
  const runningTaskIds = new Set(
    (input.snapshot?.tasks ?? []).filter((task) => task.state === "running").map((task) => task.task_id),
  );
  const firstRejection = pool?.rejected?.[0]?.reason ?? null;
  const liveByWorker = new Map((input.snapshot?.live_slots ?? []).map((slot) => [slot.worker_id, slot]));

  return LOOP_SLOT_KEYS.map((workerId, index): UiLoopSlot => {
    const workerIndex = index + 1;
    const live = liveByWorker.get(workerId);
    const planned = pool?.slots?.find((slot) => slot.worker_id === workerId);
    // Lease'ai naudojami TIK tada, kai snapshot'as slot'ų NETURI (senesnio `dist` įrašas): jie
    // neša tą patį worker_id/task_id/attempt trejetą. Naujo rašytojo čia neatsiranda.
    const lease = planned
      ? undefined
      : input.leases?.find((entry) => entry.worker_id === workerId && entry.status === "held");
    const assignment: SlotAssignment | undefined = live ?? planned ?? lease;

    const desired = resolveSlotMode(input.control, workerId);
    // `live` yra tiesioginis vykdymo įrodymas — autoritetas net tada, kai task'o bangos plano
    // `tasks` sąraše nėra arba jis ten pažymėtas ne `running` (refill slot'ai niekada nebuvo
    // bangos plano dalis).
    const running = live !== undefined || (assignment !== undefined && runningTaskIds.has(assignment.task_id));
    const state: UiLoopSlotState = !running
      ? "idle"
      : desired === "drain"
        ? "draining"
        : desired === "abort"
          ? "aborting"
          : "running";

    return {
      worker_id: workerId,
      worker_index: workerIndex,
      desired,
      state,
      task_id: running && assignment ? assignment.task_id : null,
      attempt: running && assignment ? assignment.attempt : null,
      lastWave: pool
        ? {
            wave_id: pool.wave_id,
            granted: pool.granted,
            // Priežastis rodoma TIK neišduotam slot'ui: išduotam ji būtų svetimo task'o atmetimas.
            rejected_reason: workerIndex > pool.granted ? firstRejection : null,
          }
        : null,
    };
  });
}
