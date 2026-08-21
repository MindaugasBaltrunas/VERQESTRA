// Bangos ĮVYKIŲ žurnalas (`vq/logs/wave-events.jsonl`; etalonas: AG_loop
// orchestrator/loop/resume-checkpoint.ts `recordWaveEvent`).
//
// Šis žurnalas yra vienintelis dalykas, iš kurio po fakto matyti, KODĖL banga pasirinko būtent
// tą task'ą — snapshot'as rodo galutinę būseną, o ne kelią į ją. UI bangų vaizdas skaito būtent
// jį (per `readTailLines`).
//
// Rašymas BEST-EFFORT: telemetrijos eilutės praradimas negali sustabdyti bangos, kurią ji tik
// aprašo. Tai vienintelė vieta, kur toks nutylėjimas teisingas — visi kiti šio produkto
// žurnalai neša įrodymus, o šis neša istoriją.

import path from "node:path";
import { nodeFsAdapter } from "../fs/node-fs-adapter.js";

/** Vienas bangos gyvavimo įvykis. `event` yra atviras vardų rinkinys, ne enum — žr. žemiau. */
export type WaveEvent = {
  run_id: string;
  wave_id: string;
  graph_hash: string;
  /**
   * `wave_planned | wave_blocked | wave_drained | task_started | task_completed | task_failed |
   * task_branch_blocked | resume_decision`.
   *
   * Laisvas `string`, o ne enum, SĄMONINGAI: naujas įvykio tipas neturi lūžinėti prieš senesnį
   * skaitytoją, o žurnalas skaitomas ir iš senų failų, kuriuose gali gulėti jau pamiršti vardai.
   */
  event: string;
  task_id?: string;
  reason?: string;
  ready?: number;
  blocked?: number;
};

export function waveEventsPath(runtimeRoot: string): string {
  return path.join(runtimeRoot, "logs", "wave-events.jsonl");
}

/**
 * Įrašo vieną įvykį. NIEKADA nemeta.
 *
 * Laiko žyma dedama PIRMA (`ts` prieš spread'ą): jei kvietėjas kada nors atsiųstų savo `ts`,
 * jo reikšmė nugalėtų — įvykio laikas priklauso įvykiui, ne žurnalui.
 */
export async function recordWaveEvent(runtimeRoot: string, event: WaveEvent): Promise<void> {
  try {
    await nodeFsAdapter.appendTextFile(
      waveEventsPath(runtimeRoot),
      `${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`,
    );
  } catch {
    // Bangos telemetrija yra best-effort.
  }
}
