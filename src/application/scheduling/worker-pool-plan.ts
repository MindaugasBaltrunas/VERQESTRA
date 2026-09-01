// Worker pool policy: kada bangoje dirba VIENAS workeris, o kada du (spec PAR-1/PAR-2/
// WRK-3, design §13 „Maximum two workers"). Behaviour etalon: AG_loop application/
// scheduling/worker-pool.ts planavimo pusė (skaidymas admission + plan pagal 500 eil.
// gate; vardai ir taisyklės 1:1).
//
// Kietos taisyklės: (1) hard cap yra 2 ir nekonfigūruojamas — reikšmė iš worker-limits,
// to paties limito, kuris riboja runtime namespace worker id'us; (2) numatytoji reikšmė
// yra 1 — antras workeris yra IŠIMTIS, kurią reikia įrodyti; (3) kiekvienas atmetimas
// turi vardą. Vieno workerio LŪŽIS neliečia kito: slot'ai paleidžiami tik įrodžius, kad
// write set'ai nesikerta. Modulis grynas.

import type { IndependenceVerdict, WriteSetConflict } from "./conflict-detector.js";
import { RUNTIME_MAX_WORKERS } from "./worker-limits.js";
import {
  admitWorkerCandidate,
  buildWorkerSlot,
  checkSlotEligibility,
  computeSchedulingHash,
  orderWorkerCandidates,
  WORKER_POOL_VERSION,
  type WorkerCandidate,
  type WorkerRejection,
  type WorkerSlot,
} from "./worker-pool-admission.js";

/**
 * Hard limitas (spec WRK-3). Bendras su runtime namespace, kad „kiek workerių leidžiama"
 * turėtų vieną apibrėžimą visoje sistemoje.
 */
export const MAX_WORKERS = RUNTIME_MAX_WORKERS;

/** Numatytasis workerių skaičius. Paralelizmas įjungiamas tik aiškiu prašymu IR įrodymu. */
export const DEFAULT_WORKERS = 1;

/**
 * Prašomas skaičius, apkirptas iki `[1, MAX_WORKERS]`. Neteisinga arba nenurodyta reikšmė
 * krenta į numatytąjį 1 — reikalavimas „daugiau" niekada nepraeina pro šią funkciją.
 */
export function clampWorkerCount(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) return DEFAULT_WORKERS;
  return Math.min(MAX_WORKERS, Math.max(1, Math.trunc(requested)));
}

export type WorkerPoolPlan = {
  pool_version: number;
  run_id: string;
  /** VISADA `MAX_WORKERS`. Laukas yra įrodymas, kad limitas neišplaukė, o ne konfigas. */
  max_workers: number;
  requested_workers: number;
  mode: "sequential" | "parallel";
  slots: WorkerSlot[];
  rejected: WorkerRejection[];
  /** Įvertinti nepriklausomumo verdiktai — po vieną kiekvienam kaip antram slot'ui tikrintam kandidatui. */
  verdicts: IndependenceVerdict[];
  /** Visos rastos sankirtos (suplokštintos iš `verdicts`) — diagnostikai. */
  conflicts: WriteSetConflict[];
  /** Plano atspaudas: tie patys kandidatai → tas pats planas. */
  plan_hash: string;
};

export type PlanWorkerPoolInput = {
  run_id: string;
  candidates: readonly WorkerCandidate[];
  /** Kiek workerių prašoma. Bet kokia reikšmė apkerpama iki `[1, 2]`. */
  requested_workers?: number;
  /**
   * Ar pirminio slot'o lease claim'as pasiekia rašymo autoriteto patikrą. Numatytoji
   * `true` — istorinis elgesys nekinta iškvietėjams, kurie lauko nepaduoda. Paduota
   * `false` reiškia, kad pirminio kandidato trūkstamas `lease`/`worktree_path` NĖRA
   * parallel šakos blokuojanti klaida: jis dirba pirminiame medyje pagal dizainą, tad
   * vertinimas tęsiasi į likusius kandidatus. Kitos pirminio kandidato eligibility
   * klaidos tebeblokuoja nepaisant šios reikšmės.
   */
  primary_claim_supported?: boolean;
  /** „Dabar" lease galiojimo patikrai. Paduodamas iškvietėjo, kad modulis liktų grynas. */
  now: Date;
};

function computePlanHash(plan: Omit<WorkerPoolPlan, "plan_hash">): string {
  const payload = {
    version: plan.pool_version,
    run: plan.run_id,
    max: plan.max_workers,
    requested: plan.requested_workers,
    mode: plan.mode,
    slots: plan.slots.map((slot) => ({ index: slot.worker_index, task: slot.task_id, attempt: slot.attempt })),
    rejected: plan.rejected.map((entry) => ({ task: entry.task_id, reason: entry.reason })),
  };
  return computeSchedulingHash(`wp${WORKER_POOL_VERSION}`, payload);
}

