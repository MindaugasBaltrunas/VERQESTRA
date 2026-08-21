// Bangos snapshot'o PERSISTAVIMAS (etalonas: AG_loop orchestrator/loop/loop-wave-snapshot.ts).
//
// Modulis nesprendžia NIEKO apie planavimą — jis tik verčia planuoklio runtime būseną į
// persistuojamą projekciją. Dėl to jis atskiras: sprendimų priėmimas ir jų serializavimas turi
// skirtingas keitimo priežastis, ir sulieti jie reikštų, kad snapshot'o formos pakeitimas liečia
// planavimo kodą.
//
// Dvi taisyklės, kurios čia yra kontraktas:
//   1. be plano snapshot'as NERAŠOMAS — tuščias įrašas UI srautui atrodytų kaip banga be task'ų;
//   2. pool'o santrauka rašoma TIK tada, kai `poolPlanWaveId` sutampa su plano banga. Kitaip
//      senos bangos skaičiai būtų pateikti kaip einamosios bangos faktas.

import { buildWaveSnapshot, type WaveSnapshot, type WaveTaskStateOverride } from "./wave-snapshot.js";
import type { LiveSlot, SlotRefillDecision } from "./slot-refill.js";
import type { WavePlan } from "./schedule-next-wave.js";
import type { WorkerPoolPlan } from "./worker-pool-plan.js";

export type RefillDecisionLog = { decision: SlotRefillDecision; decided_at: string };

export type WaveSnapshotState = {
  plan?: WavePlan | undefined;
  poolPlan?: WorkerPoolPlan | undefined;
  poolPlanWaveId?: string | undefined;
  waveCreatedAt: string;
  overrides: ReadonlyMap<string, WaveTaskStateOverride>;
  liveSlots: readonly LiveSlot[];
  refillEpisode: number;
  refillLog: readonly RefillDecisionLog[];
};

export async function persistWaveSnapshot(input: {
  runId: string;
  now: () => string;
  writeSnapshot: (snapshot: WaveSnapshot) => Promise<void>;
  state: WaveSnapshotState;
}): Promise<void> {
  const { state } = input;
  if (state.plan === undefined) return;

  const base = buildWaveSnapshot(state.plan, {
    runId: input.runId,
    createdAt: state.waveCreatedAt,
    updatedAt: input.now(),
    overrides: state.overrides,
  });

  const snapshot: WaveSnapshot = {
    ...base,
    live_slots: state.liveSlots.map((slot) => ({
      worker_id: slot.worker_id,
      worker_index: slot.worker_index,
      task_id: slot.task_id,
      attempt: slot.attempt,
      started_at: slot.started_at,
      worktree_path: slot.worktree_path ?? "",
    })),
    ...(state.refillEpisode > 0
      ? {
          refill: {
            episodes: state.refillEpisode,
            decisions: state.refillLog.map((entry) => ({
              episode: entry.decision.episode,
              worker_id: entry.decision.worker_id,
              task_id: entry.decision.slot?.task_id ?? "",
              granted: entry.decision.slot !== undefined,
              reason: entry.decision.reason,
              // `hard-cap` atmetimai suskaičiuojami, o ne vardijami: jų būna po vieną kiekvienam
              // likusiam kandidatui, ir sąrašas nustelbtų tikrąsias atmetimo priežastis.
              rejected: entry.decision.rejected
                .filter((rejection) => rejection.reason !== "hard-cap")
                .map((rejection) => ({
                  task_id: rejection.task_id,
                  reason: rejection.reason,
                  detail: rejection.detail,
                })),
              hard_capped: entry.decision.rejected.filter((rejection) => rejection.reason === "hard-cap").length,
              episode_hash: entry.decision.episode_hash,
              decided_at: entry.decided_at,
            })),
          },
        }
      : {}),
  };

  const pool = state.poolPlan;
  if (pool === undefined || state.poolPlanWaveId !== state.plan.wave_id) {
    await input.writeSnapshot(snapshot);
    return;
  }

  await input.writeSnapshot({
    ...snapshot,
    worker_pool: {
      wave_id: state.poolPlanWaveId,
      mode: pool.mode,
      requested: pool.requested_workers,
      granted: pool.slots.length,
      max: pool.max_workers,
      rejected: pool.rejected,
      slots: pool.slots.map((slot) => ({
        worker_id: slot.worker_id,
        worker_index: slot.worker_index,
        task_id: slot.task_id,
        attempt: slot.attempt,
      })),
      plan_hash: pool.plan_hash,
    },
  });
}
