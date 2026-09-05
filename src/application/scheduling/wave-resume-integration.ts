// Atkurto (crash'o) finished slot'o išsprendimas PRIEŠ pirmą `nextTask` (audito P1, 2026-09-05).
//
// Anksčiau `integrateFinishedSlots` buvo kviečiamas TIK po KITO task'o baigties
// (`wave-outcome.ts`) — viena likusi eilutė po crash'o su nesulieta šaka amžinai grąžindavo
// `already-started`. Iškeltas iš `wave-scheduler.ts` į atskirą failą, kad `recoverFromCrash`
// liktų 500 eilučių ribose (README gate: file-length, no baseline).
//
// Klaida čia atkūrimo NENUTRAUKIA — ta pati telemetrijos taisyklė kaip visur bangoje.

import { evaluateIntegrationCheckpoint, type FinishedWorkerSlot, type IntegrationCheckpoint } from "./worker-integration.js";
import type { LiveSlot } from "./slot-refill.js";
import type { WavePoolEvent } from "./wave-pool-planning.js";

export type ResumeIntegrationDeps = {
  runId: string;
  waveId: () => string;
  graphHash: string;
  liveSlotList: () => LiveSlot[];
  integrateFinishedSlots: (checkpoint: IntegrationCheckpoint) => Promise<void>;
  safeLog: (message: string) => Promise<void>;
  safeEvent: (event: WavePoolEvent) => Promise<void>;
  describe: (error: unknown) => string;
};

/** `selectNextWaveTask` ir `planPool` privalo naudoti TĄ PATĮ „jau dirba arba baigta" rinkinį. */
export function startedOrFinishedTaskIds(
  started: ReadonlySet<string>,
  finishedSlots: ReadonlyMap<string, FinishedWorkerSlot>,
): Set<string> {
  return new Set([...started, ...finishedSlots.keys()]);
}

export async function integrateRestoredSlots(
  finishedSlots: ReadonlyMap<string, FinishedWorkerSlot>,
  deps: ResumeIntegrationDeps,
): Promise<void> {
  if (finishedSlots.size === 0) return;
  try {
    const checkpoint = evaluateIntegrationCheckpoint({ live: deps.liveSlotList() });
    await deps.integrateFinishedSlots(checkpoint);
    await deps.safeEvent({
      run_id: deps.runId,
      wave_id: deps.waveId(),
      graph_hash: deps.graphHash,
      event: "resume_integration",
      reason: checkpoint.reason,
    });
  } catch (error) {
    await deps.safeLog(`WAVE RESUME INTEGRATION FAILED: ${deps.describe(error)}`);
  }
}
