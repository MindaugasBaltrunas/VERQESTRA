// Integracijos momentas ir planas: KADA baigusių slot'ų šakas galima sulieti ir KĄ tuo
// metu daryti. Behaviour etalon: AG_loop application/scheduling/slot-refill.ts integracijos
// pusė (skaidymas slot-refill + worker-integration pagal 500 eil. gate; vardai 1:1).
//
// Fail-closed kryptis viena: nė vienas neaiškus atvejis nevirsta tyliu praleidimu.
// Nesėkmingas slot'as ir slot'as be nuosavybės įrodymo NEINTEGRUOJAMI, bet ir nedingsta —
// jie parkuojami su vardu, kad task'as atsidurtų human-review, o ne grįžtų į re-dispatch
// ratą. PATĮ merge, failo perkėlimą, valymą ir lease atlaisvinimą atlieka kompozicijos
// sluoksnis (E5) — `application -> infrastructure` yra uždrausta kryptis.
//
// INKREMENTINĖ INTEGRACIJA: rolling refill atsilaisvinusį slot'ą užpildo iškart, tad tyla
// nusikelia iki bangos išsikvėpimo, o baigtos šakos su žaliais gates valandomis gulėtų
// nesulietos. Todėl tylos SĄLYGA praplečiama, o ne pakeičiama: baigęs sėkmingas worktree
// slot'as suliejamas nedelsiant, jei įrodyta, kad jo write set'as nesikerta su NĖ VIENO
// gyvo slot'o write set'u. Sankirtos matas — tas pats, kurį naudoja leidimo vartas
// (`findWriteSetConflict`), tad merge negali pajudinti bazės po gyvo slot'o kojomis.

import type { WorkerLease } from "../../domain/scheduling/index.js";
import type { TaskWriteSet } from "./conflict-detector.js";
import { findWriteSetConflict } from "./worker-pool-admission.js";
import { resolveWorkerOutcomes, type WorkerOutcome, type WorkerPoolPlan } from "./worker-pool-plan.js";
import { occupantOf, type LiveSlot } from "./slot-refill.js";

export type IntegrationCheckpoint = {
  /** `true` kai nebedirba NĖ VIENAS slot'as. */
  tree_quiescent: boolean;
  live_task_ids: string[];
  release_lease_ids: string[];
  reason: string;
};

/**
 * Integracijos momento verdiktas.
 *
 * Užimtumo autoritetas — GYVI slot'ai. Bangos planas jais būti nebegali: papildytas
 * slot'as jokiam planui nepriklauso, tad `resolveWorkerOutcomes` vienas pasakytų „visi
 * terminaliniai" tuo metu, kai papildytas task'as dar dirba. Plano dalis (kuriuos lease'us
 * galima atlaisvinti) toliau imama iš `resolveWorkerOutcomes` — antros to skaičiavimo
 * kopijos čia nėra.
 */
export function evaluateIntegrationCheckpoint(input: {
  live: readonly LiveSlot[];
  plan?: WorkerPoolPlan;
  outcomes?: readonly WorkerOutcome[];
}): IntegrationCheckpoint {
  const liveTaskIds = [...new Set(input.live.map((slot) => slot.task_id))].sort();
  const resolution = input.plan ? resolveWorkerOutcomes(input.plan, input.outcomes ?? []) : undefined;
  const quiescent = liveTaskIds.length === 0;

  return {
    tree_quiescent: quiescent,
    live_task_ids: liveTaskIds,
    release_lease_ids: resolution?.release_lease_ids ?? [],
    reason: quiescent
      ? `nė vienas slot'as nedirba${resolution ? `; ${resolution.reason}` : ""}`
      : `${liveTaskIds.length} slot'as(-ai) dar dirba: ${liveTaskIds.join(", ")}`,
  };
}

