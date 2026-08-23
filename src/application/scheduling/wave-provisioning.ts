// Bangos slot'ų APRŪPINIMAS — lease + izoliuota darbo kopija (etalonas: AG_loop
// orchestrator/loop/loop-wave-provisioning.ts).
//
// Planuotojas pasako, KAM reikia lease'o (`planSlotProvisioning`), o šis modulis tą sprendimą
// įvykdo. Tarp jų yra riba, kurios negalima sulieti: planavimas yra grynas, o aprūpinimas
// liečia lease store ir git medį, tad kiekvienas jo žingsnis gali nepavykti ir kiekvienas
// nepavykimas privalo baigtis TYLIU „ne", o ne išimtimi. Loop'as, kritęs dėl to, kad viena
// darbo kopija nesusikūrė, prarastų visą bangą.
//
// Vartų tvarka prieš lease'o išdavimą yra kontraktas ir ji eina nuo pigiausio prie brangiausio:
// worktree politika → gitignore'inta šaknis → lease → darbo kopija. Politika tikrinama PIRMA,
// nes išjungta politika reiškia, kad izoliacijos nėra pagal dizainą; gitignore tikrinamas prieš
// lease'ą, nes lease, išduotas kopijai, kuri niekada nebus sukurta, kabotų visą TTL.
//
// NUKRYPIMAS nuo etalono (griežtinantis): proceso tapatybė (`owner_id`) paduodama iš išorės, o ne
// skaitoma iš `process.pid` viduje — application sluoksnis proceso būsenos neskaito, ir dėl to
// aprūpinimą galima patikrinti be tikro proceso.

import type { TaskWriteSet } from "./conflict-detector.js";
import { candidateWriteSet } from "./wave-live-slots.js";
import { formatWorkerId } from "./worker-limits.js";
import {
  acquireWorkerLease,
  listWorkerLeases,
  releaseWorkerLease,
  writeWorkerLease,
  type WorkerLeaseStoreDeps,
} from "./worker-lease-store.js";
import { planSlotProvisioning, type SlotProvisionTarget, type WorkerPoolPlan } from "./worker-pool-plan.js";
import { findWriteSetConflict, orderWorkerCandidates, type WorkerCandidate } from "./worker-pool-admission.js";
import { WAVE_SLOT_LEASE_TTL_MS } from "./loop-runtime-config.js";
import type { WaveReadyTask } from "./schedule-next-wave.js";
import { isLeaseExpired, leaseClaimOf, type WorkerLease } from "../../domain/scheduling/worker-lease-rules.js";
import { normalizeTaskReference } from "../../domain/tasks/dependencies.js";
import type { TaskGraph } from "../../domain/tasks/graph/model.js";

/** Kieno vardu kuriama darbo kopija. Ta pati tapatybė keliauja į lease ir į kopijos savininko žymą. */
export type WorktreeProvisionIdentity = {
  run_id: string;
  worker_id: string;
  task_id: string;
  attempt: number;
};

/**
 * Darbo kopijos kūrimo baigtis — SIAURA forma, ne infrastruktūros tipas.
 *
 * `quarantined` ir `infrastructure` abu reiškia „kopijos nėra", bet skiriasi tuo, ką operatorius
 * turi daryti: karantinas laukia žmogaus sprendimo dėl likusio darbo, infrastruktūros klaida yra
 * aplinkos problema. Sulieti juos į vieną `false` reikštų prarasti tą skirtumą žurnale.
 */
export type WorktreeProvisionOutcome =
  | { status: "created" | "reused"; relativePath: string }
  | { status: "quarantined"; reason: string }
  | { status: "infrastructure"; message: string };

/** Git pusė, kurios application sluoksnis pats neliečia. */
export type WaveWorktreePort = {
  /** Ar izoliacija apskritai įjungta. Išjungta politika nėra klaida — tai pasirinktas režimas. */
  policyEnabled: () => Promise<boolean>;
  /** Ar kopijų šaknis gitignore'inta: neignoruojama šaknis padarytų pagrindinį medį nešvarų. */
  rootIsIgnored: () => Promise<boolean>;
  create: (input: { identity: WorktreeProvisionIdentity; lease: WorkerLease }) => Promise<WorktreeProvisionOutcome>;
};

export type WaveProvisioningDeps = {
  /** Lease store ir kopijų šaknis. Viena šaknis abiem — kitaip lease rodytų į svetimą medį. */
  workspaceRoot: string;
  runId: string;
  /** Proceso tapatybė (pvz. `loop-1234`) — paduodama, ne skaitoma iš `process`. */
  ownerId: string;
  leaseStore: WorkerLeaseStoreDeps;
  worktree: WaveWorktreePort;
  now: () => string;
  log: (message: string) => Promise<void>;
  graph: () => TaskGraph | undefined;
  isRunning: (taskId: string) => boolean;
  hasStarted: (taskId: string) => boolean;
};

