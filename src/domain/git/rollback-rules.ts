// Grynos rollback taisyklės (etalonas: AG_loop orchestrator/git/rollback-scope.ts grynoji
// pusė, task 890, + interfaces/cli/rollback-stable resolveTaskScopedRollback). Faktų
// surinkimas prieš realų repo — infrastructure/git/rollback-scope.

import { nonRuntimeDirtyEntriesFromStatus, type DirtyEntry } from "./changes.js";

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

/**
 * Pilnas įrašas, kokį jį PRIVALO parašyti gamintojas: visi laukai, kurių ieško
 * {@link resolveTaskScopedRollback}, yra privalomi, tad jų praleisti nebeįmanoma.
 */
export type TaskStartStatusRecord = {
  task_id: string;
  base_head: string;
  started_at: string;
  baseline_valid: boolean;
  git_status_code: number;
  non_runtime_dirty_entries: DirtyEntry[];
  /** Tik negaliojančiam baseline'ui: blokavimo priežastis keliauja į operatoriaus žurnalą. */
  git_status_error?: string;
};

export type BuildTaskStartStatusInput = {
  taskId: string;
  baseHead: string;
  startedAt: string;
  /** `git status --porcelain` išvestis; `undefined` reiškia, kad git NEATSAKĖ. */
  gitStatus: string | undefined;
};

/**
 * Task'o startinės būsenos VIENINTELIS gamintojas.
 *
 * Egzistuoja tam, kad gamintojas ir vartotojas nebegalėtų prasilenkti. Iki 2026-08-24 įrašą
 * inline'u dėliojo `composition/loop/coordinator-adapters` iš trijų laukų (`task_id`, `base_head`,
 * `started_at`), o {@link resolveTaskScopedRollback} reikalauja `baseline_valid === true`.
 * Rezultatas buvo determinuotas: KIEKVIENAS task-scoped rollback blokuotas su
 * `invalid task baseline … baseline_valid=undefined`, nė vieno kritusio task'o darbas neatsuktas, o
 * jo necommit'inti pakeitimai likdavo kito task'o baseline'e ir stabdydavo loop'ą ties „dirty
 * product tree". Pati taisyklė buvo padengta testais — su ranka sukonstruota fikstūra, kurios
 * formos realus gamintojas niekada nesukūrė; nepadengtas buvo SUJUNGIMAS.
 *
 * Status KODAS yra sprendimo dalis, o ne detalė: tuščias tekstas su atsakymu reiškia švarų medį,
 * o atsakymo NEBUVIMAS reiškia „git neatsakė". Sulieti juos reikštų, kad nepavykusi patikra
 * atrodo kaip švarus medis, ir rollback atsuktų į bazę, kurios niekas nepatvirtino.
 */
export function buildTaskStartStatus(input: BuildTaskStartStatusInput): TaskStartStatusRecord {
  const identity = { task_id: input.taskId, base_head: input.baseHead, started_at: input.startedAt };
  const status = input.gitStatus;
  if (status === undefined) {
    return {
      ...identity,
      baseline_valid: false,
      git_status_code: 1,
      non_runtime_dirty_entries: [{ status: "!!", path: "<git status failed>" }],
      git_status_error: "git status failed",
    };
  }
  return {
    ...identity,
    baseline_valid: true,
    git_status_code: 0,
    non_runtime_dirty_entries: nonRuntimeDirtyEntriesFromStatus(status),
  };
}

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