/** Slot'as, kuris BAIGĖ savo attempt'ą. Momentinė `LiveSlot` kopija plius terminalinė baigtis. */
export type FinishedWorkerSlot = {
  worker_id: string;
  worker_index: number;
  task_id: string;
  file: string;
  attempt: number;
  /** `true` = quality gates praėjo (child exit 0). */
  succeeded: boolean;
  /** Izoliuota darbo kopija. Pirminis slot'as jos neturi — jo darbas jau yra pirminiame medyje. */
  worktree_path?: string;
  /** Nuosavybės įrodymas. Be jo kopijos ir šakos liesti negalima. */
  lease?: WorkerLease;
  /**
   * Task'o write set'as — VIENINTELIS inkrementinės integracijos įrodymas, kad ši šaka
   * nejudina bazės, ant kurios dirba gyvas gretimas slot'as. Nebūtinas sąmoningai: be jo
   * sankirtos įrodyti nėra iš ko, tad slot'as fail-closed laukia tylos.
   */
  write_set?: TaskWriteSet;
  /**
   * Infrastruktūros baigties exit kodas (pvz. USAGE_LIMIT_EXIT_CODE=75), KAI `!succeeded`
   * NĖRA task'o kaltė (žr. `SlotChildOutcome` slot-task-runner.ts, 148-a-02/148-aa-02).
   * `undefined` = įprasta task-failed/succeeded baigtis. 148-b-03: laukas paruoštas priimti
   * reikšmę čia, grynoje sprendimo funkcijoje, bet REALUS signalas iki `wave-outcome.ts`
   * dar nepasiekia — `recordOutcome` gauna tik `boolean` per `wave-dispatch.ts` →
   * `loop-cycle.ts` → `command.ts` vamzdį, o jį praplėsti be tų failų (`loop-cycle.ts`
   * uždraustas šiam task'ui) yra atskiro sekančio task'o darbas.
   */
  infrastructure_exit_code?: number;
};

/** Slot'as, kurio sesijos šaka integruojama į pirminę šaką. */
export type WorkerIntegrationStep = {
  worker_id: string;
  worker_index: number;
  task_id: string;
  file: string;
  attempt: number;
  worktree_path: string;
  lease: WorkerLease;
};

/** Slot'as, kurio darbas paliekamas žmogui: šaka ir kopija NEVALOMOS. */
export type WorkerIntegrationPark = {
  task_id: string;
  /**
   * Darbo kopija, kurioje guli neintegruotas darbas. Žmogui tai VIENINTELIS kelias jį
   * rasti, todėl parkavimo įrašas be jos būtų nurodymas ieškoti be adreso.
   */
  worktree_path: string;
  reason:
    /** Child'as baigė nesėkme — sesijos šakoje gali gulėti dalinis darbas. */
    | "task-failed"
    /** Nėra lease: nuosavybės įrodyti neįmanoma, tad nei kopija, nei šaka neliečiamos. */
    | "missing-lease";
  detail: string;
};

/** Slot'as, kuriam integracija netaikoma iš principo. */
export type WorkerIntegrationSkip = {
  task_id: string;
  reason:
    /** Dar dirba kitas slot'as — integracija laukia tylos. */
    | "not-quiescent"
    /** Slot'as dirbo pačiame pirminiame medyje: nėra atskiros šakos, kurią reiktų sulieti. */
    | "primary-tree-slot"
    /**
     * Infrastruktūros gedimas (usage limit, timeout ir pan.) — NIEKADA nėra `task-failed`
     * parkas. Task failas lieka `AG/tasks/queue`, kopija ir šaka NEVALOMOS (kaip ir parko
     * atveju), bet task'as neatiduodamas žmogui: kaltė yra infrastruktūros, ne task'o.
     */
    | "infrastructure";
  detail: string;
};

/**
 * Iš KOKIOS sąlygos gimė plano žingsniai. Iškvietėjui tai ne dekoracija: tylos kelias
 * tvarko ir parkavimą, ir bangos lease'us, o inkrementinis — tik savo vieną šaką.
 *
 *   - `quiescent`   — tyla: pilnas kelias (integracija + parkavimas + bangos lease'ai);
 *   - `incremental` — gyvas gretimas slot'as YRA, bet įrodyta, kad jo write set'as su
 *                     integruojamu nesikerta;
 *   - `waiting`     — laukiama tylos; `integrate`, `park` ir `release_lease_ids` tušti.
 */
export type WorkerIntegrationMode = "quiescent" | "incremental" | "waiting";

