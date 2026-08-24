// Task perėjimų žurnalo (`task-events.jsonl`) KONTRAKTAS ir grynosios formavimo taisyklės
// (etalono orchestrator/tasks/task-events.ts modelio pusė, VQ-304 3/3). Pats append/failų
// rašymas ir learning/analytics emisija — `TaskJournalPort` adapterio (E4; analytics — VQ-305)
// darbas: rašymas ten yra best-effort ir niekada nenutraukia task'o apdorojimo.

export type TaskEvent = {
  task_id: string;
  /** Bucket the task moved into: human-review | error | failed | done | queue | delegated | active | duplicate. */
  to_state: string;
  /** Short machine reason, mirrors the orchestrator.log message (e.g. "preflight_failed=2"). */
  reason: string;
  /** Pipeline phase, when applicable: preflight | resumed-preflight | diagnose | dispatch. */
  phase?: string;
  verdict?: string;
  exit_code?: number;
  /** Captured output tail explaining a failure (full output lives in tasks/<id>/<phase>.log). */
  detail?: string;
};

export const MAX_TASK_EVENT_DETAIL_CHARS = 2000;

/**
 * Tie patys terminaliniai perėjimai, į kuriuos reaguoja learning emiteris (task_outcome
 * įvykiai) — kiekvienas jų yra „run'o pabaiga" token-analytics snapshot'ui.
 */
export const ANALYTICS_SNAPSHOT_STATES: ReadonlySet<string> = new Set(["done", "human-review", "error", "failed"]);

/** Išvesties uodega `detail` laukui: pilna išvestis lieka `tasks/<id>/<phase>.log` faile. */
export function tailChars(text: string, maxChars: number = MAX_TASK_EVENT_DETAIL_CHARS): string {
  const trimmed = text.trimEnd();
  return trimmed.length <= maxChars ? trimmed : `...\n${trimmed.slice(trimmed.length - maxChars)}`;
}

// `phaseFailureReason(phase, exitCode)` → `"<phase>_failed=<code>"` PAŠALINTA 2026-08-24
// (operatoriaus radinys P3). Jos aprašas teigė, kad tai „ta pati eilutė, kurią rašo
// `recordPhaseFailure` adapteris" — NETIESA: produkcinis adapteris
// (`composition/loop/coordinator-adapters`) formuoja visai kitą eilutę
// (`PHASE FAILED: task=… phase=… exit=… <output>`) ir šios funkcijos niekada nekvietė. Vienintelis
// kvietėjas buvo jos pačios unit testas, tad testas saugojo formą, kurios niekas nenaudoja.
