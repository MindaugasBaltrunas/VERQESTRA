// Panašių taskų giminystės grupavimas ir token outlier'ių aptikimas (task 892/894).
// Elgesio etalonas: AG_loop orchestrator/learning/similar-task-analytics.ts (grynoji
// pusė). Pure agregacija — jokių kaštų metrikų ir jokių automatinių policy pakeitimų.

import { usageRecordTotalTokens, numericUsage, type LearningTaskEventRecord, type LearningUsageRecord } from "./usage-view.js";

/**
 * Kliento pusės `PhaseGroup` bucket'inimo veidrodis (ui-app tokenUsageViewModel) —
 * laikomas mažu nepriklausomu dublikatu, nes ui-app yra atskiras build taikinys, iš kurio
 * orchestratoriaus kodas importuoti negali.
 */
export type PhaseGroup = "preflight" | "dispatch" | "diagnose" | "fastpath" | "other";

export function canonicalPhaseGroup(phase: string): PhaseGroup {
  if (phase.endsWith("-fastpath") || phase.endsWith("-local")) return "fastpath";
  if (phase === "dispatch") return "dispatch";
  if (phase.startsWith("preflight")) return "preflight";
  if (phase.startsWith("diagnose")) return "diagnose";
  return "other";
}

// ---------------------------------------------------------------------------
// Family grouping
// ---------------------------------------------------------------------------

const LEADING_NUMBER = /^(\d+)/;
const STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "into", "onto", "that", "this", "task", "add", "fix",
  "update", "remaining", "non", "web", "api",
]);

function significantTokens(taskId: string): string[] {
  return taskId
    .toLowerCase()
    .replace(LEADING_NUMBER, "")
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 2 && !STOPWORDS.has(token));
}

/**
 * Deterministinis giminystės raktas vienam task_id: pradinis skaitinis prefiksas (dengia
 * split vaikus `-02-...`/`-03-...` ir repair re-dispatch'us, kurie visi išlaiko originalų
 * numerį) arba, be numerio, stabilus raktas iš reikšmingų pavadinimo tokenų.
 */
export function taskFamilyKey(taskId: string): string {
  const numberMatch = taskId.match(LEADING_NUMBER);
  if (numberMatch) return numberMatch[1]!;
  const tokens = significantTokens(taskId);
  return tokens.length > 0 ? tokens.slice(0, 4).join("-") : taskId;
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection += 1;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

const FAMILY_MERGE_JACCARD_THRESHOLD = 0.6;
const FAMILY_MERGE_MAX_GROUPS = 400;

export type TaskFamilyGroup = {
  familyKey: string;
  taskIds: string[];
  totalTokensByTask: Record<string, number>;
  totalRecords: number;
  totalTokens: number;
  medianTokens: number;
};

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2 : sorted[mid] ?? 0;
}

/**
 * Grupuoja token-usage įrašus pagal task giminystę. Du žingsniai:
 *  1. Pirminis grupavimas pagal `taskFamilyKey` (skaitinis prefiksas — dengia split
 *     vaikus ir repair re-dispatch'us).
 *  2. Antrinis merge tarp SKIRTINGŲ skaitinių prefiksų grupių, kurių reikšmingi
 *     pavadinimo tokenai stipriai persidengia (Jaccard >= 0.6) — būtent tai pagauna
 *     task'ą, atgeneruotą nauju numeriu vėlesnėje eilės kartoje. Virš
 *     `FAMILY_MERGE_MAX_GROUPS` grupių praleidžiama, kad O(n^2) porinis lyginimas
 *     liktų ribotas.
 */
