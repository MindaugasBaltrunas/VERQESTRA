// GYVŲ slot'ų registras (etalonas: AG_loop orchestrator/loop/loop-wave-live-slots.ts).
//
// Registras yra vienintelė vieta, kur laikoma „kas dirba DABAR". Iš jo maitinasi trys skirtingi
// skaitytojai: papildymas (kuriam reikia žinoti užimtus write-set'us), snapshot'as (kuris juos
// rodo operatoriui) ir integracija (kuri bangos gale sprendžia, ką užverti). Antra tokio sąrašo
// kopija reikštų, kad trys sprendimai remiasi trimis skirtingais „dabar".
//
// Rikiavimas pagal `worker_index` yra kontraktas: snapshot'as lyginamas tarp ratų, tad nestabili
// slot'ų tvarka kiekvieną perrašymą paverstų pokyčiu.

import { computeTaskWriteSet, type TaskWriteSet } from "./conflict-detector.js";
import type { LiveSlot } from "./slot-refill.js";
import type { WorkerLease } from "../../domain/scheduling/worker-lease-rules.js";
import type { WorkerCandidate } from "./worker-pool-admission.js";
import type { TaskGraph } from "../../domain/tasks/graph/model.js";

/** Slot'o registracijai reikalingas bangos pasirinkimo pjūvis (struktūrinis, be scheduler'io). */
export type LiveSlotSelection = {
  task: { task_id: string; file: string };
  pool: { slots: readonly { worker_id: string; worker_index: number; task_id: string; attempt: number; lease_id?: string | undefined; worktree_path?: string | undefined }[] };
  refill?: { slot?: { worker_id: string; worker_index: number; task_id: string; attempt: number; lease_id?: string | undefined; worktree_path?: string | undefined } | undefined } | undefined;
};

export type LiveSlotRegistryDeps = {
  now: () => string;
  graph: () => TaskGraph | undefined;
  readWorkerLeases: () => Promise<WorkerLease[]>;
  /** Žurnalo eilutė, kuri NIEKADA nemeta — registras negali kristi dėl savo diagnostikos. */
  safeLog: (message: string) => Promise<void>;
  admittedCandidates: Map<string, WorkerCandidate>;
  liveSlots: Map<string, LiveSlot>;
};

/** Kandidato write-set'as iš grafo; be grafo — iš vieno task id (tuščias scope). */
export function candidateWriteSet(taskId: string, graph: TaskGraph | undefined): TaskWriteSet {
  const node = graph?.nodes.find((entry) => entry.task_id === taskId);
  return computeTaskWriteSet({
    task_id: taskId,
    ...(node?.scope === undefined ? {} : { allowed_paths: node.scope }),
    ...(node?.write_symbols === undefined ? {} : { write_symbols: node.write_symbols }),
    ...(node?.architecture_nodes === undefined ? {} : { architecture_nodes: node.architecture_nodes }),
  });
}

export function createLiveSlotRegistry(deps: LiveSlotRegistryDeps): {
  list: () => LiveSlot[];
  register: (selection: LiveSlotSelection) => Promise<void>;
} {
  /**
   * Lease atkūrimas iš saugyklos, kai kandidato atmintyje nebėra.
   *
   * Nesėkmė grąžina `undefined`, o ne meta: slot'as be lease'o įrašo registre vis tiek yra
   * teisingesnis nei nulūžęs registras — jo izoliaciją tikrina fantomų aptikimas, ne šis kelias.
   */
  const rehydrateLease = async (leaseId: string): Promise<WorkerLease | undefined> => {
    try {
      return (await deps.readWorkerLeases()).find((entry) => entry.lease_id === leaseId);
    } catch (error: unknown) {
      await deps.safeLog(
        `LIVE SLOT LEASE REHYDRATE FAILED: lease=${leaseId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    }
  };

  return {
    list: () => [...deps.liveSlots.values()].sort((left, right) => left.worker_index - right.worker_index),

    async register(selection): Promise<void> {
      const taskId = selection.task.task_id;
      // Papildymo slot'as nugali plano slot'ą: papildymas įvyko VĖLIAU ir aprašo tikrąją vietą.
      const planned = selection.refill?.slot ?? selection.pool.slots.find((entry) => entry.task_id === taskId);
      const candidate = deps.admittedCandidates.get(taskId);
      const workerId = planned?.worker_id ?? "w1";
      const worktreePath = candidate?.worktree_path ?? planned?.worktree_path;
      const lease =
        candidate?.lease ?? (planned?.lease_id === undefined ? undefined : await rehydrateLease(planned.lease_id));

      deps.liveSlots.set(workerId, {
        worker_id: workerId,
        // Be plano slot'o tai yra pirminis slot'as: indeksas 1, ne 0 — numeracija 1-based.
        worker_index: planned?.worker_index ?? 1,
        task_id: taskId,
        file: selection.task.file,
        attempt: planned?.attempt ?? candidate?.attempt ?? 1,
        write_set: candidate?.write_set ?? candidateWriteSet(taskId, deps.graph()),
        ...(lease === undefined ? {} : { lease }),
        ...(worktreePath === undefined ? {} : { worktree_path: worktreePath }),
        started_at: deps.now(),
      });
    },
  };
}
