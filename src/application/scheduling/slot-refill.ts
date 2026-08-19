// Rolling slot refill: atsilaisvinusio worker slot'o papildymas. Behaviour etalon:
// AG_loop application/scheduling/slot-refill.ts papildymo pusė (etalono 628 eil. failas
// skaidomas į slot-refill + worker-integration pagal 500 eil. gate; vardai 1:1).
//
// Iki šio žingsnio banga buvo ir planavimo, ir vykdymo vienetas: du slot'ai startuodavo
// kartu, o greitasis lane'as prastovėdavo, kol lėtasis baigs. Čia gyvena epizodo logika —
// „vienas slot'as atsilaisvino; ką jam duoti".
//
// Ko čia NĖRA sąmoningai: nė vienos savo leidimo taisyklės. Visi vartai lieka worker-pool
// admission modulyje (`checkSlotEligibility`, `admitWorkerCandidate`,
// `orderWorkerCandidates`, `buildWorkerSlot`), o šis modulis tvarko tik epizodo seką,
// gyvų slot'ų projekciją, talpą ir drain/stop laikymą. Priklausomybės kryptis vienpusė:
// worker-pool moduliai šio neimportuoja.
//
// Modulis grynas — jokio FS, git, laikrodžio ar atsitiktinumo: „dabar" ir gyvų slot'ų
// sąrašas ateina kaip įvestis, todėl tą patį epizodą galima perskaičiuoti ir gauti tą
// patį `episode_hash`.

import type { WorkerLease } from "../../domain/scheduling/index.js";
import type { IndependenceVerdict, TaskWriteSet, WriteSetConflict } from "./conflict-detector.js";
import {
  admitWorkerCandidate,
  buildWorkerSlot,
  checkSlotEligibility,
  computeSchedulingHash,
  orderWorkerCandidates,
  type WorkerCandidate,
  type WorkerRejection,
  type WorkerSlot,
} from "./worker-pool-admission.js";

/** Papildymo TAISYKLIŲ versija. Įeina į `episode_hash`, tad pakeitus taisykles seni atspaudai skiriasi. */
export const SLOT_REFILL_VERSION = 1;

/**
 * Slot'as, kuris ŠIUO METU vykdo attempt'ą.
 *
 * Tai realaus laiko faktas, ne plano įrašas: papildytas slot'as jokiam bangos planui
 * nepriklauso, tad `WorkerPoolPlan.slots` apie jį nieko nesako. Neša viską, ko reikia
 * leidimo vartams — write set'ą, lease ir darbo kopiją — kad užimtąjį būtų galima vertinti
 * tomis pačiomis taisyklėmis kaip kandidatą.
 */
export type LiveSlot = {
  worker_id: string;
  worker_index: number;
  task_id: string;
  file: string;
  attempt: number;
  write_set: TaskWriteSet;
  lease?: WorkerLease;
  worktree_path?: string;
  started_at: string;
};

/** Kas laiko papildymą. `none` reiškia, kad laikymo nėra — ne kad papildymas jau leistas. */
export type SlotRefillHold =
  | { kind: "none" }
  | { kind: "slot-drained"; detail: string }
  | { kind: "stop-requested"; detail: string };

export type SlotRefillInput = {
  run_id: string;
  /** 1-based, monotoniškai augantis run'e. Įeina į atspaudą, tad epizodai nesusilieja. */
  episode: number;
  freed_slot: { worker_id: string; worker_index: number };
  /** Kandidatai BE gyvų ir BE jau paleistų task'ų — „jau paleistų" taisyklė ta pati kaip bangoje. */
  candidates: readonly WorkerCandidate[];
  /** Visi KITI gyvi slot'ai, `worker_index` tvarka. */
  live: readonly LiveSlot[];
  granted_workers: number;
  hold: SlotRefillHold;
  /**
   * Ar pirminio slot'o lease claim'as pasiekia rašymo autoriteto patikrą. TA PATI reikšmė
   * ir ta pati semantika kaip `PlanWorkerPoolInput.primary_claim_supported` bei
   * `planSlotProvisioning` — vienas politikos savininkas paduoda ją visiems trims keliams,
   * kad papildymas negalėtų tyliai likti švelnesnis už bangą, kai vėliava bus apversta.
   *
   * Numatytoji `true` — istorinis GRIEŽTAS elgesys: gyvo slot'o trūkstamas lease/worktree
   * tada tebėra blokuojanti klaida. Paduota `false` reiškia, kad pirminis slot'as dirba
   * pirminiame medyje be lease PAGAL DIZAINĄ, tad UŽIMTOJO trūkstamas `lease`/
   * `worktree_path` papildymo nebeblokuoja. Kandidato paties patikros ši reikšmė neliečia
   * niekada, o sugadintas užimtojo lease blokuoja nepaisant jos.
   */
  primary_claim_supported?: boolean;
  now: Date;
};