export type WorkerIntegrationPlan = {
  /** `true` kai TURI ką daryti dabar: tyla arba įrodyta inkrementinė integracija. */
  ready: boolean;
  mode: WorkerIntegrationMode;
  integrate: WorkerIntegrationStep[];
  park: WorkerIntegrationPark[];
  skipped: WorkerIntegrationSkip[];
  /** Iš `IntegrationCheckpoint` — atlaisvinama TIK esant tylai. */
  release_lease_ids: string[];
  /** Viena eilutė log'ui ir wave event'ui. Formatavimo taisyklė gyvena čia. */
  reason: string;
};

/** `WorkerIntegrationStep` iš baigusio slot'o. Kviečiama tik įrodžius visas sąlygas. */
function integrationStepOf(slot: FinishedWorkerSlot, worktreePath: string, lease: WorkerLease): WorkerIntegrationStep {
  return {
    worker_id: slot.worker_id,
    worker_index: slot.worker_index,
    task_id: slot.task_id,
    file: slot.file,
    attempt: slot.attempt,
    worktree_path: worktreePath,
    lease,
  };
}

/**
 * Ar baigusio slot'o šaką galima sulieti NELAUKIANT tylos, ir jei ne — kodėl.
 *
 * Vardas kiekvienai kliūčiai, ir kiekviena fail-closed:
 *
 *   1. `worktree_path` nebuvimas — pirminio medžio slot'as; sprendimas priimamas tyloje;
 *   2. nesėkmė — parkavimas irgi lieka tylos sprendimas;
 *   3. lease nebuvimas — nuosavybė neįrodyta, tad šakos liesti negalima jokiu momentu;
 *   4. write set'o nebuvimas — sankirtos įrodyti nėra iš ko, o įrodymo nebuvimas niekada
 *      nevirsta leidimu (conflict-detector taisyklė 1);
 *   5. gyvų slot'ų projekcijos nebuvimas — ta pati taisyklė iš iškvietėjo pusės;
 *   6. GYVAS pirminio medžio slot'as — merge perrašytų jo neužcommit'intą darbą;
 *   7. write set sankirta su bet kuriuo gyvu slot'u — matuojama TA PAČIA funkcija, kurią
 *      naudoja leidimo vartas (`findWriteSetConflict`), tad antros sankirtos semantikos
 *      sistemoje neatsiranda.
 */
function planIncrementalStep(
  slot: FinishedWorkerSlot,
  live: readonly LiveSlot[],
): { step: WorkerIntegrationStep } | { blocked: string } {
  if (!slot.worktree_path) return { blocked: `slot=${slot.worker_id} dirbo pirminiame medyje — sesijos šakos nėra` };
  if (!slot.succeeded) return { blocked: `slot=${slot.worker_id} baigė nesėkme — parkavimas sprendžiamas tyloje` };
  if (!slot.lease) return { blocked: `slot=${slot.worker_id} neturi lease — nuosavybė neįrodyta` };
  if (!slot.write_set) return { blocked: `task=${slot.task_id} neturi write set'o — sankirtos įrodyti nėra iš ko` };
  if (live.length === 0) return { blocked: "gyvų slot'ų projekcija nepaduota — sankirtos įrodyti nėra su kuo" };

  const primaryTree = live.find((occupant) => !occupant.worktree_path);
  if (primaryTree) {
    return {
      blocked:
        `gyvas slot=${primaryTree.worker_id} (task ${primaryTree.task_id}) dirba PIRMINIAME medyje — ` +
        "merge perrašytų jo neužcommit'intą darbą",
    };
  }

  const conflict = findWriteSetConflict(
    { task_id: slot.task_id, file: slot.file, attempt: slot.attempt, write_set: slot.write_set },
    live.map(occupantOf),
  );
  if (conflict) return { blocked: conflict.rejection.detail };
  return { step: integrationStepOf(slot, slot.worktree_path, slot.lease) };
}

/** Praleidimų ir parkavimų santrauka vienai log eilutei. */
function renderIntegrationEntries(entries: readonly { task_id: string; reason: string }[]): string {
  return entries.map((entry) => `${entry.task_id}:${entry.reason}`).join(",");
}