/**
 * Sudaro workerių planą iš bangos kandidatų.
 *
 * Antras slot'as užimamas tik tada, kai VISOS sąlygos patenkintos vienu metu: prašomi du
 * workeriai, abu kandidatai turi apibrėžtą write set'ą, galiojantį savo task'o lease,
 * atskiras darbo kopijas, o detektorius grąžina `independent`. Nepavykus bet kuriai —
 * planas lieka nuoseklus, o priežastis įrašoma. Kandidatai tikrinami eilės tvarka ir
 * pirmas tinkamas laimi, todėl rezultatas deterministinis.
 */
export function planWorkerPool(input: PlanWorkerPoolInput): WorkerPoolPlan {
  const requested = clampWorkerCount(input.requested_workers);
  const ordered = orderWorkerCandidates(input.candidates);
  const slots: WorkerSlot[] = [];
  const rejected: WorkerRejection[] = [];
  const verdicts: IndependenceVerdict[] = [];

  const finish = (mode: "sequential" | "parallel"): WorkerPoolPlan => {
    const plan: Omit<WorkerPoolPlan, "plan_hash"> = {
      pool_version: WORKER_POOL_VERSION,
      run_id: input.run_id,
      max_workers: MAX_WORKERS,
      requested_workers: requested,
      mode,
      slots,
      rejected,
      verdicts,
      conflicts: verdicts.flatMap((verdict) => verdict.conflicts),
    };
    return { ...plan, plan_hash: computePlanHash(plan) };
  };

  const primary = ordered[0];
  if (!primary) return finish("sequential");
  slots.push(buildWorkerSlot(input.run_id, PRIMARY_WORKER_INDEX, primary));

  const rest = ordered.slice(1);
  if (rest.length === 0) {
    // Atmetimo taisyklė galioja ir čia: antras slot'as liko neišduotas, tad priežastis
    // privalo turėti vardą. Tuščias `rejected` reikštų „visi kandidatai tiko", nors
    // tikroji istorija — kandidato antram slot'ui paprasčiausiai nebuvo.
    rejected.push({
      task_id: primary.task_id,
      reason: "single-candidate",
      detail: `bangoje yra 1 kandidatas iš ${MAX_WORKERS} leidžiamų slot'ų — antram slot'ui nėra ką priskirti`,
    });
    return finish("sequential");
  }
  if (requested < 2) {
    rejected.push({
      task_id: (rest[0] as WorkerCandidate).task_id,
      reason: "sequential-requested",
      detail: `prašyta ${requested} worker'io(-ių) iš ${MAX_WORKERS} leidžiamų`,
    });
    return finish("sequential");
  }

  // Pirminis kandidatas privalo pats atitikti paralelizmo sąlygas: jei JO scope
  // neapibrėžtas arba izoliacija sugadinta (o ne tiesiog nenurodyta primary-tree režime),
  // antro workerio klausimas net nekyla.
  const primaryClaimSupported = input.primary_claim_supported ?? true;
  const primaryEligibility = checkSlotEligibility(primary, input.now, {
    allowPrimaryTreeState: !primaryClaimSupported,
  });
  if (primaryEligibility) {
    rejected.push(primaryEligibility);
    return finish("sequential");
  }

  for (let index = 0; index < rest.length; index += 1) {
    const candidate = rest[index] as WorkerCandidate;
    // Vienintelis leidimo vartas. Pirminis slot'as jau praėjo savo patikrą aukščiau, tad
    // `occupants: [primary]` duoda tą pačią seką, kokia būtų išrašyta inline.
    const admission = admitWorkerCandidate({
      candidate,
      occupants: [primary],
      now: input.now,
      allowOccupantPrimaryTreeState: !primaryClaimSupported,
    });
    verdicts.push(...admission.verdicts);
    if (!admission.admitted) {
      if (admission.rejection) rejected.push(admission.rejection);
      continue;
    }

    slots.push(buildWorkerSlot(input.run_id, 2, candidate));
    // Likę kandidatai net nevertinami: limitas užpildytas, ir tylus jų praleidimas
    // atrodytų kaip „netiko", o ne kaip „vietos nebėra".
    for (const skipped of rest.slice(index + 1)) {
      rejected.push({
        task_id: skipped.task_id,
        reason: "hard-cap",
        detail: `worker limitas ${MAX_WORKERS} jau užpildytas`,
      });
    }
    return finish("parallel");
  }

  return finish("sequential");
}

// ---------------------------------------------------------------------------
// Slot'o provisioning planas
// ---------------------------------------------------------------------------

/**
 * Pirminio slot'o indeksas. Jis nėra „svarbesnis" už kitus — jis tik VIENINTELIS, kuris
 * nuosekliame režime dirba pirminiame darbo medyje, tad būtent jam lease reiškia ir rašymo
 * autoritetą tame pačiame medyje, kuriame dirba pats loop'as.
 */
