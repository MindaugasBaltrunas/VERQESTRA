// Attempt-scoped cohort join — skaitymo pusė (etalono task 0046, WBR VQ-305): context-size ir
// token-usage žurnalai nuo 0045 neša tą pačią run_id/worker_id/runtime_attempt_id tapatybę.
// Iki šio modulio cohort'ai jungė abu žurnalus vien per task_id — retried task'o bandymams
// patekus į skirtingus arm'us usage tyliai susilietų. Čia atribucija koreguojama: task_id,
// kurio context-size įrašai įrodo daugiau nei vieną bandymą, usage skaičiuoja tik kai jo
// paties tapatybė atitinka TĄ PATĮ bandymą, kuris nusprendė arm'ą; visa kita atidedama kaip
// `legacy`, o ne spėjama.
//
// Apimtis: koreguojama TIK usage ATRIBUCIJA. Kuriam arm'ui task_id apskritai priklauso —
// 0034/0037 politika, čia nekeičiama: task'as išlaiko arm'ą, kurį priskyrė jo VĖLIAUSIAS
// context-size įrašas.

import { CANARY_SIZE_FALLBACK_MARKER } from "../context-pack/metrics.js";
import type {
  AppliedArm,
  AssignmentArm,
  CohortContextSizeRecord,
  CohortTokenUsageRecord,
} from "./cohort-model.js";

/** Keturi laukai, VISI privalomi ir netušti, kad įrašas būtų priskirtas vienam bandymui. */
export type AttemptIdentityFields = {
  task_id?: string;
  run_id?: string;
  worker_id?: string;
  runtime_attempt_id?: string;
};

