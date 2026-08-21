// FANTOMINIŲ slot'ų aptikimas (etalonas: AG_loop orchestrator/loop/loop-wave-phantom-slots.ts).
//
// Fantomas — tai slot'as, kuris PLANE atrodo išduotas, bet už jo nebėra galiojančio lease'o
// arba darbo kopijos. Jis pavojingas būtent tuo, kad atrodo tvarkingai: be šios patikros loop'as
// jį dispatch'intų, o bangos gale dar ir vertintų jo baigtį — t. y. priskirtų rezultatą darbui,
// kurio niekas nedirbo.
//
// Aptikimas GRYNAS ir be IO: plano bei lease'ų sąrašo užtenka, todėl kiekvieną iš penkių fantomo
// veislių galima prikalti testu be repo.

import { isLeaseExpired, type WorkerLease } from "../../domain/scheduling/worker-lease-rules.js";
import { normalizeTaskReference } from "../../domain/tasks/dependencies.js";
import type { ParallelRejectionReason } from "./worker-pool-admission.js";
import type { WorkerPoolPlan } from "./worker-pool-plan.js";

export type PhantomWaveSlot = {
  worker_id: string;
  task_id: string;
  reason: "plan-rejected" | "lease-absent" | "lease-inactive" | "lease-expired" | "lease-task-mismatch";
  detail: string;
};

/**
 * Pool'o atmetimai, kurie slot'ą daro fantomu.
 *
 * Sąrašas siauras SĄMONINGAI: ne kiekvienas atmetimas reiškia fantomą. Čia surinkti tik tie,
 * kurie liečia IZOLIACIJĄ (lease, darbo kopija) — jie reiškia, kad slot'as neturi savo vietos
 * dirbti. Kiti atmetimai (pvz. konfliktuojantis write-set) yra normalūs planavimo sprendimai.
 */
const BLOCKING_POOL_REJECTIONS: ReadonlySet<ParallelRejectionReason> = new Set<ParallelRejectionReason>([
  "missing-lease",
  "inactive-lease",
  "lease-task-mismatch",
  "missing-worktree",
  "shared-worktree",
]);

export function detectPhantomWaveSlots(
  pool: WorkerPoolPlan,
  leases: readonly WorkerLease[],
  now: Date,
): PhantomWaveSlot[] {
  const phantom: PhantomWaveSlot[] = [];

  for (const slot of pool.slots) {
    // Slot'as be lease'o IR be darbo kopijos yra pirminis (in-process) kelias — jam izoliacijos
    // įrodymų nereikia, tad jis niekada nėra fantomas.
    if (slot.lease_id === undefined && slot.worktree_path === undefined) continue;

    const base = { worker_id: slot.worker_id, task_id: slot.task_id };

    const rejection = pool.rejected.find(
      (entry) => entry.task_id === slot.task_id && BLOCKING_POOL_REJECTIONS.has(entry.reason),
    );
    if (rejection !== undefined) {
      phantom.push({ ...base, reason: "plan-rejected", detail: `${rejection.reason}: ${rejection.detail}` });
      continue;
    }
    if (slot.lease_id === undefined) continue;

    const lease = leases.find((entry) => entry.lease_id === slot.lease_id);
    if (lease === undefined) {
      phantom.push({ ...base, reason: "lease-absent", detail: `lease ${slot.lease_id} store'e nerastas` });
      continue;
    }
    if (lease.status !== "held") {
      phantom.push({ ...base, reason: "lease-inactive", detail: `lease ${lease.lease_id} yra '${lease.status}'` });
      continue;
    }
    if (isLeaseExpired(lease, now)) {
      phantom.push({
        ...base,
        reason: "lease-expired",
        detail: `lease ${lease.lease_id} galiojo iki ${lease.expires_at}`,
      });
      continue;
    }
    // Lease gyvas, bet priklauso KITAM task'ui: slot'as dirbtų su svetima izoliacija.
    if (normalizeTaskReference(lease.task_id) !== slot.task_id) {
      phantom.push({
        ...base,
        reason: "lease-task-mismatch",
        detail: `lease ${lease.lease_id} yra task'ui ${lease.task_id}`,
      });
    }
  }

  return phantom;
}