export function groupTaskUsageByFamily(records: LearningUsageRecord[]): TaskFamilyGroup[] {
  const totalsByTask = new Map<string, number>();
  const recordsByTask = new Map<string, number>();
  for (const record of records) {
    totalsByTask.set(record.task_id, (totalsByTask.get(record.task_id) ?? 0) + usageRecordTotalTokens(record));
    recordsByTask.set(record.task_id, (recordsByTask.get(record.task_id) ?? 0) + 1);
  }

  const taskIds = [...totalsByTask.keys()];
  const primaryKeyByTask = new Map(taskIds.map((taskId) => [taskId, taskFamilyKey(taskId)]));

  const primaryGroups = new Map<string, string[]>();
  for (const taskId of taskIds) {
    const key = primaryKeyByTask.get(taskId)!;
    const bucket = primaryGroups.get(key);
    if (bucket) bucket.push(taskId);
    else primaryGroups.set(key, [taskId]);
  }

  const groupKeys = [...primaryGroups.keys()];
  const tokensByGroup = new Map<string, Set<string>>(
    groupKeys.map((key) => [
      key,
      new Set(primaryGroups.get(key)!.flatMap((taskId) => significantTokens(taskId))),
    ]),
  );

  // Union-find virš grupių raktų, jungiama pagal pavadinimo tokenų panašumą.
  const parent = new Map<string, string>(groupKeys.map((key) => [key, key]));
  function find(key: string): string {
    let root = key;
    while (parent.get(root) !== root) root = parent.get(root)!;
    parent.set(key, root);
    return root;
  }
  function union(a: string, b: string): void {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent.set(rootA, rootB);
  }

  if (groupKeys.length <= FAMILY_MERGE_MAX_GROUPS) {
    for (let i = 0; i < groupKeys.length; i += 1) {
      for (let j = i + 1; j < groupKeys.length; j += 1) {
        const keyA = groupKeys[i]!;
        const keyB = groupKeys[j]!;
        if (jaccardSimilarity(tokensByGroup.get(keyA)!, tokensByGroup.get(keyB)!) >= FAMILY_MERGE_JACCARD_THRESHOLD) {
          union(keyA, keyB);
        }
      }
    }
  }

  const mergedTaskIdsByRoot = new Map<string, string[]>();
  for (const key of groupKeys) {
    const root = find(key);
    const bucket = mergedTaskIdsByRoot.get(root);
    const taskIdsForKey = primaryGroups.get(key)!;
    if (bucket) bucket.push(...taskIdsForKey);
    else mergedTaskIdsByRoot.set(root, [...taskIdsForKey]);
  }

  const groups: TaskFamilyGroup[] = [];
  for (const mergedTaskIds of mergedTaskIdsByRoot.values()) {
    const sortedTaskIds = [...mergedTaskIds].sort();
    const totalTokensByTask: Record<string, number> = {};
    let totalRecords = 0;
    let totalTokens = 0;
    for (const taskId of sortedTaskIds) {
      const taskTotal = totalsByTask.get(taskId) ?? 0;
      totalTokensByTask[taskId] = taskTotal;
      totalRecords += recordsByTask.get(taskId) ?? 0;
      totalTokens += taskTotal;
    }
    // Deterministinis šeimos id: mažiausias skaitinis prefiksas, jei bent vienas task jį
    // turi, kitaip — leksikografiškai mažiausias task_id.
    const numericPrefixes = sortedTaskIds
      .map((taskId) => taskId.match(LEADING_NUMBER)?.[1])
      .filter((value): value is string => Boolean(value))
      .sort((a, b) => Number(a) - Number(b));
    const familyKey = numericPrefixes[0] ?? sortedTaskIds[0]!;

    groups.push({
      familyKey,
      taskIds: sortedTaskIds,
      totalTokensByTask,
      totalRecords,
      totalTokens,
      medianTokens: median(sortedTaskIds.map((taskId) => totalTokensByTask[taskId] ?? 0)),
    });
  }

  return groups.sort((a, b) => b.totalTokens - a.totalTokens || a.familyKey.localeCompare(b.familyKey));
}

// ---------------------------------------------------------------------------
// Optimization candidate detection
// ---------------------------------------------------------------------------

