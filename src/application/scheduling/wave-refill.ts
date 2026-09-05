// Atsilaisvinusio slot'o PAPILDYMAS (etalonas: AG_loop orchestrator/loop/loop-wave-refill.ts).
//
// Kai worker'is baigia task'ą, jo slot'as neturi stovėti iki bangos pabaigos — jei eilėje yra
// nepriklausomas kandidatas, jį galima paleisti iškart. Bet papildymas yra būtent ta vieta, kur
// lengviausia pažeisti izoliaciją: naujas task'as gauna JAU dirbančio worker'io vietą.
//
// Trys taisyklės, kurios tai neleidžia:
//   1. `hold` (sulaikymas) tikrinamas PIRMAS ir be jokio planavimo — sulaikytas slot'as
//      nedalyvauja net kandidatų atrankoje;
//   2. kandidatai perskaičiuojami IŠ NAUJO (`replan`), o ne imami iš bangos pradžios plano:
//      per tą laiką kiti slot'ai jau galėjo užimti kelius;
//   3. jau vykdomi ir jau startavę task'ai išmetami — kitaip tas pats task'as gautų antrą slot'ą.
//
// Vienkartinis lease išdavimas: jei pirmas sprendimas atmetė kandidatą TIK dėl trūkstamo
// lease'o, jis išduodamas ir planuojama dar kartą. Jei antras planas to kandidato vis tiek
// nepasirinko, lease ATLAISVINAMAS — kitaip jis liktų kaboti visą TTL.

import { planSlotRefill, type LiveSlot, type SlotRefillDecision, type SlotRefillHold } from "./slot-refill.js";
import type { WavePlan, WaveReadyTask } from "./schedule-next-wave.js";
import { planWorkerPool, type WorkerPoolPlan } from "./worker-pool-plan.js";
import { orderWorkerCandidates, type WorkerCandidate } from "./worker-pool-admission.js";
import type { SlotProvisionTarget, WavePoolEvent } from "./wave-pool-planning.js";
import type { WaveDispatchSlot } from "./wave-dispatch-model.js";
import type { WorkerLease } from "../../domain/scheduling/worker-lease-rules.js";
import type { TaskGraph } from "../../domain/tasks/graph/model.js";

/**
 * Bangos dispatch'o slot'as — ką realiai paleisti po papildymo.
 *
 * Tipas re-eksportuojamas iš dispatch'o modelio, o ne perrašomas: papildymas ir dispatch'as kalba
 * apie TĄ PATĮ slot'ą, ir dvi jo deklaracijos išsiskirtų tyliai.
 */
export type { WaveDispatchSlot } from "./wave-dispatch-model.js";

export type WaveRefillResult = {
  selection: {
    kind: "task";
    task: WaveReadyTask;
    absoluteFile: string;
    plan: WavePlan;
    pool: WorkerPoolPlan;
    refill: SlotRefillDecision;
  };
  slot: WaveDispatchSlot;
  decision: SlotRefillDecision;
};

export type RefillWaveContext = {
  waveId: string;
  graphHash: string;
  requestedWorkers: number;
  poolPlan?: WorkerPoolPlan | undefined;
  canonicalGraph?: TaskGraph | undefined;
};

export type WaveRefillDeps = {
  /** Absoliutaus kelio sudėjimas; kelio aritmetika lieka kvietėjo pusėje. */
  absolutePath: (relativeFile: string) => string;
  runId: string;
  primaryClaimSupported: boolean;
  now: () => string;
  log: (message: string) => Promise<void>;
  recordEvent: (event: WavePoolEvent) => Promise<void>;
  context: () => RefillWaveContext;
  nextEpisode: () => number;
  appendDecision: (decision: SlotRefillDecision) => void;
  persist: () => Promise<void>;
  replan: () => Promise<WavePlan>;
  liveSlots: () => LiveSlot[];
  isRunning: (taskId: string) => boolean;
  hasStarted: (taskId: string) => boolean;
  readIsolationInputs: (requested: number) => Promise<{ leases: WorkerLease[] }>;
  toWorkerCandidates: (tasks: readonly WaveReadyTask[], leases: readonly WorkerLease[]) => WorkerCandidate[];
  provisionSlotLease: (target: SlotProvisionTarget) => Promise<boolean>;
  releaseUnusedProvision: (workerId: string, taskId: string) => Promise<void>;
  rememberCandidate: (candidate: WorkerCandidate) => void;
  candidateWriteSet: (taskId: string, graph: TaskGraph | undefined) => WorkerCandidate["write_set"];
};

