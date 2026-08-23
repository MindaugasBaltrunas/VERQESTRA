// Retry skaitiklių mutacijos taisyklės ir store portas (etalonas: AG_loop interfaces/cli/
// retry-guard/index.ts skaitiklių pusė — applyRetryCountUpdate/incrementTaskRetryCount;
// perkeltos į application pagal E5 WBR, nes jas vartoja ir retry-guard CLI, ir
// retry-repair kompozicija). Pati limito taisyklė — domain/tasks/retry.ts.

// Sankcionuotas interfaces → application → domain tiltas (tas pats šablonas kaip
// evaluateRepeatedErrorEscalation retry-repair.ts): retry-guard CLI limito taisyklę ima
// per šį modulį, ne tiesiogiai iš domain/tasks.
export { DEFAULT_MAX_RETRY_ATTEMPTS, evaluateRetryLimit, normalizeMaxRetryAttempts } from "../../domain/tasks/index.js";

export type RetryCountUpdate = {
  taskKey: string;
  errorKey: string;
  taskCount: number;
  errorCount: number;
};

/**
 * Supervisor `decision.json` forma, kurią vartoja retry-guard kelias. STRUKTŪRINĖ kopija
 * (ne importas iš infrastructure claude-decision) — application sluoksnis neįgyja importo
 * į adapterį, o abu tipai lieka suderinami per formą (tas pats sprendimas kaip
 * run-coordinator-ports.ts).
 */
export type SupervisorRetryDecision = {
  verdict?: string;
  task_id?: string;
  retry_key?: string;
  error_signature?: string;
};

function finiteCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

// State schema v2 migracija: pre-v2 `<taskId>[:error]` skaitikliai suglaudinami vieną
// kartą ir pašalinami (etalono migrateLegacyTaskRetryCount 1:1).
function migrateLegacyTaskRetryCount(retryCounts: Record<string, number>, taskId: string, taskKey: string): number {
  const legacyKeys = Object.keys(retryCounts).filter((key) => key === taskId || key.startsWith(`${taskId}:`));
  const legacyCount = legacyKeys.reduce((sum, key) => sum + finiteCount(retryCounts[key]), 0);
  for (const key of legacyKeys) delete retryCounts[key];
  return Math.max(finiteCount(retryCounts[taskKey]), legacyCount);
}

/** GRYNA skaitiklių mutacija: task ir error skaitikliai +1, legacy raktai sugeriami. */
export function applyRetryCountUpdate(
  retryCounts: Record<string, number>,
  taskId: string,
  retryKey: string,
): RetryCountUpdate {
  const taskKey = `task:${taskId}`;
  const errorKey = `error:${retryKey}`;
  const currentTaskCount = migrateLegacyTaskRetryCount(retryCounts, taskId, taskKey);
  const taskCount = currentTaskCount + 1;
  const errorCount = finiteCount(retryCounts[errorKey]) + 1;

  retryCounts[taskKey] = taskCount;
  retryCounts[errorKey] = errorCount;

  return { taskKey, errorKey, taskCount, errorCount };
}

/**
 * Retry skaitiklių failo (`vq/state/retry-counts.json`) store portas. `read` sugadintam
 * JSON meta klaidą (etalono readJsonOrThrowIfCorrupted semantika); `write` — atominis.
 */
export type RetryCountsStorePort = {
  read(): Promise<Record<string, number>>;
  /**
   * SERIALIZUOTAS read-modify-write (2026-08-23, operatoriaus radinys).
   *
   * Anksčiau portas turėjo atskirą `write`, ir `incrementTaskRetryCount` darydavo
   * `read()` → mutacija → `write()` be jokio užrakto. Du lygiagretūs inkrementai perskaitydavo tą
   * pačią reikšmę ir vienas kito rezultatą perrašydavo — prarastas inkrementas reiškia, kad retry
   * limitas leidžia DAUGIAU bandymų, nei nustatyta, o tai fail-open ant saugos ribos.
   *
   * Mutacija gauna žemėlapį, jį keičia vietoje ir grąžina savo rezultatą; saugykla persist'ina
   * pakeistą būseną neatlaisvinusi užrakto.
   */
  update<T>(mutate: (counts: Record<string, number>) => T): Promise<T>;
};

/**
 * Perskaito skaitiklius, pritaiko {@link applyRetryCountUpdate} ir persist'ina. Tas pats
 * kelias tarnauja ir retry-guard CLI, ir `RetryRepairPorts.incrementRetryCount` adapteriui.
 */
export async function incrementTaskRetryCount(
  store: RetryCountsStorePort,
  taskId: string,
  retryKey: string,
): Promise<RetryCountUpdate> {
  // Skaitymas ir rašymas VIENAME serializuotame žingsnyje: atskiri `read`/`write` kvietimai
  // lygiagrečiuose procesuose prarasdavo inkrementą (žr. `RetryCountsStorePort.update`).
  return await store.update((retryCounts) => applyRetryCountUpdate(retryCounts, taskId, retryKey));
}
