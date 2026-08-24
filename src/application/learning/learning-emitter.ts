// Automatinis learning-memory maitinimas iš task gyvavimo ciklo (etalonas: AG_loop
// orchestrator/learning/learning-emitter.ts, 2026-07-07). Iki jo learning žurnalas
// pildėsi TIK rankiniu `ag learning record`, todėl UI „Mokymosi rekomendacijos" po ~885
// done taskų vis dar rodė tuščią būseną — klasikinė „declared but not fed" spraga.
// Emiteris kabinasi ant task perėjimų piltuvo (per jį eina visi done/human-review/error/
// failed perėjimai) ir rašo:
//   - task_outcome      — kiekvienam galutiniam perėjimui;
//   - failure_pattern   — kiekvienai nesėkmei, su normalizuotu parašu label'e;
//   - policy_recommendation (pending) — kai TAS PATS parašas susikaupia
//     failurePatternRecommendationThreshold kartų (rekomendacija tik siūloma — taikymas
//     lieka žmogaus approve).
// Best-effort kontraktas: emisijos klaida niekada negali nutraukti task apdorojimo.

import { ANALYTICS_SNAPSHOT_STATES, type TaskEvent } from "../task-execution/task-events-model.js";
import { appendLearningMemoryRecord, readLearningMemoryRecords } from "./learning-memory.js";
import type { LearningFsPort } from "./ports.js";

// Terminaliniai perėjimai imami iš `ANALYTICS_SNAPSHOT_STATES` — VIENO šaltinio (2026-08-24,
// operatoriaus radinys). Iki tol čia gulėjo pažodinė to paties rinkinio kopija, o eksportuotoji
// konstanta neturėjo nė vieno vartotojo: ta pati taisyklė dviem egzemplioriais, ir būtent tokia
// pora išsiskiria tyliai — emiteris ir token-analytics snapshot'as imtų skirtingą „run'o pabaigą".
const outcomeStates = ANALYTICS_SNAPSHOT_STATES;
const failureStates = new Set(["human-review", "error", "failed"]);

export const failurePatternRecommendationThreshold = 3;

// Loop'as tą patį parkavimą įrašo dviem eilutėm: fazine ("preflight_failed=2",
// phase: "preflight") ir apibendrinta ("TASK HUMAN REVIEW: <id> ..."). Antroji —
// dublikatas, jos praleidimas saugo learning atmintį nuo dvigubų įrašų.
const duplicateSummaryReason = /^task human review:/i;

/**
 * Normalizuotas nesėkmės parašas: fazė + reason klasė be kintančių skaitiklių
 * ("preflight_failed=2" → "preflight:preflight_failed"), kad pakartojimai grupuotųsi
 * į vieną šabloną nepriklausomai nuo bandymo numerio.
 */
export function failureSignature(event: Pick<TaskEvent, "phase" | "to_state" | "reason">): string {
  const reasonClass = event.reason
    .toLowerCase()
    .replace(/=\d+/g, "")
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return `${event.phase ?? event.to_state}:${reasonClass || "unknown"}`;
}

export async function emitLearningEventsForTaskTransition(
  fs: LearningFsPort,
  runtimeRoot: string,
  event: TaskEvent,
): Promise<void> {
  try {
    if (!outcomeStates.has(event.to_state)) return;
    if (duplicateSummaryReason.test(event.reason)) return;

    await appendLearningMemoryRecord(fs, runtimeRoot, {
      type: "task_outcome",
      task_id: event.task_id,
      summary: `${event.to_state}: ${event.reason}`,
      labels: [event.to_state, ...(event.phase ? [event.phase] : [])],
      evidence: [event.reason, ...(event.exit_code !== undefined ? [`exit_code:${event.exit_code}`] : [])],
    });

    if (!failureStates.has(event.to_state)) return;

    const signature = failureSignature(event);
    await appendLearningMemoryRecord(fs, runtimeRoot, {
      type: "failure_pattern",
      task_id: event.task_id,
      summary: `Pasikartojanti nesėkmė: ${signature}`,
      labels: [signature, event.to_state],
      evidence: [event.reason],
    });

    // Rekomendacija keliama LYGIAI ties slenksčiu (===), ne kaskart virš jo — kitaip
    // kiekviena tolesnė to paties šablono nesėkmė dubliuotų pending rekomendaciją.
    const records = await readLearningMemoryRecords(fs, runtimeRoot);
    const occurrences = records.filter(
      (record) => record.type === "failure_pattern" && record.labels.includes(signature),
    );
    if (occurrences.length === failurePatternRecommendationThreshold) {
      const taskIds = Array.from(new Set(occurrences.map((record) => record.task_id).filter(Boolean))) as string[];
      await appendLearningMemoryRecord(fs, runtimeRoot, {
        type: "policy_recommendation",
        task_id: event.task_id,
        summary: `Peržiūrėti pasikartojančią nesėkmę: ${signature} (pasikartojo ${occurrences.length} kartus)`,
        labels: ["auto-emitted", signature],
        evidence: taskIds.map((taskId) => `task:${taskId}`),
        recommendation_status: "pending",
      });
    }
  } catch {
    /* learning emisija yra best-effort — niekada neblokuoja task apdorojimo */
  }
}
