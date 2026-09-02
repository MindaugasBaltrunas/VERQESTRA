// Bangos integracijos KOORDINATORIUS (etalonas: AG_loop
// orchestrator/loop/loop-wave-integration-coordinator.ts).
//
// Planuotojas (`planWorkerIntegration`) pasako, ar medis nurimęs ir ką su kuo daryti; šis modulis
// tą planą įvykdo ir po kiekvieno žingsnio IŠIMA slot'ą iš `finishedSlots`. Išėmimas svarbus:
// slot'as, likęs sąraše po integracijos, būtų integruojamas antrą kartą kitame checkpoint'e.
//
// Du režimai skiriasi ne apimtimi, o tuo, KIEK apie medį žinoma. `incremental` reiškia, kad kiti
// slot'ai dar dirba, tad integruojama tik tai, kas įrodytai nepriklausoma — jokių praleidimų,
// jokio parkinimo, jokio lease'ų valymo bendrai. `quiescent` yra pilnas apsisukimas: praleidimai,
// parkinimai, integracijos ir likusių lease'ų atlaisvinimas.

import { planWorkerIntegration, type FinishedWorkerSlot, type IntegrationCheckpoint } from "./worker-integration.js";
import type { LiveSlot } from "./slot-refill.js";
import { createIntegrationStepRunner } from "./wave-integration-step.js";
import {
  describeError,
  type DoneCopyRestoreOutcome,
  type TaskLocation,
  type TaskRelocation,
  type WaveIntegrationPorts,
} from "./wave-integration-ports.js";

export type WaveIntegrationCoordinatorPorts = WaveIntegrationPorts & {
  finishedSlots: Map<string, FinishedWorkerSlot>;
  /** Jau atlaisvinti lease'ai — kad bangos pabaigos valymas nekartotų to paties darbo. */
  releasedLeaseIds: Set<string>;
  liveSlots: () => LiveSlot[];
};

export type WaveIntegrationCoordinator = {
  /**
   * Praleisto (jau užbaigto) task'o failo uždarymas.
   *
   * Atskiras kelias nuo integracijos: čia nėra nei šakos, nei kopijos — tik failas, kurio darbas
   * jau padarytas. Bet baigtis ta pati problema: jei failo eilėje nebėra, jis atstatomas iš
   * istorijos, o neatstatytas keliauja žmogui.
   */
  closeSkipCompletedTaskFile: (
    taskId: string,
    reason: string,
  ) => Promise<{ relocation: TaskRelocation | "restored"; state: "done" | "escalated" }>;
  integrateFinishedSlots: (checkpoint: IntegrationCheckpoint) => Promise<void>;
};

