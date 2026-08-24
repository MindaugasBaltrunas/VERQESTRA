// Task ledger'io (`vq/state/task-ledger.json`) GRYNOSIOS taisyklės (etalono
// orchestrator/tasks/task-ledger.ts sprendimo pusė, VQ-304 3/3). Pats store skaitymas/rašymas
// yra `TaskLedgerPort` adapterio (E4) darbas — čia tik sprendimai, kuriuos jis taiko.
import path from "node:path";

/** Kanoninis ledger'io kelias. `runtimeRoot` — VERQESTRA runtime šaknis (`<root>/vq`). */
export function taskLedgerPath(runtimeRoot: string): string {
  return path.join(runtimeRoot, "state", "task-ledger.json");
}

/**
 * Child-task idempotency ledger'io kelias (kvietėjas — `composition/loop/coordinator-execution`).
 *
 * 2026-08-24: failo vardas ISTAISYTAS iš `child-task-ledger.json` į `child-tasks.json`, ir funkcija
 * PRIJUNGTA. Iki tol ji buvo be kvietėjo, o kompozicija tą patį kelią statė inline — su KITU vardu.
 * Tai buvo spąstai, ne tik dublikatas: kas nors, prijungęs šią „kanoninę" funkciją, būtų nukreipęs
 * skaitymą į tuščią failą ir TYLIAI praradęs idempotenciją, t. y. vaikinės užduotys būtų įrašytos
 * į eilę antrą kartą. Pataisytas vardas, o ne gyvasis kelias: taip esama apskaita nelieka orfanu.
 */
export function childTaskLedgerPath(runtimeRoot: string): string {
  return path.join(runtimeRoot, "state", "child-tasks.json");
}

export type TaskLedgerEntry = {
  task_name?: string;
  state?: string;
  file?: string;
  fingerprint?: string;
  updated_at?: string;
};

// RT-06 kanoninis sprendimas (terminal-state-vocabulary): "failed" niekada nėra realus
// terminalinis state — kvietėjai jo nebeperduoda, bet normalizacija lieka gynybinė, kad bet
// koks užklydęs "failed" įrašas nusileistų ant žodyno, kurį domain sluoksnis
// (normalizeTerminalBucket) realiai naudoja.
export function normalizeTaskLedgerState(state: string): string {
  return state === "failed" ? "human-review" : state;
}

/** Būsenos, kurių įrašas reiškia „šis task id jau matytas" (įsk. neužbaigtus parkus). */
const SEEN_STATES = ["active", "delegated", "human-review", "error", "done", "duplicate"];

/**
 * RT-09 (deep-audit): `currentFingerprint` yra failo, kuris tuoj bus paleistas šiuo taskId,
 * turinio hash'as. To paties vardo re-queue, kurio turinio hash'as vis dar sutampa su
 * paskutiniu ledger'io įrašu, yra tikras duplikatas; pakitęs turinys — teisėtas
 * re-run/re-issue, ir jo negalima numušti į human-review kaip „duplicate". Kvietėjai, kurie
 * `currentFingerprint` nepaduoda, gauna ankstesnį name-only elgesį.
 */
export function taskLedgerEntrySeenBefore(entry: TaskLedgerEntry | undefined, currentFingerprint?: string): boolean {
  const state = normalizeTaskLedgerState(entry?.state ?? "");
  if (!SEEN_STATES.includes(state)) {
    return false;
  }
  if (currentFingerprint && entry?.fingerprint && entry.fingerprint !== currentFingerprint) {
    return false;
  }
  return true;
}
