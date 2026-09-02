// Vienos bangos worker POOL'o planavimas su vienkartiniu perplanavimu (etalonas: AG_loop
// orchestrator/loop/loop-wave-pool.ts).
//
// Kodėl planuojama DUKART: pirmas planas rodo, kurie kandidatai neturi lease'o, o lease'ai
// išduodami tik po jo. Antras planas mato jau išduotus lease'us ir gali priimti kandidatą,
// kurį pirmas atmetė. Perplanavimas VIENKARTINIS sąmoningai — ciklas „planuok, išduok,
// perplanuok" be ribos sukiotųsi tol, kol lease'ai baigtųsi arba planas nustotų keistis.
//
// Kiekvienas išduotas, bet į antrą planą NEPATEKĘS lease atlaisvinamas: kitaip vienas
// perplanavimas paliktų lease'ą, kuris tris valandas (TTL) blokuotų to task'o dispatch'ą.

import { planWorkerPool, type SlotProvisionTarget, type WorkerPoolPlan } from "./worker-pool-plan.js";
import type { ProvisionMissingSlotLeasesResult } from "./wave-provisioning.js";
import type { WorkerCandidate } from "./worker-pool-admission.js";
import { detectPhantomWaveSlots, type PhantomWaveSlot } from "./wave-phantom-slots.js";
import type { WorkerLease } from "../../domain/scheduling/worker-lease-rules.js";
import type { WavePlan } from "./schedule-next-wave.js";

/**
 * Slot'as, kuriam lease buvo IŠDUOTAS šio planavimo metu.
 *
 * Tipas re-eksportuojamas iš planuotojo, o ne perrašomas: dvi identiškos deklaracijos vienam
 * kontraktui išsiskiria tyliai, o čia jis tik keliauja per perplanavimą į atlaisvinimą.
 */
export type { SlotProvisionTarget } from "./worker-pool-plan.js";

export type WavePoolPlanResult = { pool: WorkerPoolPlan; phantomSlots: PhantomWaveSlot[] };

/** Bangos įvykio forma; rašytojas gyvena infrastruktūroje. */
export type WavePoolEvent = {
  run_id: string;
  wave_id: string;
  graph_hash: string;
  event: string;
  task_id?: string;
  reason?: string;
};

export type PlanWavePoolInput = {
  runId: string;
  current: WavePlan;
  requestedWorkers: number;
  /** Ar pirminis slot'as gali būti „claim'intas" (platformos galimybė). */
  primaryClaimSupported: boolean;
  now: () => string;
  log: (message: string) => Promise<void>;
  recordEvent: (event: WavePoolEvent) => Promise<void>;
  readIsolationInputs: (requested: number) => Promise<{ leases: WorkerLease[] }>;
  toWorkerCandidates: (tasks: WavePlan["ready"], leases: readonly WorkerLease[]) => WorkerCandidate[];
  rememberCandidate: (candidate: WorkerCandidate) => void;
  provisionMissingSlotLeases: (
    pool: WorkerPoolPlan,
    candidates: readonly WorkerCandidate[],
  ) => Promise<ProvisionMissingSlotLeasesResult>;
  releaseWaveProvisionLease: (target: SlotProvisionTarget) => Promise<void>;
};

export async function planWavePool(input: PlanWavePoolInput): Promise<WavePoolPlanResult> {
  const requested = input.requestedWorkers;
  // Vienas laiko skaitymas visam planavimui: du skaitymai reikštų, kad pirmas ir antras planas
  // vertina lease'ų galiojimą skirtingais momentais, ir tas pats lease galėtų būti gyvas viename
  // ir pasibaigęs kitame.
  const plannedAt = new Date(input.now());

  const initial = await input.readIsolationInputs(requested);
  let planLeases: readonly WorkerLease[] = initial.leases;
  const candidates = input.toWorkerCandidates(input.current.ready, initial.leases);
  for (const candidate of candidates) input.rememberCandidate(candidate);

  let pool = planWorkerPool({
    run_id: input.runId,
    candidates,
    requested_workers: requested,
    primary_claim_supported: input.primaryClaimSupported,
    now: plannedAt,
  });

  // Lease'ai išduodami TIK kai realiai prašoma paralelizmo: vienam slot'ui jų nereikia, o
  // nereikalingas išdavimas kainuotų fencing skaitiklį ir TTL langą.
  const provisionResult: ProvisionMissingSlotLeasesResult =
    requested >= 2
      ? await input.provisionMissingSlotLeases(pool, candidates)
      : { provisioned: [], lastOutcomeByTask: new Map<string, string>() };
  const provisioned = provisionResult.provisioned;
  if (provisioned.length > 0) {
    const retry = await input.readIsolationInputs(requested);
    planLeases = retry.leases;
    const retryCandidates = input.toWorkerCandidates(input.current.ready, retry.leases);
    for (const candidate of retryCandidates) input.rememberCandidate(candidate);
    pool = planWorkerPool({
      run_id: input.runId,
      candidates: retryCandidates,
      requested_workers: requested,
      primary_claim_supported: input.primaryClaimSupported,
      now: plannedAt,
    });
    for (const target of provisioned) {
      if (!pool.slots.some((slot) => slot.task_id === target.task_id)) {
        await input.releaseWaveProvisionLease(target);
      }
    }
  }

  const phantomSlots = detectPhantomWaveSlots(pool, planLeases, plannedAt);

  // Pool'o eilutė rašoma tik prašant paralelizmo: vieno slot'o atveju ji kartotųsi kiekvienoje
  // bangoje nieko nepasakydama.
  if (requested >= 2) {
    const rejections = pool.rejected
      .map((entry) => {
        const base = `${entry.task_id}: ${entry.reason} — ${entry.detail}`;
        // Tik `missing-lease` praturtinamas: kitų priežasčių atmetimai (pvz. `hard-cap`) provision
        // bandymo net nesulaukia, tad `lastOutcomeByTask` jiems niekada neturės įrašo.
        const lastAttempt =
          entry.reason === "missing-lease" ? provisionResult.lastOutcomeByTask.get(entry.task_id) : undefined;
        return lastAttempt === undefined ? base : `${base} — paskutinis provision bandymas: ${lastAttempt}`;
      })
      .join(" | ");
    await input.log(
      `WORKER POOL: mode=${pool.mode} requested=${pool.requested_workers} granted=${pool.slots.length}/${pool.max_workers}` +
        (rejections === "" ? "" : ` rejected=${rejections}`),
    );
    await input.recordEvent({
      run_id: input.runId,
      wave_id: input.current.wave_id,
      graph_hash: input.current.graph_hash,
      event: "worker_pool_planned",
      reason: `${pool.mode}:${pool.slots.length}/${pool.max_workers}${rejections === "" ? "" : ` (${rejections})`}`,
    });
  }

  for (const slot of phantomSlots) {
    await input.log(
      `WAVE PLAN PHANTOM SLOT: slot=${slot.worker_id} task=${slot.task_id} reason=${slot.reason} — ${slot.detail}; ` +
        "slot'as nedispatch'inamas ir bangos gale nevertinamas",
    );
    await input.recordEvent({
      run_id: input.runId,
      wave_id: input.current.wave_id,
      graph_hash: input.current.graph_hash,
      event: "worker_slot_phantom",
      task_id: slot.task_id,
      reason: `${slot.worker_id}: ${slot.reason} — ${slot.detail}`,
    });
  }

  return { pool, phantomSlots };
}
