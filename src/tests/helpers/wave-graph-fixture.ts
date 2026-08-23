// Kanoninis grafas, atitinkantis bangos task sąrašą — bendras testų fixture'as.
//
// Nuo 2026-08-23 suvienodinimo `scheduleNextWave` be grafo neegzistuoja, tad kiekvienam bangos
// tvarkos testui reikia grafo, kuris NEPRIEŠTARAUJA jo task sąrašui. Statyti jį rankomis kiekvienoje
// vietoje reikštų dešimt progų suklysti tyliai: pasaulis, kuriame eilė ir grafas nesutampa, dabar
// duoda `gate:graph-state-mismatch`, ir testas kristų dėl fixture'o, o ne dėl tiriamos taisyklės.
//
// Todėl grafas VISADA išvedamas iš to paties sąrašo. Kas nori tyčinio nesutapimo, kuria grafą pats.
import { buildTaskGraph } from "../../domain/tasks/graph/index.js";
import type { TaskGraph, TaskNodeStatus } from "../../domain/tasks/graph/model.js";
import type { SchedulableTask } from "../../application/scheduling/index.js";

/** Task'ai, kurių mazgas turi kitą nei `queued` statusą (pvz. jau atlikti blokatoriai). */
export type WaveGraphFixtureOptions = {
  statuses?: Readonly<Record<string, TaskNodeStatus>>;
};

/**
 * Grafas iš bangos task sąrašo: tie patys ID, tie patys keliai, tos pačios briaunos.
 *
 * `checks` ir `scope` užpildomi, nes be jų `validateTaskGraph` duotų mazgo lygio pažeidimus, o
 * testo objektas yra tvarka, ne metaduomenų pilnumas.
 */
export function graphForTasks(tasks: readonly SchedulableTask[], options: WaveGraphFixtureOptions = {}): TaskGraph {
  const statuses = options.statuses ?? {};
  return buildTaskGraph({
    nodes: tasks.map((task) => {
      const status = statuses[task.task_id];
      return {
        task_id: task.task_id,
        file: task.file,
        checks: ["pnpm test"],
        scope: [`src/${task.task_id}.ts`],
        ...(task.blocked_by.length === 0 ? {} : { depends_on: [...task.blocked_by] }),
        ...(status === undefined ? {} : { status }),
      };
    }),
  });
}

/** `scheduleNextWave` įėjimas su savaime suderintu grafu. */
export function wavePlanInput<T extends { tasks: readonly SchedulableTask[] }>(
  input: T,
  options?: WaveGraphFixtureOptions,
): T & { graph: TaskGraph } {
  return { ...input, graph: graphForTasks(input.tasks, options) };
}