export const PRIMARY_WORKER_INDEX = 1;

export type SlotProvisionRefusalReason =
  /** Visi `MAX_WORKERS` indeksai jau išduoti — provizinti nėra kam. */
  "hard-cap";

/** Vienas provisioning'o adresatas: KAM (task) ir KURIO slot'o tapatybe (worker index). */
export type SlotProvisionTarget = {
  task_id: string;
  worker_index: number;
};

export type SlotProvisionRefusal = {
  task_id: string;
  worker_index?: number;
  reason: SlotProvisionRefusalReason;
  detail: string;
};

export type SlotProvisionPlan = {
  targets: SlotProvisionTarget[];
  refused: SlotProvisionRefusal[];
};

/**
 * Kuriems slot'ams reikia išduoti lease + darbo kopiją, kad planas galėtų būti
 * perplanuotas.
 *
 * Taisyklė VIENA ir ji nežiūri, kelintas slot'as prašo: kiekvienas `missing-lease`
 * atmetimas yra provisioning'o adresatas, o jo tapatybė yra slot'o indeksas — jau turimas
 * (pirminis prašo SAVO indeksui) arba žemiausias laisvas.
 *
 * Gryna: jokio FS, laikrodžio ar politikos skaitymo — tai daro iškvietėjas, gavęs adresatus.
 */
export function planSlotProvisioning(input: { plan: WorkerPoolPlan }): SlotProvisionPlan {
  const targets: SlotProvisionTarget[] = [];
  const refused: SlotProvisionRefusal[] = [];

  // Nuosekliame režime provisioning'o klausimo nėra: vienas slot'as dirba pirminiame
  // medyje be lease, ir būtent tai yra numatytoji elgsena, kurios ši taisyklė nekeičia.
  if (input.plan.requested_workers < 2) return { targets, refused };

  const grantedIndexByTask = new Map(input.plan.slots.map((slot) => [slot.task_id, slot.worker_index]));
  const seen = new Set<string>();
  // Fiksuojama PRIEŠ ciklą: skiria „visi indeksai jau granted" nuo „laisvas indeksas
  // buvo šio raundo pradžioje, bet jį paėmė ankstesnis šio paties ciklo kandidatas" —
  // žr. atmetimo detail žemiau.
  const initialFreeIndex = input.plan.slots.length + 1;
  let nextFreeIndex = initialFreeIndex;

  for (const rejection of input.plan.rejected) {
    if (rejection.reason !== "missing-lease") continue;
    if (seen.has(rejection.task_id)) continue;
    seen.add(rejection.task_id);

    const granted = grantedIndexByTask.get(rejection.task_id);
    if (granted === undefined && nextFreeIndex > MAX_WORKERS) {
      const detail =
        initialFreeIndex > MAX_WORKERS
          ? `worker limitas ${MAX_WORKERS} jau išduotas — laisvo slot'o indekso nebėra`
          : `šiame raunde laisvas worker indeksas (iki limito ${MAX_WORKERS}) jau paskirtas ankstesniam šio raundo kandidatui`;
      refused.push({
        task_id: rejection.task_id,
        reason: "hard-cap",
        detail,
      });
      continue;
    }

    const workerIndex = granted ?? nextFreeIndex;
    if (granted === undefined) nextFreeIndex += 1;

    targets.push({ task_id: rejection.task_id, worker_index: workerIndex });
  }

  return { targets, refused };
}

// ---------------------------------------------------------------------------
// Vieno workerio lūžio izoliacija
// ---------------------------------------------------------------------------

export type WorkerRunStatus = "running" | "succeeded" | "failed" | "crashed";

export type WorkerOutcome = {
  worker_id: string;
  task_id: string;
  status: WorkerRunStatus;
  detail?: string;
};

export type WorkerPoolResolution = {
  /** Slot'ai, kurie vis dar dirba ir gali užbaigti savo nepriklausomą task'ą. */
  continuing: WorkerSlot[];
  succeeded_task_ids: string[];
  /** Žlugę task'ai — jų šaka blokuojama wave scheduler'yje (`collectBlockedBranch`). */
  failed_task_ids: string[];
  /** `true` tik kai KIEKVIENAS slot'as pasiekė terminalinę būseną. */
  integration_ready: boolean;
  /** Lease'ai, kuriuos galima atlaisvinti kartu su jų scope lock'ais. */
  release_lease_ids: string[];
  reason: string;
};

/**
 * Sudėlioja bangos būseną iš atskirų workerių rezultatų.
 *
 * Esminis dalykas: vieno slot'o lūžis NEnutraukia kito. Slot'ai paleisti tik įrodžius, kad
 * jų write set'ai nesikerta, todėl žlugęs workeris fiziškai negalėjo paliesti gyvo workerio
 * failų — jo šaka blokuojama, o kitas slot'as baigia darbą. Integracija vis tiek laukia:
 * slot'as be rezultato laikomas dirbančiu (fail-closed).
 */
