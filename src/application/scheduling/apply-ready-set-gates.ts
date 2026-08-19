// Kanoninio grafo vartai virš bangos plano (task 0001; spec PDAG-1/WAVE-1, design §9-§10).
// Behaviour etalon: AG_loop application/scheduling/apply-ready-set-gates.ts (1:1).
//
// Sistemoje yra DU sprendimų autoriai: schedule-next-wave sako „kokia yra ŠIOS bangos
// tvarka", build-ready-set — „kuriuos kanoninio grafo mazgus apskritai LEIDŽIAMA vykdyti".
// Naivus jų sujungimas būtų regresija (semantikos skiriasi sąmoningai), todėl vartai
// taikomi IŠORĖJE ir tik viena kryptimi: šis modulis gali task'ą PAŠALINTI iš `plan.ready`,
// bet niekada jo ten neįdeda ir niekada nekeičia likusiųjų tvarkos. Modulis grynas.
import type { BlockedTask, ReadySet, ReadySetBlockedReason } from "./build-ready-set.js";
import type { WaveBlockedTask, WavePlan } from "./schedule-next-wave.js";

/** Grafo vartas, kurį leidžiama taikyti bangos planui. Vardai bendri su `buildReadySet`. */
export type ReadySetGate = ReadySetBlockedReason;

/**
 * Numatytoji politika: tik biudžeto vartai. Sąmoningai TUŠČIAS numatytasis elgesys: be
 * `budget` įvesties `buildReadySet` šių priežasčių fiziškai negali sugeneruoti, tad
 * projekte be biudžeto planas lieka byte-for-byte toks pat. Likusios priežastys remiasi
 * grafo semantika, kuri su bangos semantika nesutampa — jų įjungimas yra eksplicitus
 * iškvietėjo sprendimas.
 */
export const DEFAULT_READY_SET_GATES: readonly ReadySetGate[] = ["budget-exhausted", "budget-insufficient"];

export type ReadySetGatePolicy = {
  /** Priežastys, kurias vartai taiko. Nenurodžius — {@link DEFAULT_READY_SET_GATES}. */
  enforce?: Iterable<ReadySetGate>;
};

/**
 * Uždeda grafo vartus ant jau sudaryto bangos plano.
 *
 * Invariantai (visi privalomi, visi vienakrypčiai):
 *   - SUBTRACT-ONLY: task'as gali pereiti tik `ready → blocked`; grafas negali atrakinti
 *     lūžusios šakos.
 *   - Likusių `ready` tvarka nekeičiama; bangos tapatybė — irgi.
 *   - Task'as, kurio grafe NĖRA, nefiltruojamas: nebuvimas nėra draudimas, o nepilna
 *     informacija.
 *   - Kai šalinamų nėra, grąžinamas TAS PATS objektas — nuorodos tapatybė yra įrodymas
 *     „vartai nieko nepakeitė".
 */
export function applyReadySetGates(plan: WavePlan, readySet: ReadySet | undefined, policy?: ReadySetGatePolicy): WavePlan {
  if (!readySet) return plan;

  const enforced = new Set<ReadySetGate>(policy?.enforce ?? DEFAULT_READY_SET_GATES);
  if (enforced.size === 0) return plan;

  const gates = new Map<string, BlockedTask>();
  for (const entry of readySet.blocked) {
    if (enforced.has(entry.reason)) gates.set(entry.task_id, entry);
  }
  if (gates.size === 0) return plan;

  const removed: WaveBlockedTask[] = [];
  const ready = plan.ready.filter((task) => {
    const gate = gates.get(task.task_id);
    if (!gate) return true;
    removed.push({
      task_id: task.task_id,
      file: task.file,
      // `blocked_by` imamas iš BANGOS įrašo: snapshot'o skaitytojui priklausomybės turi
      // atrodyti taip pat, nesvarbu, kuris sluoksnis task'ą sustabdė.
      blocked_by: [...task.blocked_by],
      // `gate:` prefiksas atskiria grafo vartą nuo bangos taisyklės — dvi skirtingos
      // priežastys niekada nesusilieja į vieną vardą.
      reason: `gate:${gate.reason}`,
      waiting_for: [...gate.waiting_for],
    });
    return false;
  });

  if (removed.length === 0) return plan;

  return {
    ...plan,
    ready,
    // Ta pati rūšiavimo taisyklė kaip `scheduleNextWave` (pagal failą), kad sujungtas
    // sąrašas liktų vienoje deterministinėje tvarkoje.
    blocked: [...plan.blocked, ...removed].sort((a, b) => a.file.localeCompare(b.file)),
  };
}

/** Kiek blokuotų task'ų vardijama vienoje priežasties eilutėje, kol pereinama į santrauką. */
const DEFAULT_BLOCKED_REASON_LIMIT = 5;

/**
 * Deterministinė „kodėl banga stovi" eilutė esamam wave event `reason` laukui.
 *
 * Formatavimo taisyklė turi būti VIENA: tą pačią eilutę mato log'as, wave event'as ir
 * operatoriaus stdout. Rūšiuojama pagal `task_id` (ne pagal failą), nes ID nesikeičia
 * task'ui persikėlus tarp bucket'ų.
 */
export function formatWaveBlockedReason(
  reason: string,
  blocked: readonly WaveBlockedTask[],
  options: { limit?: number } = {},
): string {
  if (blocked.length === 0) return reason;

  const limit = Math.max(0, Math.trunc(options.limit ?? DEFAULT_BLOCKED_REASON_LIMIT));
  const entries = [...blocked].sort((a, b) => a.task_id.localeCompare(b.task_id));
  const named = entries.slice(0, limit).map((task) => {
    const waiting = task.waiting_for.length > 0 ? `<-${task.waiting_for.join("+")}` : "";
    return `${task.task_id}=${task.reason}${waiting}`;
  });
  const overflow = entries.length - named.length;

  return [reason, ...named, ...(overflow > 0 ? [`+${overflow} more`] : [])].join("; ");
}