export type SlotRefillDecision = {
  refill_version: number;
  run_id: string;
  episode: number;
  worker_id: string;
  worker_index: number;
  granted_workers: number;
  slot?: WorkerSlot;
  rejected: WorkerRejection[];
  verdicts: IndependenceVerdict[];
  conflicts: WriteSetConflict[];
  /** Gyvų slot'ų task'ai, surūšiuoti — kas dirbo TUO METU, kai epizodas buvo sprendžiamas. */
  live_task_ids: string[];
  episode_hash: string;
  /** Viena eilutė log'ui ir snapshot'ui. Formatavimo taisyklė — VIENA, ir ji gyvena čia. */
  reason: string;
};

/** Gyvas slot'as → kandidato forma, kurią priima worker-pool vartai. */
export function occupantOf(slot: LiveSlot): WorkerCandidate {
  return {
    task_id: slot.task_id,
    file: slot.file,
    attempt: slot.attempt,
    write_set: slot.write_set,
    ...(slot.lease ? { lease: slot.lease } : {}),
    ...(slot.worktree_path ? { worktree_path: slot.worktree_path } : {}),
  };
}

function hardCap(taskId: string, grantedWorkers: number): WorkerRejection {
  return { task_id: taskId, reason: "hard-cap", detail: `worker limitas ${grantedWorkers} jau užpildytas` };
}

/**
 * Ką duoti atsilaisvinusiam slot'ui.
 *
 * Sprendimo tvarka fiksuota ir kiekvienas žingsnis turi VARDĄ, tad „kodėl papildymo
 * nebuvo" yra duomenys, o ne spėjimas iš logo:
 *
 *   1. laikymas (`drain`/`abort` ant šio slot'o arba viso loop'o stop) — kiti nepaliesti;
 *   2. talpa: gyvieji + šis vienas negali viršyti `granted_workers`;
 *   3. kandidatų nebuvimas;
 *   4. GYVŲ slot'ų savi įrodymai — SUGADINTA gyvo slot'o izoliacija reiškia, kad prie jo
 *      nieko prigretinti negalima, tad atmetimas kabinamas prie TO slot'o task'o.
 *      NENURODYTI lease/worktree taip pat blokuoja, NEBENT iškvietėjas pasakė
 *      `primary_claim_supported: false` — tada tai pirminio slot'o dizainas, ne gedimas;
 *   5. kandidatai deterministine tvarka pro `admitWorkerCandidate`; pirmas priimtas laimi,
 *      likę gauna `hard-cap` (vietos nebėra — tai kita istorija nei „netiko"). Kandidato
 *      PATIES griežtumas nekinta: išimtis galioja tik `occupants` nariams.
 */
