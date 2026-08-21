// Grynos rollback taisyklės (etalonas: AG_loop orchestrator/git/rollback-scope.ts grynoji
// pusė, task 890, + interfaces/cli/rollback-stable resolveTaskScopedRollback). Faktų
// surinkimas prieš realų repo — infrastructure/git/rollback-scope.

import type { DirtyEntry } from "./changes.js";

export type PushedRollbackFacts = {
  head?: string;
  stableRef: string;
  branch: string;
  upstreamExists: boolean;
  totalCommitsSince: number;
  unpushedCommitsSince: number;
};

export type PushedRollbackDecision = { blocked: boolean; detail?: string };

/**
 * Grynas sprendimas: ar rollback iki `stableRef` paliestų commit'us, jau publikuotus
 * remote? Blokuoja, kai bent vienas `stableRef..HEAD` commit'as yra upstream'e
 * (`totalCommitsSince > unpushedCommitsSince`) — jau push'intas task commit'as niekada
 * neperrašomas. Be commit'intų pakeitimų nuo stable (`head === stableRef`, arba nėra
 * šakos/upstream) push'into darbo būti negali — niekada neblokuojama.
 */
export function pushedRollbackBlock(facts: PushedRollbackFacts): PushedRollbackDecision {
  if (!facts.head || facts.head === facts.stableRef) return { blocked: false };
  if (!facts.branch || !facts.upstreamExists) return { blocked: false };
  const pushed = facts.totalCommitsSince - facts.unpushedCommitsSince;
  if (facts.totalCommitsSince > 0 && pushed > 0) {
    return {
      blocked: true,
      detail: `${pushed}/${facts.totalCommitsSince} commit(s) since stable-ref already pushed to origin/${facts.branch}`,
    };
  }
  return { blocked: false };
}

export function isCommitSha(value: string): boolean {
  return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value);
}

/** Task'o startinė būsena (`vq/state/task-start-status.json`), kaip ją mato rollback sprendimas. */
export type TaskStartStatus = {
  task_id?: string;
  base_head?: string;
  baseline_valid?: boolean;
  git_status_code?: number;
  git_status_error?: string;
  non_runtime_dirty_entries?: DirtyEntry[];
};

export type TaskScopedRollbackDecision =
  | { ok: true; targetRef: string }
  | { ok: false; reason: string; snapshotBaseline?: boolean };

/**
 * Grynas task-scoped rollback sprendimas. Atstatymo taikinys yra paties task'o `base_head` —
 * būsena, nuo kurios task'as startavo — o NE globalus `stable-ref`: ankstesnis reikalavimas
 * `base_head === stable-ref` klaidingai blokuodavo kiekvieną rollback'ą po pirmo nesėkmingo
 * task'o nepertraukiamame run'e (stable-ref atsinaujina tik po sėkmės), palikdamas
 * `rollback_failed=1` triukšmą ir svetimos apimties failus kitam task'ui (2026-07-22 auditas,
 * punktas 6). Atstatymas į base_head pagal apibrėžimą grąžina task'o liestus failus į jų
 * prieš-task'inę būseną, nepriklausomai nuo to, kur tuo metu stovi stable-ref.
 *
 * Prieš task'ą jau egzistavę ne-runtime pakeitimai blokuoja: jie nėra šio task'o darbas, tad
 * jų atstatymas į base_head sunaikintų svetimą, niekieno neprašytą pakeitimą.
 */
export function resolveTaskScopedRollback(
  taskStartStatus: TaskStartStatus,
  taskId: string | undefined,
): TaskScopedRollbackDecision {
  if (!taskId) {
    return { ok: false, reason: "--allow-task-changes requires --task-id <id>" };
  }
  if (!taskStartStatus.baseline_valid || !taskStartStatus.task_id || taskStartStatus.task_id !== taskId) {
    const reason = !taskStartStatus.baseline_valid
      ? `baseline_valid=${String(taskStartStatus.baseline_valid)} git_status_code=${taskStartStatus.git_status_code ?? "unknown"}`
      : `baseline_task=${taskStartStatus.task_id ?? "none"}`;
    const detail = taskStartStatus.git_status_error ? ` error=${taskStartStatus.git_status_error}` : "";
    return { ok: false, reason: `invalid task baseline for task=${taskId} ${reason}${detail}` };
  }
  if (!taskStartStatus.base_head) {
    return { ok: false, reason: `no base_head recorded for task=${taskId}` };
  }

  const baselineDirtyEntries = taskStartStatus.non_runtime_dirty_entries ?? [];
  if (baselineDirtyEntries.length > 0) {
    const files = baselineDirtyEntries.map((entry) => `${entry.status} ${entry.path}`).join(", ");
    return {
      ok: false,
      reason: `non-runtime changes existed before task start. Baseline files: ${files}`,
      snapshotBaseline: true,
    };
  }

  return { ok: true, targetRef: taskStartStatus.base_head };
}