/**
 * Ką daryti su baigusiais slot'ais integracijos momentu.
 *
 * Sprendimo tvarka fiksuota ir kiekvienas žingsnis turi VARDĄ:
 *
 *   1. tyla (`tree_quiescent`) — su ja galioja PILNAS kelias (2–5 žemiau). Be jos leidžiama
 *      tik inkrementinė integracija: įrodyta nesikertančio write set'o šaka suliejama
 *      iškart, o visa kita (parkavimas, bangos lease'ai, pirminio medžio slot'ai) toliau
 *      laukia tylos. Neįrodytas atvejis lieka `not-quiescent`;
 *   2. slot'as be `worktree_path` praleidžiamas — pirminio medžio darbas jau yra ten, kur reikia;
 *   3. infrastruktūros gedimas (148-b-03) NIEKADA netampa parku — task'as lieka eilėje su
 *      priežastimi `infrastructure`, kopija paliekama; kaltė yra infrastruktūros, ne task'o;
 *   4. nesėkmingas (task'o kaltės) slot'as parkuojamas — jo šaka lieka nepaliesta kaip
 *      vienintelis dalinio darbo egzempliorius, o task'as keliauja žmogui, ne atgal į eilę;
 *   5. slot'as be lease parkuojamas — kopiją ir šaką gali tvarkyti tik įrodytas savininkas;
 *   6. likusieji integruojami deterministine (`worker_index`, tada `task_id`) tvarka.
 */