export function planSlotRefill(input: SlotRefillInput): SlotRefillDecision {
  const ordered = orderWorkerCandidates(input.candidates);
  const live = [...input.live];
  const liveTaskIds = [...new Set(live.map((slot) => slot.task_id))].sort();
  const rejected: WorkerRejection[] = [];
  const verdicts: IndependenceVerdict[] = [];
  let slot: WorkerSlot | undefined;

  // Priežasčiai, kuri neturi savo kandidato (laikymas, talpa, tuščias ready set), reikia
  // adresato: jei kandidatų nėra, juo tampa pats slot'as — įrašas be `task_id` būtų
  // nevalidus ir nesekamas.
  const firstCandidateId = ordered.at(0)?.task_id ?? input.freed_slot.worker_id;
  // Veidrodis `worker-pool-plan.ts#planWorkerPool`: numatytoji `true` palieka seną griežtą
  // elgesį, o realią reikšmę paduoda TAS PATS politikos savininkas.
  const primaryClaimSupported = input.primary_claim_supported ?? true;

  const decide = (): void => {
    if (input.hold.kind !== "none") {
      rejected.push({ task_id: input.freed_slot.worker_id, reason: input.hold.kind, detail: input.hold.detail });
      return;
    }
    if (live.length + 1 > input.granted_workers) {
      rejected.push(hardCap(firstCandidateId, input.granted_workers));
      return;
    }
    if (ordered.length === 0) {
      rejected.push({
        task_id: input.freed_slot.worker_id,
        reason: "no-candidate",
        detail: "ready set'e nebeliko nė vieno vertintino kandidato",
      });
      return;
    }

    // Kol pirminio slot'o claim'as nepasiekia rašymo autoriteto patikros, jis lease ir
    // darbo kopijos neturi PAGAL DIZAINĄ. Be išimties toks užimtasis kiekvieną papildymą
    // užrakindavo occupant-attributed `missing-lease` dar PRIEŠ pirmą kandidato vertinimą.
    // Sušvelninama TIK „lease/worktree nenurodyti": `checkSlotEligibility` sugadintą lease
    // tebelaiko blokuojančiu, ir tokio užimtojo atmetimas toliau kabinamas prie JO.
    for (const occupant of live) {
      const occupied = checkSlotEligibility(occupantOf(occupant), input.now, {
        allowPrimaryTreeState: !primaryClaimSupported,
      });
      if (occupied) {
        rejected.push(occupied);
        return;
      }
    }

    const occupants = live.map(occupantOf);
    for (let index = 0; index < ordered.length; index += 1) {
      const candidate = ordered[index] as WorkerCandidate;
      const admission = admitWorkerCandidate({
        candidate,
        occupants,
        now: input.now,
        // Ta pati reikšmė kaip cikle aukščiau — kitaip `admitWorkerCandidate` užimtąjį
        // atmestų antrą kartą, jau praėjus jo patikrą. Kandidatui ji netaikoma niekada.
        allowOccupantPrimaryTreeState: !primaryClaimSupported,
      });
      verdicts.push(...admission.verdicts);
      if (!admission.admitted) {
        if (admission.rejection) rejected.push(admission.rejection);
        continue;
      }
      slot = buildWorkerSlot(input.run_id, input.freed_slot.worker_index, candidate);
      for (const skipped of ordered.slice(index + 1)) rejected.push(hardCap(skipped.task_id, input.granted_workers));
      return;
    }
  };

  decide();

  // Į atspaudą NEĮEINA laikrodis ir `detail` tekstai: epizodas privalo turėti tą pačią
  // tapatybę perskaičiuotas po restart'o, o būtent tie dalykai tarp paleidimų skiriasi.
  const episodeHash = computeSchedulingHash(`sr${SLOT_REFILL_VERSION}`, {
    version: SLOT_REFILL_VERSION,
    run: input.run_id,
    episode: input.episode,
    freed_slot: { worker: input.freed_slot.worker_id, index: input.freed_slot.worker_index },
    live: live.map((entry) => ({ worker: entry.worker_id, task: entry.task_id, attempt: entry.attempt })),
    candidates: ordered.map((entry) => ({
      task: entry.task_id,
      attempt: entry.attempt ?? 1,
      write_set_hash: entry.write_set.write_set_hash,
    })),
    granted: slot ? { worker: slot.worker_id, task: slot.task_id, attempt: slot.attempt } : null,
    rejected: rejected.map((entry) => ({ task: entry.task_id, reason: entry.reason })),
  });

  return {
    refill_version: SLOT_REFILL_VERSION,
    run_id: input.run_id,
    episode: input.episode,
    worker_id: input.freed_slot.worker_id,
    worker_index: input.freed_slot.worker_index,
    granted_workers: input.granted_workers,
    ...(slot ? { slot } : {}),
    rejected,
    verdicts,
    conflicts: verdicts.flatMap((verdict) => verdict.conflicts),
    live_task_ids: liveTaskIds,
    episode_hash: episodeHash,
    reason: formatRefillReason(slot, rejected, liveTaskIds, episodeHash),
  };
}

/**
 * Epizodo eilutė: ta pati log'e, wave event'e ir snapshot'e.
 *
 * Neduoto papildymo atveju pirmoji priežastis rodoma inline (`reason=`), o `rejected=`
 * neša tik LIKUSIAS — kitaip ta pati priežastis eilutėje kartotųsi dukart.
 */
function formatRefillReason(
  slot: WorkerSlot | undefined,
  rejected: readonly WorkerRejection[],
  liveTaskIds: readonly string[],
  episodeHash: string,
): string {
  const live = ` live=${liveTaskIds.length > 0 ? liveTaskIds.join(",") : "none"}`;
  const render = (entries: readonly WorkerRejection[]): string =>
    entries.map((entry) => `${entry.task_id}: ${entry.reason} — ${entry.detail}`).join(" | ");

  if (slot) {
    const worktree = slot.worktree_path ? ` worktree=${slot.worktree_path}` : "";
    const rest = rejected.length > 0 ? ` rejected=${render(rejected)}` : "";
    return `granted=${slot.task_id} attempt=${slot.attempt}${worktree}${live}${rest} hash=${episodeHash}`;
  }

  const first = rejected.at(0);
  const cause = first ? ` reason=${first.reason} — ${first.detail}` : " reason=no-candidate";
  const rest = rejected.length > 1 ? ` rejected=${render(rejected.slice(1))}` : "";
  return `granted=none${cause}${live}${rest} hash=${episodeHash}`;
}
