// Cohort'ų bendri tipai (VQ-305 3/3-d skaidymas): etalone attempt-identity-join importavo
// šiuos tipus type-only iš compression-cohorts, o tas — reikšmes atgal, t. y. type-only
// ciklas. VERQESTRA gate draudžia ciklus net type-only, tad tipai gyvena atskirame -model
// faile: attempt-identity-join ir compression-cohorts abu importuoja IŠ ČIA, o
// compression-cohorts juos re-eksportuoja API paritetu.

/**
 * Intention-to-treat dimensija: `canary` = task'as buvo PARINKTAS canary kohortai (vėliausias
 * jo context-size įrašas neša bent vieną realų feature vardą), nepriklausomai nuo to, ar
 * kompiliuotas kūnas realiai išėjo. `control` = niekada nenešė realaus feature vardo.
 */
export type AssignmentArm = "canary" | "control";

/**
 * Per-protocol dimensija: kas realiai išėjo. `control` — nepriskirtas canary; `compressed` —
 * priskirtas ir kompiliuotas kūnas išsiųstas; `raw-fallback` — priskirtas, bet size guard
 * atmetė kompiliuotą kūną ir išsiuntė žalią task'ą — toks vykdymas matuoja control kelio
 * prompt'ą po canary-arm task'u ir NEGALI būti skaitomas kaip compressed įrodymas.
 */
export type AppliedArm = "compressed" | "raw-fallback" | "control";

/** Arm'ą sprendžiantis context-size įrašo poaibis (ContextSizeMetricsRecord jį tenkina). */
export type CohortContextSizeRecord = {
  ts?: string;
  task_id: string;
  /**
   * Pack'o biudžetas — vienintelis laukas, iš kurio `describesContextPack` atskiria realią
   * pack'o eilutę nuo sintetinių telemetrijos eilučių, kurias to paties task'o gyvavimo cikle
   * priduria dispatch finalize ir post-hook'ai (visos jos neša `0` ir niekada `canary_features`).
   * Projekcija jį PRIVALO pernešti: be jo „vėliausias laimi" skaitytojas demotuoja į control
   * kiekvieną canary task'ą (compression-audit-2026-09-03, 3 skyrius — 34 iš 34).
   */
  max_context_chars?: number;
  canary_features?: readonly string[];
  /** Pilna bandymo tapatybė (0045) — attempt-scoped join'ui. Pre-0045 įrašuose jos nėra. */
  run_id?: string;
  worker_id?: string;
  runtime_attempt_id?: string;
};

/** Baigtį nešantis token-usage įrašo poaibis. */
export type CohortTokenUsageRecord = {
  task_id: string;
  attempt?: number;
  retry_reason?: string;
  task_phase?: string;
  num_turns?: number;
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  /** Pilna bandymo tapatybė (0045); žr. {@link CohortContextSizeRecord}. */
  run_id?: string;
  worker_id?: string;
  runtime_attempt_id?: string;
};