export function createWaveIntegrationCoordinator(ports: WaveIntegrationCoordinatorPorts): WaveIntegrationCoordinator {
  const runner = createIntegrationStepRunner(ports, ports.releasedLeaseIds);

  const closeSkipCompletedTaskFile = async (
    taskId: string,
    reason: string,
  ): Promise<{ relocation: TaskRelocation | "restored"; state: "done" | "escalated" }> => {
    let relocation: TaskRelocation;
    try {
      relocation = await ports.relocateTask(taskId, "done");
    } catch (error) {
      await ports.safeLog(`WAVE RESUME TASK MOVE FAILED: task=${taskId}: ${describeError(error)}`);
      await runner.park(taskId, "skip-completed-task-move-failed", describeError(error));
      return { relocation: "absent", state: "escalated" };
    }
    if (relocation !== "absent") return { relocation, state: "done" };

    let restored: DoneCopyRestoreOutcome;
    try {
      restored = await ports.restoreDoneCopy({ taskId, preMergeHead: undefined });
    } catch (error) {
      restored = { ok: false, detail: describeError(error) };
    }
    if (restored.ok) {
      await ports.safeLog(`WAVE RESUME TASK FILE RESTORED: task=${taskId} source=${restored.source} (${reason})`);
      return { relocation: "restored", state: "done" };
    }

    await runner.park(taskId, "skip-completed-done-copy-restore-failed", restored.detail);
    return { relocation: "absent", state: "escalated" };
  };

  /**
   * Task id'ai, kurių bucket'as DABAR yra `queue`, tarp atkurtų (`restored: true`) slot'ų.
   *
   * Tik atkurti slot'ai tikrinami: jų baigtis nežinoma, tad tik jiems gresia klaidingas
   * `task-failed` parkas, jei operatorius task'ą jau grąžino į eilę. `locateTask` klaida
   * reiškia „bucket'as nežinomas" — task id į sąrašą NEPATENKA (fail-closed parkas kaip
   * anksčiau), bet nesėkmė ĮVARDIJAMA, ne nutylima (152-a-02).
   */
  const restoredQueueTaskIds = async (): Promise<string[]> => {
    const restored = [...ports.finishedSlots.values()].filter((slot) => slot.restored === true);
    const queueTaskIds: string[] = [];
    for (const slot of restored) {
      let location: TaskLocation;
      try {
        location = await ports.locateTask(slot.task_id);
      } catch (error) {
        await ports.safeLog(`WAVE RESTORED SLOT LOCATE FAILED: task=${slot.task_id}: ${describeError(error)}`);
        continue;
      }
      if (location === "queue") queueTaskIds.push(slot.task_id);
    }
    return queueTaskIds;
  };

  const integrateFinishedSlots = async (checkpoint: IntegrationCheckpoint): Promise<void> => {
    const queueTaskIds = await restoredQueueTaskIds();
    const integration = planWorkerIntegration({
      checkpoint,
      finished: [...ports.finishedSlots.values()],
      live: ports.liveSlots(),
      queueTaskIds,
    });
    if (!integration.ready) return;

    if (integration.mode === "incremental") {
      // Kiti slot'ai DAR DIRBA: integruojama tik tai, ką planuotojas įrodė esant nepriklausoma.
      // Task 135: nesėkmių parkavimas vykdomas ir čia — tai tik bucket failo perkėlimas
      // pagrindiniame medyje (be git operacijų), o atidėtas iki tylos jis užimtame cikle
      // neįvykdavo niekada ir queue failas sukdavosi re-dispatch ratu. Praleidimai ir
      // lease atlaisvinimas lieka tylos sprendimai.
      for (const parked of integration.park) {
        await ports.safeLog(
          `WORKER INTEGRATION INCREMENTAL PARK: task=${parked.task_id} live=${checkpoint.live_task_ids.join(",")}`,
        );
        await runner.park(parked.task_id, parked.reason, parked.detail);
        ports.finishedSlots.delete(parked.task_id);
      }
      for (const step of integration.integrate) {
        await ports.safeLog(
          `WORKER INTEGRATION INCREMENTAL: task=${step.task_id} live=${checkpoint.live_task_ids.join(",")}`,
        );
        await runner.run(step);
        ports.finishedSlots.delete(step.task_id);
      }
      return;
    }

    await ports.safeLog(`WORKER INTEGRATION: ${integration.reason}`);
    for (const skipped of integration.skipped) {
      await ports.safeLog(`WORKER INTEGRATION SKIPPED: task=${skipped.task_id} reason=${skipped.reason} — ${skipped.detail}`);
      ports.finishedSlots.delete(skipped.task_id);
    }
    for (const parked of integration.park) {
      await runner.park(parked.task_id, parked.reason, parked.detail);
      ports.finishedSlots.delete(parked.task_id);
    }
    for (const step of integration.integrate) {
      await runner.run(step);
      ports.finishedSlots.delete(step.task_id);
    }
    // Likę lease'ai: tie, kurių žingsnis neatlaisvino (praleisti, parkinti, be kopijos).
    for (const leaseId of integration.release_lease_ids) {
      if (ports.releasedLeaseIds.has(leaseId)) continue;
      await ports.safeLog(`WORKER INTEGRATION LEASE: lease=${leaseId} ${await runner.releaseLeaseSafely(leaseId)}`);
    }
  };

  return { closeSkipCompletedTaskFile, integrateFinishedSlots };
}