export function resolveWorkerOutcomes(
  plan: WorkerPoolPlan,
  outcomes: readonly WorkerOutcome[],
): WorkerPoolResolution {
  const byWorker = new Map(outcomes.map((outcome) => [outcome.worker_id, outcome]));

  const continuing: WorkerSlot[] = [];
  const succeeded: string[] = [];
  const failed: string[] = [];
  const releaseLeaseIds: string[] = [];

  for (const slot of plan.slots) {
    const outcome = byWorker.get(slot.worker_id);
    const status: WorkerRunStatus = outcome?.status ?? "running";
    if (status === "running") {
      continuing.push(slot);
      continue;
    }
    if (status === "succeeded") succeeded.push(slot.task_id);
    else failed.push(slot.task_id);
    if (slot.lease_id) releaseLeaseIds.push(slot.lease_id);
  }

  const integrationReady = plan.slots.length > 0 && continuing.length === 0;
  const reason = integrationReady
    ? `visi ${plan.slots.length} slot'ai terminaliniai: ${succeeded.length} sėkmingi, ${failed.length} žlugę`
    : `${continuing.length} slot'as(-ai) dar dirba — integracija laukia bangos vartų`;

  return {
    continuing,
    succeeded_task_ids: [...succeeded].sort(),
    failed_task_ids: [...failed].sort(),
    integration_ready: integrationReady,
    release_lease_ids: [...new Set(releaseLeaseIds)].sort(),
    reason,
  };
}

// ---------------------------------------------------------------------------
// Parallel overhead metrika
// ---------------------------------------------------------------------------

/**
 * Kiek tokenų perteklius laikomas priimtinu už lygiagretų vykdymą. Antras workeris kainuoja
 * papildomą worktree, papildomą context pack ir bangos integracijos vartus; jei ta kaina
 * viršija šią dalį, paralelizmas nustoja būti pagerinimu.
 */
export const DEFAULT_MAX_TOKEN_OVERHEAD_RATIO = 0.15;

export type ParallelOverheadSample = {
  wall_clock_ms: number;
  tokens: number;
};

export type ParallelOverheadMetric = {
  wall_clock_saved_ms: number;
  /** `sequential / parallel`; `1` reiškia jokio pagreitėjimo. */
  speedup: number;
  token_overhead: number;
  token_overhead_ratio: number;
  within_budget: boolean;
  /** `true` tik kai laikas SUTAUPYTAS ir tokenų perteklius telpa į biudžetą. */
  worthwhile: boolean;
};

/**
 * Lygiagretaus vykdymo kaina ir nauda iš dviejų išmatuotų paleidimų.
 *
 * Gryna apskaita: matavimus paduoda iškvietėjas, funkcija tik verčia juos sprendimu.
 * Nulinis arba neigiamas sequential matavimas laikomas „nėra bazės" — tada `worthwhile`
 * yra `false`, nes pagerinimo be ko lyginti įrodyti neįmanoma.
 *
 * 2026-08-23 auditas: produkcinio kvietėjo NĖRA nei čia, nei etalone — matavimo kontraktas
 * laukia benchmark vartotojo (E6, VQ-602). Paliktas kaip suprojektuota ir ištestuota
 * galimybė; jei benchmark'as jo nepaims, trinti kartu su šia pastaba.
 */
export function measureParallelOverhead(input: {
  sequential: ParallelOverheadSample;
  parallel: ParallelOverheadSample;
  maxTokenOverheadRatio?: number;
}): ParallelOverheadMetric {
  const maxRatio = input.maxTokenOverheadRatio ?? DEFAULT_MAX_TOKEN_OVERHEAD_RATIO;
  const sequentialMs = Math.max(0, input.sequential.wall_clock_ms);
  const parallelMs = Math.max(0, input.parallel.wall_clock_ms);
  const sequentialTokens = Math.max(0, input.sequential.tokens);
  const parallelTokens = Math.max(0, input.parallel.tokens);

  const savedMs = sequentialMs - parallelMs;
  const speedup = parallelMs > 0 ? sequentialMs / parallelMs : 1;
  const overhead = parallelTokens - sequentialTokens;
  const ratio = sequentialTokens > 0 ? overhead / sequentialTokens : overhead > 0 ? Number.POSITIVE_INFINITY : 0;
  const withinBudget = ratio <= maxRatio;

  return {
    wall_clock_saved_ms: savedMs,
    speedup,
    token_overhead: overhead,
    token_overhead_ratio: ratio,
    within_budget: withinBudget,
    worthwhile: sequentialMs > 0 && savedMs > 0 && withinBudget,
  };
}