export type OptimizationCandidate = {
  taskId: string;
  familyKey: string;
  taskTokens: number;
  /**
   * KITŲ šeimos taskų mediana (šis task'as išimtas) — task'as lyginamas su bendraamžiais,
   * ne su savęs įskaitančia mediana. Su savimi mediana dviejų taskų šeimoje būtų jų
   * vidurkis ir multiplikatorius niekada nepasiektų 2x dažniausiame šeimos dydyje.
   */
  groupMedianTokens: number;
  multiplier: number;
  reasonHint: string;
};

/**
 * Task-events įrašų skaičius task_id'ui virš pirmojo — kiekvienas papildomas to paties
 * task'o perėjimas po pirmojo reiškia retry/repair iteraciją.
 */
export function repairCycleCountsByTask(taskEvents: readonly Pick<LearningTaskEventRecord, "task_id">[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const event of taskEvents) {
    counts.set(event.task_id, (counts.get(event.task_id) ?? 0) + 1);
  }
  const cycles = new Map<string, number>();
  for (const [taskId, count] of counts) cycles.set(taskId, Math.max(0, count - 1));
  return cycles;
}

const CACHE_CREATION_SHARE_THRESHOLD = 0.35;
const REPAIR_CYCLE_HINT_THRESHOLD = 2;

function candidateReasonHint(
  repairCycles: number,
  cacheCreationShare: number,
  hasLlmPreflight: boolean,
  multiplier: number,
): string {
  if (repairCycles >= REPAIR_CYCLE_HINT_THRESHOLD) {
    return `daug repair ciklų (${repairCycles})`;
  }
  if (cacheCreationShare > CACHE_CREATION_SHARE_THRESHOLD) {
    return `didelis cache creation (${Math.round(cacheCreationShare * 100)}%)`;
  }
  if (hasLlmPreflight) {
    return "LLM preflight vietoj fast-path";
  }
  return `viršija grupės medianą ${multiplier.toFixed(1)}x be aiškios priežasties`;
}

/**
 * Pažymi taskus, sudeginusius daugiau nei `thresholdMultiplier` kartų savo šeimos medianą.
 * Tik šeimos su >= 2 skirtingais taskais duoda prasmingą medianą, tad vieno tasko šeima
 * kandidato niekada neiškelia.
 */
export function detectOptimizationCandidates(
  groups: TaskFamilyGroup[],
  usageRecords: LearningUsageRecord[],
  taskEvents: LearningTaskEventRecord[],
  thresholdMultiplier = 2,
): OptimizationCandidate[] {
  const repairCycles = repairCycleCountsByTask(taskEvents);

  const cacheCreationByTask = new Map<string, number>();
  const llmPreflightByTask = new Set<string>();
  for (const record of usageRecords) {
    cacheCreationByTask.set(
      record.task_id,
      (cacheCreationByTask.get(record.task_id) ?? 0) + numericUsage(record.cache_creation_input_tokens),
    );
    if (record.phase === "preflight" && numericUsage(record.input_tokens) > 0) {
      llmPreflightByTask.add(record.task_id);
    }
  }

  const candidates: OptimizationCandidate[] = [];
  for (const group of groups) {
    if (group.taskIds.length < 2) continue;
    for (const taskId of group.taskIds) {
      const taskTokens = group.totalTokensByTask[taskId] ?? 0;
      const peerMedian = median(group.taskIds.filter((id) => id !== taskId).map((id) => group.totalTokensByTask[id] ?? 0));
      if (peerMedian <= 0) continue;
      const multiplier = taskTokens / peerMedian;
      if (multiplier <= thresholdMultiplier) continue;

      const cacheCreationShare = taskTokens > 0 ? (cacheCreationByTask.get(taskId) ?? 0) / taskTokens : 0;
      candidates.push({
        taskId,
        familyKey: group.familyKey,
        taskTokens,
        groupMedianTokens: peerMedian,
        multiplier,
        reasonHint: candidateReasonHint(
          repairCycles.get(taskId) ?? 0,
          cacheCreationShare,
          llmPreflightByTask.has(taskId),
          multiplier,
        ),
      });
    }
  }

  return candidates.sort((a, b) => b.multiplier - a.multiplier || a.taskId.localeCompare(b.taskId));
}