export function planWorkerIntegration(input: {
  checkpoint: IntegrationCheckpoint;
  finished: readonly FinishedWorkerSlot[];
  /**
   * Gyvi slot'ai — inkrementinio kelio sankirtos šaltinis. NEPADUOTAS reiškia „nežinome,
   * kas dirba", tad inkrementinio kelio nėra: tokie iškvietėjai laukia tylos.
   */
  live?: readonly LiveSlot[];
}): WorkerIntegrationPlan {
  const finished = [...input.finished].sort(
    (left, right) => left.worker_index - right.worker_index || left.task_id.localeCompare(right.task_id),
  );

  if (!input.checkpoint.tree_quiescent) {
    const live = input.live ?? [];
    const incremental: WorkerIntegrationStep[] = [];
    const incrementalPark: WorkerIntegrationPark[] = [];
    const incrementalInfra: WorkerIntegrationSkip[] = [];
    const waiting: WorkerIntegrationSkip[] = [];
    for (const slot of finished) {
      // Task 135: nesėkmingas worktree slot'as parkuojamas IŠKART, nelaukiant tylos.
      // Iki tol parkavimas buvo tylos sprendimas, o užimtame cikle tyla neateina niekada —
      // verdiktas likdavo išmetamoje kopijoje, queue failas būdavo re-dispatch'inamas ratu
      // (2026-09-01: 9 task'ai per valandą). Parkavimas yra TIK bucket failo perkėlimas
      // pagrindiniame medyje be jokių git operacijų (jos lieka tylos keliui), tad jo
      // vykdymas šalia gyvų slot'ų merge saugumo nekeičia; kopija ir šaka paliekamos
      // peržiūrai kaip ir tylos kelyje.
      if (slot.worktree_path && !slot.succeeded) {
        // 148-b-03: infrastruktūros gedimas NIEKADA netampa task-failed parku — 2026-09-01
        // 21:17–21:31 dvidešimt task'ų atsidūrė human-review vien dėl Claude usage limito.
        // Sprendimas kabinamas prie TO PATIES varto kaip task-failed, nes abu dalinasi
        // `!succeeded` sąlygą — tvarka svarbi: infra patikrinama PIRMA.
        if (slot.infrastructure_exit_code !== undefined) {
          incrementalInfra.push({
            task_id: slot.task_id,
            reason: "infrastructure",
            detail: `slot=${slot.worker_id} baigė infrastruktūros klaida exit=${slot.infrastructure_exit_code} — task'as lieka eilėje, kopija ${slot.worktree_path} paliekama, NE task-failed parkas`,
          });
          continue;
        }
        incrementalPark.push({
          task_id: slot.task_id,
          worktree_path: slot.worktree_path,
          reason: "task-failed",
          detail: `slot=${slot.worker_id} baigė nesėkme — kopija ${slot.worktree_path} ir jos šaka paliekamos peržiūrai`,
        });
        continue;
      }
      const verdict = planIncrementalStep(slot, live);
      if ("step" in verdict) incremental.push(verdict.step);
      else waiting.push({ task_id: slot.task_id, reason: "not-quiescent", detail: `${input.checkpoint.reason}; ${verdict.blocked}` });
    }

    const ready = incremental.length > 0 || incrementalPark.length > 0 || incrementalInfra.length > 0;
    return {
      ready,
      mode: ready ? "incremental" : "waiting",
      integrate: incremental,
      // Bangos lease'ai ir pirminio medžio slot'ų likimas lieka tylos sprendimai:
      // inkrementinis kelias praplečia integracijos momentą, nesėkmės parkavimą ir infra
      // praleidimą, bet lease atlaisvinimo semantikos neliečia.
      park: incrementalPark,
      skipped: [...incrementalInfra, ...waiting],
      release_lease_ids: [],
      reason: ready
        ? `ready=true mode=incremental integrate=${incremental.map((step) => step.task_id).join(",") || "none"}` +
          `${incrementalPark.length > 0 ? ` park=${renderIntegrationEntries(incrementalPark)}` : ""}` +
          `${incrementalInfra.length > 0 ? ` infra=${renderIntegrationEntries(incrementalInfra)}` : ""}` +
          ` live=${input.checkpoint.live_task_ids.join(",")}` +
          `${waiting.length > 0 ? ` waiting=${renderIntegrationEntries(waiting)}` : ""}`
        : `ready=false ${input.checkpoint.reason}`,
    };
  }

  const integrate: WorkerIntegrationStep[] = [];
  const park: WorkerIntegrationPark[] = [];
  const skipped: WorkerIntegrationSkip[] = [];

  for (const slot of finished) {
    if (!slot.worktree_path) {
      skipped.push({
        task_id: slot.task_id,
        reason: "primary-tree-slot",
        detail: `slot=${slot.worker_id} dirbo pirminiame medyje — sesijos šakos nėra`,
      });
      continue;
    }
    if (!slot.succeeded) {
      // 148-b-03: infrastruktūros gedimas NIEKADA netampa task-failed parku — žr. tą pačią
      // sąlygą inkrementiniame kelyje aukščiau, dėl kurios ir vardo šis vartas atsirado.
      if (slot.infrastructure_exit_code !== undefined) {
        skipped.push({
          task_id: slot.task_id,
          reason: "infrastructure",
          detail: `slot=${slot.worker_id} baigė infrastruktūros klaida exit=${slot.infrastructure_exit_code} — task'as lieka eilėje, kopija ${slot.worktree_path} paliekama, NE task-failed parkas`,
        });
        continue;
      }
      park.push({
        task_id: slot.task_id,
        worktree_path: slot.worktree_path,
        reason: "task-failed",
        detail: `slot=${slot.worker_id} baigė nesėkme — kopija ${slot.worktree_path} ir jos šaka paliekamos peržiūrai`,
      });
      continue;
    }
    if (!slot.lease) {
      park.push({
        task_id: slot.task_id,
        worktree_path: slot.worktree_path,
        reason: "missing-lease",
        detail: `slot=${slot.worker_id} neturi lease — nuosavybė neįrodyta, kopija ${slot.worktree_path} neliečiama`,
      });
      continue;
    }
    integrate.push(integrationStepOf(slot, slot.worktree_path, slot.lease));
  }

  return {
    ready: true,
    mode: "quiescent",
    integrate,
    park,
    skipped,
    release_lease_ids: [...input.checkpoint.release_lease_ids],
    reason:
      `ready=true integrate=${integrate.length > 0 ? integrate.map((step) => step.task_id).join(",") : "none"}` +
      `${park.length > 0 ? ` park=${renderIntegrationEntries(park)}` : ""}` +
      `${skipped.length > 0 ? ` skipped=${renderIntegrationEntries(skipped)}` : ""}` +
      ` leases=${input.checkpoint.release_lease_ids.length}`,
  };
}