export type WaveProvisioningCoordinator = {
  toWorkerCandidates: (tasks: readonly WaveReadyTask[], leases: readonly WorkerLease[]) => WorkerCandidate[];
  readIsolationInputs: (requested: number) => Promise<{ leases: WorkerLease[] }>;
  provisionSlotLease: (target: SlotProvisionTarget) => Promise<boolean>;
  provisionMissingSlotLeases: (
    pool: WorkerPoolPlan,
    candidates: readonly WorkerCandidate[],
  ) => Promise<SlotProvisionTarget[]>;
  releaseWaveProvisionLease: (target: SlotProvisionTarget) => Promise<void>;
};

/** Pirminis slot'as dirba pirminiame medyje BE lease'o — žr. `planSlotProvisioning` paaiškinimą. */
export const PRIMARY_SLOT_CLAIM_SUPPORTED = false;

export function createWaveProvisioningCoordinator(deps: WaveProvisioningDeps): WaveProvisioningCoordinator {
  // Kandidato write-set taisyklė yra VIENA visai sistemai — `wave-live-slots.candidateWriteSet`.
  // Iki 2026-08-23 čia gyveno jos pažodinė kopija (plius negyvas interface narys, kurio niekas
  // nekvietė) — dvi kopijos išsiskirtų tyliai, kai grafo laukai keisis.
  const writeSetOf = (taskId: string): TaskWriteSet => candidateWriteSet(taskId, deps.graph());

  const leases = async (): Promise<WorkerLease[]> => await listWorkerLeases(deps.leaseStore.fs, deps.workspaceRoot);

  const provisionSlotLease = async (target: SlotProvisionTarget): Promise<boolean> => {
    const workerId = formatWorkerId(target.worker_index);
    const where = `worker=${workerId} task=${target.task_id}`;

    /**
     * Lease, kurį šis kvietimas paėmė. Laikomas UŽ `try` ribų, kad jį būtų galima grąžinti ir
     * išimties atveju (2026-08-23, operatoriaus radinys).
     */
    let held: WorkerLease | undefined;

    /**
     * Grąžina lease, jei aprūpinimas nepavyko PO jo paėmimo.
     *
     * Iki tol `quarantined`, `infrastructure` ir išimties keliai grįždavo `false` lease'o
     * NEATLAISVINĘ. Bendras pool'o valymas jo nemato, nes nepavykęs slot'as į `provisioned`
     * nepatenka, tad worker'is likdavo užimtas iki TTL — trijų valandų.
     *
     * Grąžinama TIK tada, kai už lease'o NESTOVI gyva kopija: `worktree_path` reiškia, kad
     * izoliacija jau egzistuoja, ir jos lease'o nuėmimas būtų blogesnis už nutekėjimą.
     */
    const releaseHeldLease = async (reason: string): Promise<void> => {
      if (held === undefined) return;
      if (held.worktree_path !== undefined && held.worktree_path !== "") {
        await deps.log(`SLOT LEASE KEPT: ${where} — už lease'o stovi kopija ${held.worktree_path} (${reason})`);
        return;
      }
      try {
        const released = await releaseWorkerLease({
          deps: deps.leaseStore,
          projectRoot: deps.workspaceRoot,
          workerId,
          claim: leaseClaimOf(held),
        });
        await deps.log(
          released.status === "ok"
            ? `SLOT LEASE RELEASED: ${where} lease=${held.lease_id} — ${reason}`
            : `SLOT LEASE RELEASE DENIED: ${where} lease=${held.lease_id} — ${reason}`,
        );
      } catch (error) {
        // Atlaisvinimo klaida NEGALI paversti aprūpinimo klaidos į kritusią bangą.
        await deps.log(`SLOT LEASE RELEASE FAILED: ${where}: ${describe(error)}`);
      }
    };

    try {
      if (!(await deps.worktree.policyEnabled())) {
        await deps.log(`SLOT PROVISION SKIP: worktree politika išjungta (${where})`);
        return false;
      }
      if (!(await deps.worktree.rootIsIgnored())) {
        await deps.log(`SLOT PROVISION SKIP: worktree šaknis nėra gitignore'inta (${where})`);
        return false;
      }

      const identity: WorktreeProvisionIdentity = {
        run_id: deps.runId,
        worker_id: workerId,
        task_id: target.task_id,
        attempt: 1,
      };
      const acquired = await acquireWorkerLease({
        deps: deps.leaseStore,
        projectRoot: deps.workspaceRoot,
        identity: { ...identity, owner_id: deps.ownerId },
        ttlMs: WAVE_SLOT_LEASE_TTL_MS,
      });
      if (acquired.status === "conflict") {
        await deps.log(
          `SLOT LEASE CONFLICT: aktyvų lease laiko ${acquired.holder.owner_id} (task=${acquired.holder.task_id}) — ${where} negauna savo lease`,
        );
        return false;
      }
      // Pakartotinai panaudotas lease gali priklausyti JAU BAIGTAM task'ui: tas pats worker'io
      // indeksas, kitas darbas. Perimti jį reikštų dirbti svetimoje kopijoje.
      if (acquired.status === "reused" && acquired.lease.task_id !== target.task_id) {
        // NEatlaisvinama: šis lease priklauso kitam darbui, ir jo nuėmimas nutrauktų svetimą
        // izoliaciją. `held` lieka nenustatytas, tad ir vėlesni keliai jo nelies.
        await deps.log(`SLOT PROVISION SKIP: reused lease priklauso task'ui ${acquired.lease.task_id} (${where})`);
        return false;
      }
      // Nuo čia lease yra MŪSŲ (`acquired` arba to paties owner'io `reused`), tad kiekvienas
      // nesėkmės kelias privalo jį grąžinti.
      held = acquired.lease;

      const created = await deps.worktree.create({ identity, lease: acquired.lease });
      if (created.status === "quarantined") {
        await deps.log(`SLOT WORKTREE QUARANTINED: ${created.reason} (${where})`);
        await releaseHeldLease("worktree karantinas");
        return false;
      }
      if (created.status === "infrastructure") {
        await deps.log(`SLOT WORKTREE FAILED: ${created.message} (${where})`);
        await releaseHeldLease("worktree infrastruktūros klaida");
        return false;
      }

      // Kelias į lease rašomas TIK po sėkmingo sukūrimo: lease su keliu, kurio nėra, kitiems
      // skaitytojams atrodytų kaip paruošta izoliacija.
      await writeWorkerLease(deps.leaseStore.fs, deps.workspaceRoot, {
        ...acquired.lease,
        worktree_path: created.relativePath,
      });
      // Nuo šios eilutės aprūpinimas PAVYKO — lease priklauso gyvai kopijai, ir grąžinti jo
      // nebegalima net jei žemiau kas nors mestų.
      held = undefined;
      await deps.log(
        `SLOT PROVISIONED: task=${target.task_id} worker=${workerId} lease=${acquired.lease.lease_id} worktree=${created.relativePath} (${created.status})`,
      );
      return true;
    } catch (error) {
      // Aprūpinimas NIEKADA nemeta: viena nesusikūrusi kopija reiškia vienu slot'u mažiau,
      // o ne kritusią bangą.
      await deps.log(`SLOT PROVISION FAILED: ${describe(error)} (${where})`);
      await releaseHeldLease("aprūpinimo išimtis");
      return false;
    }
  };

  return {
    toWorkerCandidates(tasks, held): WorkerCandidate[] {
      const liveAt = new Date(deps.now());
      return tasks.map((task) => {
        // Lease priskiriamas kandidatui TIK jei jis gyvas: pasibaigęs lease yra įrodymo
        // nebuvimas, ne įrodymas, ir vartai jį privalo matyti kaip trūkstamą.
        const lease = held.find(
          (entry) =>
            normalizeTaskReference(entry.task_id) === task.task_id &&
            entry.status === "held" &&
            !isLeaseExpired(entry, liveAt),
        );
        return {
          task_id: task.task_id,
          file: task.file,
          depth: task.depth,
          write_set: writeSetOf(task.task_id),
          ...(lease === undefined ? {} : { lease }),
          ...(lease?.worktree_path === undefined ? {} : { worktree_path: lease.worktree_path }),
        };
      });
    },

    async readIsolationInputs(requested): Promise<{ leases: WorkerLease[] }> {
      // Vieno slot'o bangoje lease'ų klausimo nėra, tad store net neskaitomas.
      if (requested < 2) return { leases: [] };
      try {
        return { leases: await leases() };
      } catch (error) {
        // Neperskaitytas store reiškia „lease'ų nematau", ir vartai tada atmes kandidatus kaip
        // `missing-lease`. Tylus tuščias sąrašas be žurnalo paverstų sutrikimą normalia banga.
        await deps.log(`WORKER LEASE STORE UNREADABLE: ${describe(error)}`);
        return { leases: [] };
      }
    },

    provisionSlotLease,

    async releaseWaveProvisionLease(target): Promise<void> {
      const workerId = formatWorkerId(target.worker_index);
      try {
        // Atlaisvinamas tik TO PATIES task'o held lease: jei per tą laiką slot'ą jau perėmė
        // kitas darbas, atlaisvinimas nutrauktų svetimą izoliaciją.
        const lease = (await leases()).find(
          (entry) => entry.worker_id === workerId && entry.status === "held" && entry.task_id === target.task_id,
        );
        if (lease === undefined) {
          await deps.log(
            `WAVE PROVISION LEASE RELEASE SKIPPED: worker=${workerId} task=${target.task_id} — held lease šiam task'ui nerastas`,
          );
          return;
        }
        const released = await releaseWorkerLease({
          deps: deps.leaseStore,
          projectRoot: deps.workspaceRoot,
          workerId,
          claim: leaseClaimOf(lease),
        });
        await deps.log(
          released.status === "ok"
            ? `WAVE PROVISION LEASE RELEASED: worker=${workerId} task=${target.task_id} lease=${lease.lease_id} — planavimas slot'o neišdavė`
            : `WAVE PROVISION LEASE RELEASE DENIED: worker=${workerId} lease=${lease.lease_id}`,
        );
      } catch (error) {
        await deps.log(`WAVE PROVISION LEASE RELEASE FAILED: worker=${workerId} task=${target.task_id}: ${describe(error)}`);
      }
    },

    async provisionMissingSlotLeases(pool, candidates): Promise<SlotProvisionTarget[]> {
      const provisioning = planSlotProvisioning({ plan: pool, primary_claim_supported: PRIMARY_SLOT_CLAIM_SUPPORTED });
      // Atsisakymai rašomi VISI, net jei nė vienas lease neišduodamas: be jų operatorius matytų
      // tuščią aprūpinimą ir negalėtų pasakyti, ar nebuvo adresatų, ar jie buvo atmesti.
      for (const refusal of provisioning.refused) {
        const worker = refusal.worker_index === undefined ? "" : ` worker=${formatWorkerId(refusal.worker_index)}`;
        await deps.log(`SLOT PROVISION REFUSED: task=${refusal.task_id}${worker} reason=${refusal.reason} — ${refusal.detail}`);
      }

      const byTask = new Map(candidates.map((candidate) => [candidate.task_id, candidate]));
      const ordered = orderWorkerCandidates(candidates);
      const grantedTaskIds = new Set(pool.slots.map((slot) => slot.task_id));
      const missingLease = new Set(
        pool.rejected.filter((entry) => entry.reason === "missing-lease").map((entry) => entry.task_id),
      );
      // Užimtieji auga kartu su išdavimu: kiekvienas naujai aprūpintas task'as tampa write-set
      // kliūtimi kitiems tos pačios bangos adresatams.
      const occupants = pool.slots
        .map((slot) => byTask.get(slot.task_id))
        .filter((candidate): candidate is WorkerCandidate => candidate !== undefined);
      const claimed = new Set<string>();
      const provisioned: SlotProvisionTarget[] = [];

      for (const target of provisioning.targets) {
        if (claimed.has(target.task_id)) continue;
        claimed.add(target.task_id);
        if (deps.isRunning(target.task_id) || deps.hasStarted(target.task_id)) {
          await deps.log(`SLOT PROVISION SKIP: task jau dispatch'intas (worker=${formatWorkerId(target.worker_index)} task=${target.task_id})`);
          continue;
        }

        let chosen = byTask.get(target.task_id);
        if (chosen !== undefined) {
          const conflict = findWriteSetConflict(chosen, occupants);
          if (conflict !== undefined) {
            await deps.log(
              `SLOT PROVISION SKIP: write-set-conflict su ${conflict.occupant.task_id} (worker=${formatWorkerId(target.worker_index)} task=${chosen.task_id}) — ${conflict.rejection.detail}`,
            );
            // Slot'as neprarandamas: jį gauna ŽEMIAUSIAS eilėje kandidatas, kuris irgi laukia
            // lease'o ir su niekuo nekonfliktuoja. Pakaitalas ieškomas ta pačia tvarka, kad
            // pasirinkimas nepriklausytų nuo to, kuris task'as krito.
            chosen = ordered.find(
              (candidate) =>
                !claimed.has(candidate.task_id) &&
                !grantedTaskIds.has(candidate.task_id) &&
                !deps.isRunning(candidate.task_id) &&
                !deps.hasStarted(candidate.task_id) &&
                candidate.lease === undefined &&
                missingLease.has(candidate.task_id) &&
                findWriteSetConflict(candidate, occupants) === undefined,
            );
            if (chosen === undefined) continue;
            claimed.add(chosen.task_id);
          }
        }

        const resolved = chosen === undefined ? target : { task_id: chosen.task_id, worker_index: target.worker_index };
        if (!(await provisionSlotLease(resolved))) continue;
        provisioned.push(resolved);
        const admitted = byTask.get(resolved.task_id);
        if (admitted !== undefined) occupants.push(admitted);
      }
      return provisioned;
    },
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