function trimmedOrEmpty(value: string | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Lokali `compression-cohorts.ts` `taskIdOf` kopija — privati, kad šis modulis neturėtų
 *  value-level importo atgal į failą, kuris jį importuoja (tik type-only aukščiau). */
function taskIdOf(record: { task_id?: unknown }): string {
  return typeof record.task_id === "string" ? record.task_id.trim() : "";
}

/** Lokali `timeMs` kopija; žr. {@link taskIdOf}. */
function timeMs(ts: string | undefined): number {
  const parsed = Date.parse(ts ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Lokali `normalizeFeatures` kopija; žr. {@link taskIdOf}. */
function normalizeFeatures(features: readonly string[] | undefined): readonly string[] {
  if (!Array.isArray(features)) return [];
  return features
    .filter((feature): feature is string => typeof feature === "string")
    .map((feature) => feature.trim())
    .filter((feature) => feature.length > 0);
}

function numeric(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * `null`, kai trūksta bent vieno iš run_id/worker_id/task_id/runtime_attempt_id — toks
 * įrašas negali būti priskirtas konkrečiam bandymui ir pagal apibrėžimą yra legacy.
 */
export function attemptIdentityKey(record: AttemptIdentityFields): string | null {
  const taskId = trimmedOrEmpty(record.task_id);
  const runId = trimmedOrEmpty(record.run_id);
  const workerId = trimmedOrEmpty(record.worker_id);
  const attemptId = trimmedOrEmpty(record.runtime_attempt_id);
  if (!taskId || !runId || !workerId || !attemptId) return null;
  return `${runId}${workerId}${taskId}${attemptId}`;
}

export type AttemptScopedSplit<T> = {
  /** Records with full identity, grouped by their attempt key. */
  byAttempt: Map<string, T[]>;
  /** Records missing at least one identity field. Never folded into an attempt group. */
  legacy: T[];
};

/** Generinis tapatybės skirstymas — primityvas, ant kurio pastatytas `joinAttemptScopedCohort`. */
export function splitByAttemptIdentity<T extends AttemptIdentityFields>(
  records: readonly T[],
): AttemptScopedSplit<T> {
  const byAttempt = new Map<string, T[]>();
  const legacy: T[] = [];
  for (const record of records) {
    const key = attemptIdentityKey(record);
    if (key === null) {
      legacy.push(record);
      continue;
    }
    const bucket = byAttempt.get(key);
    if (bucket) bucket.push(record);
    else byAttempt.set(key, [record]);
  }
  return { byAttempt, legacy };
}

/**
 * Žalią `canary_features` masyvą skaido į assignment/applied arm — fallback markeris
 * nuimamas PRIEŠ sprendžiant „canary".
 */
function classifyArms(rawFeatures: readonly string[]): {
  assignmentArm: AssignmentArm;
  appliedArm: AppliedArm;
  features: readonly string[];
} {
  const hasFallbackMarker = rawFeatures.includes(CANARY_SIZE_FALLBACK_MARKER);
  const features = rawFeatures.filter((feature) => feature !== CANARY_SIZE_FALLBACK_MARKER);
  const assignmentArm: AssignmentArm = features.length > 0 ? "canary" : "control";
  const appliedArm: AppliedArm =
    assignmentArm === "control" ? "control" : hasFallbackMarker ? "raw-fallback" : "compressed";
  return { assignmentArm, appliedArm, features };
}

export type ArmAssignment = {
  assignmentArm: AssignmentArm;
  appliedArm: AppliedArm;
  /** Tik realūs feature vardai — {@link CANARY_SIZE_FALLBACK_MARKER} nuimtas `classifyArms`. */
  features: readonly string[];
  dispatchCount: number;
  latestMs: number;
};

/**
 * Vienas arm assignment per TASK'Ą, ne per įrašą: retried/re-dispatched task'as rašo kelis
 * context-size įrašus ir jo canary narystė tarp jų gali skirtis — laimi VĖLIAUSIAS įrašas,
 * nes jis aprašo pack'ą, po kurio gimė galutinė task'o baigtis (0034 politika).
 */
export function assignArms(records: readonly CohortContextSizeRecord[]): Map<string, ArmAssignment> {
  const byTask = new Map<string, ArmAssignment>();
  for (const record of records) {
    const taskId = taskIdOf(record);
    if (!taskId) continue;
    const classified = classifyArms(normalizeFeatures(record.canary_features));
    const at = timeMs(record.ts);
    const current = byTask.get(taskId);
    if (!current) {
      byTask.set(taskId, { ...classified, dispatchCount: 1, latestMs: at });
      continue;
    }
    current.dispatchCount += 1;
    if (at >= current.latestMs) {
      current.assignmentArm = classified.assignmentArm;
      current.appliedArm = classified.appliedArm;
      current.features = classified.features;
      current.latestMs = at;
    }
  }
  return byTask;
}

export type TaskUsage = {
  billableTokens: number;
  turns: number;
  /** Bent vienas įrašas nešė realų `num_turns`; task'as be jo NĖRA nulio turn'ų task'as. */
  turnsMeasured: boolean;
  records: number;
  repaired: boolean;
};

/**
 * Repair įrodymas trimis formomis, kurias telemetrija realiai neša: antras bandymas,
 * užfiksuota retry priežastis arba kanoninė `repair` fazė.
 */
function isRepairRecord(record: CohortTokenUsageRecord): boolean {
  return (record.attempt ?? 1) > 1
    || (record.retry_reason ?? "").trim().length > 0
    || record.task_phase === "repair";
}

/**
 * Per-task usage, susumuota per VISUS task'o įrašus. `joinAttemptScopedCohort` ją kviečia ir
 * pradiniam (task_id) pass'ui, ir vieno ambiguous task'o perskaičiavimui iš tapatybe
 * patvirtinto poaibio.
 */
export function summarizeUsageByTask(records: readonly CohortTokenUsageRecord[]): Map<string, TaskUsage> {
  const byTask = new Map<string, TaskUsage>();
  for (const record of records) {
    const taskId = taskIdOf(record);
    if (!taskId) continue;
    const current = byTask.get(taskId)
      ?? { billableTokens: 0, turns: 0, turnsMeasured: false, records: 0, repaired: false };
    current.records += 1;
    current.billableTokens += numeric(record.input_tokens)
      + numeric(record.output_tokens)
      + numeric(record.cache_creation_input_tokens);
    if (typeof record.num_turns === "number" && Number.isFinite(record.num_turns)) {
      current.turns += record.num_turns;
      current.turnsMeasured = true;
    }
    if (isRepairRecord(record)) current.repaired = true;
    byTask.set(taskId, current);
  }
  return byTask;
}

export type LegacyAttemptGroup = {
  /** Skirtingi task_id, kur bent vienas usage įrašas atmestas, nes task'as turi >1 bandymo
   *  tapatybę, o įrašo nepavyko priskirti laimėjusiam bandymui. */
  n: number;
  /** Usage įrašai, atidėti vietoje spėjimo į arm'ą. */
  excludedUsageRecords: number;
};

/** task_id -> jo skirtingi bandymų raktai, skaitomi TIK iš context-size pusės: būtent ji
 *  sprendžia, kiek kandidatinių arm'ų task'as realiai turi. */
function contextIdentityKeysByTask(
  records: readonly CohortContextSizeRecord[],
): Map<string, Set<string>> {
  const byTask = new Map<string, Set<string>>();
  for (const record of records) {
    const key = attemptIdentityKey(record);
    if (key === null) continue;
    const taskId = taskIdOf(record);
    const set = byTask.get(taskId) ?? new Set<string>();
    set.add(key);
    byTask.set(taskId, set);
  }
  return byTask;
}

/** Kurį assignment arm kiekvienas tapatybės raktas išsprendžia — latest-wins kaip
 *  {@link assignArms}, bet vieno task'o jau atfiltruotoje aibėje. */
function assignmentArmByKey(records: readonly CohortContextSizeRecord[]): Map<string, AssignmentArm> {
  const latestByKey = new Map<string, { arm: AssignmentArm; at: number }>();
  for (const record of records) {
    const key = attemptIdentityKey(record);
    if (key === null) continue;
    const { assignmentArm } = classifyArms(normalizeFeatures(record.canary_features));
    const at = timeMs(record.ts);
    const current = latestByKey.get(key);
    if (!current || at >= current.at) latestByKey.set(key, { arm: assignmentArm, at });
  }
  return new Map([...latestByKey].map(([key, value]) => [key, value.arm]));
}

/**
 * Perrašo `usageByTask` vietoje kiekvienam task_id, kurio context-size įrašai įrodo daugiau
 * nei vieną bandymą: usage įrašas skaičiuoja tik kai jo paties tapatybė išsprendžia TĄ PATĮ
 * arm'ą, kurį task'as gavo. Visa kita — wrong-attempt ir identity-less usage — atmetama ir
 * suskaičiuojama į {@link LegacyAttemptGroup}, o ne tyliai lieka laimėjusiame arm'e.
 */
function correctAmbiguousTasks(
  assignments: ReadonlyMap<string, ArmAssignment>,
  usageByTask: Map<string, TaskUsage>,
  contextSizeRecords: readonly CohortContextSizeRecord[],
  tokenUsageRecords: readonly CohortTokenUsageRecord[],
): LegacyAttemptGroup {
  const keysByTask = contextIdentityKeysByTask(contextSizeRecords);
  const ambiguousTaskIds = [...keysByTask].filter(([, keys]) => keys.size > 1).map(([taskId]) => taskId);
  if (ambiguousTaskIds.length === 0) return { n: 0, excludedUsageRecords: 0 };

  const usageByTaskId = new Map<string, CohortTokenUsageRecord[]>();
  for (const record of tokenUsageRecords) {
    const taskId = taskIdOf(record);
    if (!taskId) continue;
    const bucket = usageByTaskId.get(taskId);
    if (bucket) bucket.push(record);
    else usageByTaskId.set(taskId, [record]);
  }

  let legacyTasks = 0;
  let excludedUsageRecords = 0;
  for (const taskId of ambiguousTaskIds) {
    const assignment = assignments.get(taskId);
    const allUsageForTask = usageByTaskId.get(taskId) ?? [];
    if (!assignment || allUsageForTask.length === 0) continue;

    const taskContextRecords = contextSizeRecords.filter((record) => taskIdOf(record) === taskId);
    const armByKey = assignmentArmByKey(taskContextRecords);

    const kept: CohortTokenUsageRecord[] = [];
    let excludedForTask = 0;
    for (const record of allUsageForTask) {
      const key = attemptIdentityKey(record);
      const resolvedArm = key === null ? undefined : armByKey.get(key);
      if (resolvedArm === assignment.assignmentArm) kept.push(record);
      else excludedForTask += 1;
    }

    if (excludedForTask === 0) continue;
    legacyTasks += 1;
    excludedUsageRecords += excludedForTask;

    if (kept.length === 0) {
      usageByTask.delete(taskId);
      continue;
    }
    const recomputed = summarizeUsageByTask(kept).get(taskId);
    if (recomputed) usageByTask.set(taskId, recomputed);
  }

  return { n: legacyTasks, excludedUsageRecords };
}

export type AttemptScopedCohortJoin = {
  assignments: Map<string, ArmAssignment>;
  usageByTask: Map<string, TaskUsage>;
  legacy: LegacyAttemptGroup;
};

/**
 * Pilnas skaitymo pusės join'as `compression-cohorts.ts`: task lygio arm assignment
 * (nepakitusi 0034 politika) + usage atribucija, pakoreguota kiekvienam task_id su >1
 * bandymo tapatybe. Task'as su daugiausiai viena tapatybe (įskaitant VISUS pre-0045 įrašus)
 * gauna lygiai tą patį task_id join'ą kaip visada — nėra ko disambiguuoti.
 */
export function joinAttemptScopedCohort(
  contextSizeRecords: readonly CohortContextSizeRecord[],
  tokenUsageRecords: readonly CohortTokenUsageRecord[],
): AttemptScopedCohortJoin {
  const assignments = assignArms(contextSizeRecords);
  const usageByTask = summarizeUsageByTask(tokenUsageRecords);
  const legacy = correctAmbiguousTasks(assignments, usageByTask, contextSizeRecords, tokenUsageRecords);
  return { assignments, usageByTask, legacy };
}