/**
 * `w2` → 2. Neatpažinta forma duoda 1 — pirminis slot'as yra saugus default'as.
 *
 * VIENINTELIS šios taisyklės šaltinis visai wave grandinei. Iki 2026-08-24 `wave-scheduler`
 * laikė pažodinę kopiją (`workerIndexOfId`) su komentaru „ta pati taisyklė kaip papildyme" —
 * t. y. dublikatas buvo žinomas ir vis tiek paliktas. Dvi to paties parserio kopijos išsiskiria
 * TYLIAI: slot'o indeksas eina į lease nuosavybę, tad išsiskyrimas reikštų, kad papildymas ir
 * planuoklis mano skirtingus dalykus apie tą patį workerį.
 */
export function workerIndexOf(workerId: string): number {
  const parsed = Number.parseInt(workerId.replace(/^w/i, ""), 10);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : 1;
}

export function createWaveRefillCoordinator(deps: WaveRefillDeps): {
  refillSlot: (freedWorkerId: string, hold: SlotRefillHold) => Promise<WaveRefillResult | undefined>;
} {
  const report = async (decision: SlotRefillDecision): Promise<void> => {
    deps.appendDecision(decision);
    const context = deps.context();
    const line = `episode=${decision.episode} slot=${decision.worker_id} ${decision.reason}`;
    await deps.log(`WORKER POOL REFILL: ${line}`);
    await deps.recordEvent({
      run_id: deps.runId,
      wave_id: context.waveId,
      graph_hash: context.graphHash,
      // Atsisakymas papildyti irgi yra ĮVYKIS: be jo operatorius matytų tik tylą ir negalėtų
      // atskirti „nebuvo kandidatų" nuo „papildymas neįvyko dėl klaidos".
      event: decision.slot === undefined ? "worker_slot_refill_declined" : "worker_slot_refilled",
      ...(decision.slot === undefined ? {} : { task_id: decision.slot.task_id }),
      reason: line,
    });
    await deps.persist();
  };

  return {
    async refillSlot(freedWorkerId, hold): Promise<WaveRefillResult | undefined> {
      const episode = deps.nextEpisode();
      const freedSlot = { worker_id: freedWorkerId, worker_index: workerIndexOf(freedWorkerId) };
      const initialContext = deps.context();

      // Sulaikytas slot'as: sprendimas priimamas BE kandidatų, kad sulaikymo priežastis
      // patektų į žurnalą, o nė vienas task'as net nebūtų svarstomas.
      if (hold.kind !== "none") {
        await report(
          planSlotRefill({
            run_id: deps.runId,
            episode,
            freed_slot: freedSlot,
            candidates: [],
            live: deps.liveSlots(),
            granted_workers: Math.max(1, initialContext.requestedWorkers),
            hold,
            primary_claim_supported: deps.primaryClaimSupported,
            now: new Date(deps.now()),
          }),
        );
        return undefined;
      }

      const current = await deps.replan();
      const context = deps.context();
      const granted = Math.max(1, context.requestedWorkers);
      // Jau vykdomi ir jau startavę task'ai išmetami: kitaip tas pats task'as gautų antrą slot'ą.
      const candidateTasks = current.ready.filter(
        (task) => !deps.isRunning(task.task_id) && !deps.hasStarted(task.task_id),
      );
      const { leases } = await deps.readIsolationInputs(context.requestedWorkers);
      const candidates = deps.toWorkerCandidates(candidateTasks, leases);

      const decide = (refreshed: WorkerCandidate[]): SlotRefillDecision =>
        planSlotRefill({
          run_id: deps.runId,
          episode,
          freed_slot: freedSlot,
          candidates: refreshed,
          live: deps.liveSlots(),
          granted_workers: granted,
          hold,
          primary_claim_supported: deps.primaryClaimSupported,
          now: new Date(deps.now()),
        });

      const firstDecision = decide(candidates);
      let decision = firstDecision;
      // Kandidatų sąrašas, kuriame IEŠKOMA laimėtojo `rememberCandidate` reikmėms — po sėkmingo
      // aprūpinimo perjungiamas į ATNAUJINTĄ (su laimėtojo lease/worktree), kitaip įsimintas
      // kandidatas liktų pasenęs net tada, kai jis realiai laimėjo su nauju lease'u.
      let rememberFrom = candidates;

      if (firstDecision.slot === undefined) {
        // Išduodama TIK tada, kai kandidatas atmestas BŪTENT dėl trūkstamo lease'o. Bet kuri
        // kita atmetimo priežastis (konfliktas, sulaikymas) lease'o neišspręstų.
        const target = orderWorkerCandidates(candidates).find(
          (candidate) =>
            candidate.lease === undefined &&
            firstDecision.rejected.some(
              (entry) => entry.task_id === candidate.task_id && entry.reason === "missing-lease",
            ),
        );
        if (
          target !== undefined &&
          (await deps.provisionSlotLease({ worker_index: freedSlot.worker_index, task_id: target.task_id }))
        ) {
          const refreshed = await deps.readIsolationInputs(context.requestedWorkers);
          const refreshedCandidates = deps.toWorkerCandidates(candidateTasks, refreshed.leases);
          const replanned = decide(refreshedCandidates);
          if (replanned.slot?.task_id === target.task_id) {
            decision = replanned;
            rememberFrom = refreshedCandidates;
          } else {
            // Lease išduotas, bet laimėjo kas kita (arba niekas) — atlaisviname, kad jis
            // nekabotų visą TTL. Sprendimas imamas tas, kuris realiai turi slot'ą.
            await deps.releaseUnusedProvision(freedSlot.worker_id, target.task_id);
            decision = replanned.slot === undefined ? replanned : firstDecision;
          }
        }
      }

      const winner = decision.slot;
      const task = winner === undefined ? undefined : current.ready.find((entry) => entry.task_id === winner.task_id);
      if (winner === undefined || task === undefined) {
        await report(decision);
        return undefined;
      }

      deps.rememberCandidate(
        rememberFrom.find((entry) => entry.task_id === winner.task_id) ?? {
          task_id: winner.task_id,
          file: winner.file,
          write_set: deps.candidateWriteSet(winner.task_id, context.canonicalGraph),
        },
      );
      await report(decision);

      return {
        selection: {
          kind: "task",
          task,
          absoluteFile: deps.absolutePath(task.file),
          plan: current,
          // Be bangos pool'o plano sudaromas tuščias: papildymas negali likti be pool'o
          // konteksto, o išgalvoti svetimo plano negalima.
          pool:
            context.poolPlan ??
            planWorkerPool({
              run_id: deps.runId,
              candidates: [],
              requested_workers: context.requestedWorkers,
              now: new Date(deps.now()),
            }),
          refill: decision,
        },
        slot: {
          worker_id: winner.worker_id,
          task_id: winner.task_id,
          file: winner.file,
          absoluteFile: deps.absolutePath(winner.file),
          ...(winner.worktree_path === undefined ? {} : { worktree_path: winner.worktree_path }),
          ...(winner.lease_id === undefined ? {} : { lease_id: winner.lease_id }),
          ...(winner.attempt_ref === undefined ? {} : { attempt_ref: winner.attempt_ref }),
        },
        decision,
      };
    },
  };
}
