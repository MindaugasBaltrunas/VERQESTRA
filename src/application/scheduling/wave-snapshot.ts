// Bangos SNAPSHOT'as: planas plius vykdymo būsena, kurios planas nežino (etalonas: AG_loop
// core/schema.ts wave snapshot schemos + loop/task-state.ts `buildWaveSnapshot`).
//
// Skirtumas tarp plano ir snapshot'o yra visa šio modulio prasmė:
//   - PLANAS atsako „kas GALI būti vykdoma" — jis grynas ir perskaičiuojamas bet kada;
//   - SNAPSHOT'as atsako „kas IŠ TIKRŲJŲ vyko" — jame lieka ir jau užversti task'ai, todėl po
//     restart'o matyti, kas šioje bangoje jau buvo priimta.
// Sulieti juos reikštų, kad perskaičiuotas planas ištrina bangos istoriją.
//
// Schema `looseObject` sąmoningai: jau diske gulintys snapshot'ai be vėliau pridėtų laukų
// privalo likti validūs, kitaip loop'as po atnaujinimo prarastų bangos tęstinumą.

import { z } from "zod";
import type { WavePlan } from "./schedule-next-wave.js";

export const WAVE_SNAPSHOT_SCHEMA_VERSION = 1;

/**
 * Task'o būsena bangoje. `running` įrašų negali būti daugiau nei `max_workers` — tai worker
 * pool'o išduotų slot'ų atspindys duomenyse.
 */
export const waveTaskStateSchema = z.enum(["ready", "blocked", "running", "done", "failed"]);
export type WaveTaskState = z.infer<typeof waveTaskStateSchema>;

const nonEmpty = z.string().min(1);
const stringList = z.array(z.string());

export const waveTaskSnapshotSchema = z.looseObject({
  task_id: nonEmpty,
  file: nonEmpty,
  state: waveTaskStateSchema,
  blocked_by: stringList.default([]),
  /** `branch-blocked | unsatisfied-dependency | dependency-cycle` arba vykdymo priežastis. */
  reason: z.string().optional(),
  waiting_for: stringList.default([]),
  attempts: z.number().int().nonnegative().default(0),
});
export type WaveTaskSnapshot = z.infer<typeof waveTaskSnapshotSchema>;

export const waveSnapshotSchema = z.looseObject({
  schema_version: z.number().int().positive().default(WAVE_SNAPSHOT_SCHEMA_VERSION),
  scheduler_version: z.number().int().positive().default(1),
  run_id: nonEmpty,
  wave_id: nonEmpty,
  wave_sequence: z.number().int().positive().default(1),
  /** Grafo atspaudas. Nesutapimas su checkpoint'o hash'u reiškia stale checkpoint'ą. */
  graph_hash: nonEmpty,
  /**
   * Sprendimo atspaudas (2026-08-23). Numatytoji reikšmė TUŠČIA sąmoningai: senas snapshot'as
   * jo neturi, tad su jokiu einamuoju sprendimu nesutaps ir bus laikomas svetimu — fail-closed.
   * Tylus „sutampa" čia būtų blogiausia galima numatytoji reikšmė.
   */
  decision_hash: z.string().default(""),
  /**
   * Hard limitas: daugiau nei 2 yra NEGALIOJANTIS įrašas, o ne tyliai priimtas paralelizmas.
   * Sprendimą „kiek workerių" priima `worker-pool-plan` su visais izoliacijos vartais; schema
   * tik neleidžia jo peržengti nepastebimai.
   */
  max_workers: z.number().int().min(1).max(2).default(1),
  created_at: nonEmpty,
  updated_at: nonEmpty,
  tasks: z.array(waveTaskSnapshotSchema).default([]),
  external_dependencies: stringList.default([]),
  cycles: z.array(stringList).default([]),
  /** Paskutinio pool'o plano santrauka — TIK ataskaita operatoriui, ne sprendimas. */
  worker_pool: z
    .looseObject({
      /** Kuriai bangai santrauka priklauso: pool'o planas gyvuoja ilgiau nei viena banga. */
      wave_id: nonEmpty,
      mode: nonEmpty,
      requested: z.number().int().positive(),
      granted: z.number().int().nonnegative(),
      max: z.number().int().positive(),
      rejected: z
        .array(z.looseObject({ task_id: nonEmpty, reason: nonEmpty, detail: z.string().default("") }))
        .default([]),
      slots: z
        .array(
          z.looseObject({
            worker_id: nonEmpty,
            worker_index: z.number().int().positive(),
            task_id: nonEmpty,
            attempt: z.number().int().positive(),
          }),
        )
        .default([]),
      plan_hash: nonEmpty,
    })
    .optional(),
  live_slots: z
    .array(
      z.looseObject({
        worker_id: nonEmpty,
        worker_index: z.number().int().positive(),
        task_id: nonEmpty,
        attempt: z.number().int().positive(),
        started_at: z.string().default(""),
        worktree_path: z.string().default(""),
      }),
    )
    .default([]),
  /** Papildymo epizodai: naujausi gale. */
  refill: z
    .looseObject({
      episodes: z.number().int().nonnegative().default(0),
      decisions: z
        .array(
          z.looseObject({
            episode: z.number().int().positive(),
            worker_id: nonEmpty,
            /** `""` reiškia „papildymo nebuvo" — atskiriama nuo praleisto lauko. */
            task_id: z.string().default(""),
            granted: z.boolean().default(false),
            reason: z.string().default(""),
            rejected: z
              .array(z.looseObject({ task_id: nonEmpty, reason: nonEmpty, detail: z.string().default("") }))
              .default([]),
            /** Kiek kandidatų atmesta VIEN dėl užpildyto limito. */
            hard_capped: z.number().int().nonnegative().default(0),
            episode_hash: nonEmpty,
            decided_at: z.string().default(""),
          }),
        )
        .default([]),
    })
    .optional(),
});
export type WaveSnapshot = z.infer<typeof waveSnapshotSchema>;

/**
 * Vykdymo būsena, kurios PLANAS nežino. Įrašas, kurio nebėra plane (task'as jau paliko eilę), į
 * snapshot'ą patenka tik su `file` reikšme — be jos nebūtų ką rodyti.
 */
export type WaveTaskStateOverride = { state: WaveTaskState; reason?: string; attempts?: number; file?: string };
export type WaveTaskStateOverrides = ReadonlyMap<string, WaveTaskStateOverride>;

export type BuildWaveSnapshotOptions = {
  runId: string;
  createdAt: string;
  updatedAt?: string;
  overrides?: WaveTaskStateOverrides;
};

/**
 * `WavePlan` + vykdymo override'ai → persistuojamas snapshot'as.
 *
 * Rūšiavimas pagal `file` yra KONTRAKTAS, ne kosmetika: snapshot'as lyginamas tarp ratų, ir
 * nestabili tvarka kiekvieną perrašymą paverstų „pokyčiu" — UI srautas transliuotų įvykius,
 * kurių nebuvo.
 */
export function buildWaveSnapshot(plan: WavePlan, options: BuildWaveSnapshotOptions): WaveSnapshot {
  const overrides = options.overrides ?? new Map<string, WaveTaskStateOverride>();

  const planTasks: WaveTaskSnapshot[] = [
    ...plan.ready.map((task) => ({
      task_id: task.task_id,
      file: task.file,
      state: "ready" as const,
      blocked_by: [...task.blocked_by],
      waiting_for: [],
      attempts: 0,
    })),
    ...plan.blocked.map((task) => ({
      task_id: task.task_id,
      file: task.file,
      state: "blocked" as const,
      blocked_by: [...task.blocked_by],
      reason: task.reason,
      waiting_for: [...task.waiting_for],
      attempts: 0,
    })),
  ];

  const byId = new Map<string, WaveTaskSnapshot>();
  for (const task of planTasks) {
    const override = overrides.get(task.task_id);
    if (override === undefined) {
      byId.set(task.task_id, task);
      continue;
    }
    // Override'o priežastis nugali plano priežastį, bet jos NEBUVIMAS plano priežasties
    // neištrina: „running" įrašas neturi savo priežasties, o task'as vis dar gali būti
    // pažymėtas kaip anksčiau blokuotas.
    const reason = override.reason ?? task.reason;
    byId.set(task.task_id, {
      ...task,
      state: override.state,
      ...(reason === undefined ? {} : { reason }),
      attempts: override.attempts ?? task.attempts,
    });
  }

  // Override'ai be plano įrašo: task'as jau paliko eilę, bet jo baigtis yra bangos istorijos
  // dalis. Be `file` jo pridėti negalime — snapshot'o įrašas be kelio nieko nepasako.
  for (const [taskId, override] of overrides) {
    if (byId.has(taskId) || override.file === undefined) continue;
    byId.set(taskId, {
      task_id: taskId,
      file: override.file,
      state: override.state,
      blocked_by: [],
      ...(override.reason === undefined ? {} : { reason: override.reason }),
      waiting_for: [],
      attempts: override.attempts ?? 0,
    });
  }

  const tasks = [...byId.values()].sort((a, b) => a.file.localeCompare(b.file));

  return waveSnapshotSchema.parse({
    schema_version: WAVE_SNAPSHOT_SCHEMA_VERSION,
    scheduler_version: plan.scheduler_version,
    run_id: options.runId,
    wave_id: plan.wave_id,
    wave_sequence: plan.wave_sequence,
    graph_hash: plan.graph_hash,
    decision_hash: plan.decision_hash,
    max_workers: plan.max_workers,
    created_at: options.createdAt,
    updated_at: options.updatedAt ?? options.createdAt,
    tasks,
    external_dependencies: [...plan.external_dependencies],
    cycles: plan.cycles.map((cycle) => [...cycle]),
  });
}
