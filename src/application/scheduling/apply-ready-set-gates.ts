// Kanoninio grafo vartai virš bangos plano (task 0001; spec PDAG-1/WAVE-1, design §9-§10).
// Behaviour etalon: AG_loop application/scheduling/apply-ready-set-gates.ts (1:1).
//
// Sistemoje yra DU sprendimų autoriai: schedule-next-wave sako „kokia yra ŠIOS bangos
// tvarka", build-ready-set — „kuriuos kanoninio grafo mazgus apskritai LEIDŽIAMA vykdyti".
// Naivus jų sujungimas būtų regresija (semantikos skiriasi sąmoningai), todėl vartai
// taikomi IŠORĖJE ir tik viena kryptimi: šis modulis gali task'ą PAŠALINTI iš `plan.ready`,
// bet niekada jo ten neįdeda ir niekada nekeičia likusiųjų tvarkos. Modulis grynas.
import { READY_SET_BLOCKED_REASONS, type BlockedTask, type ReadySet, type ReadySetBlockedReason } from "./build-ready-set.js";
import type { WaveBlockedTask, WavePlan } from "./schedule-next-wave.js";

/** Grafo vartas, kurį leidžiama taikyti bangos planui. Vardai bendri su `buildReadySet`. */
export type ReadySetGate = ReadySetBlockedReason;

/**
 * Numatytoji politika: VISOS kanoninio grafo priežastys.
 *
 * NUKRYPIMAS nuo etalono (griežtinantis, 2026-08-23 auditas). Etalone — ir VERQESTRA iki šios
 * dienos — numatytasis rinkinys buvo `["budget-exhausted", "budget-insufficient"]`, o pagrindimas
 * skambėjo taip: likusios priežastys remiasi grafo semantika, kuri su bangos semantika nesutampa,
 * tad jų įjungimas esąs „eksplicitus iškvietėjo sprendimas". Praktikoje to sprendimo nepriėmė
 * NIEKAS: nei etalono, nei VERQESTRA produkcinis wiring'as `readySetPolicy` niekada nepadavė, tad
 * `graph-invalid`, `missing-dependency`, `dependency-cycle`, `invalid-terminal-dependency` ir
 * `approval-required` verdiktai buvo skaičiuojami ir išmetami. Atkurta realiai:
 *
 *   priklausomybė į neegzistuojantį task'ą → grafas: `missing-dependency`, produkcija: VYKDOMA;
 *   `a → a`                               → grafas: neįvykdomas,          produkcija: VYKDOMA;
 *   `a(queue) → b(human-review) → a`      → grafas: neįvykdomas,          produkcija: VYKDOMA.
 *
 * Numatytoji reikšmė, kurią reikia „įjungti", kad ji ką nors saugotų, nėra vartai. Todėl kryptis
 * apversta: numatytai galioja VISKAS, ką kanoninis grafas atmeta, o susiaurinti gali tik
 * eksplicitus `enforce` (pvz. testai, tiriantys vieną priežastį).
 *
 * Bangos semantikos skirtumas išlieka ir yra būtent tai, ką vartai uždaro: `scheduleNextWave`
 * sąmoningai atlaidus (savęs nuoroda nuimama, eilėje nesantis blokatorius laikomas įvykdytu,
 * dviprasmiškas prefiksas sprendžiamas pirmu kandidatu), tad be šių vartų atlaidžioji pusė turėjo
 * paskutinį žodį. Dabar planuoklis atsako „kokia TVARKA", o grafas — „ar apskritai LEIDŽIAMA".
 */
export const DEFAULT_READY_SET_GATES: readonly ReadySetGate[] = READY_SET_BLOCKED_REASONS;

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

/**
 * Banga be kanoninio grafo: VISI `ready` task'ai perkeliami į `blocked`.
 *
 * NUKRYPIMAS nuo etalono (griežtinantis, 2026-08-23 auditas). Iki šiol neimportuotas grafas
 * reiškė `readySet === undefined`, o tai — „vartų nėra", tad banga eidavo VISAI be kanoninių
 * draudimų. Pagrindimas buvo „sustabdyta eilė dėl neperskaityto pagalbinio failo būtų blogesnis
 * mainas", ir jis galiojo tol, kol grafas buvo tik diagnostika. Nuo tada, kai grafas yra vartai,
 * jis apsivertė: negalėdami perskaityti autoriteto, negalime ĮRODYTI, kad task'ą leidžiama
 * vykdyti, o spėti čia draudžia ta pati taisyklė kaip visame ready-set kelyje.
 *
 * Importas nelūžta dėl to, kad bucket'o nėra (adapteris tokiu atveju grąžina tuščią sąrašą), tad
 * ši šaka reiškia tikrą gedimą: neperskaitomą task failą arba mazgą be panaudojamo id.
 *
 * Invariantas tas pats kaip `applyReadySetGates`: SUBTRACT-ONLY, bangos tapatybė nekinta, o
 * nesant ko šalinti grąžinamas TAS PATS objektas.
 */
export function blockWaveWithoutGraph(plan: WavePlan, detail: string): WavePlan {
  if (plan.ready.length === 0) return plan;
  const removed: WaveBlockedTask[] = plan.ready.map((task) => ({
    task_id: task.task_id,
    file: task.file,
    blocked_by: [...task.blocked_by],
    reason: "gate:graph-unavailable",
    waiting_for: [],
  }));
  return {
    ...plan,
    ready: [],
    blocked: [...plan.blocked, ...removed].sort((a, b) => a.file.localeCompare(b.file)),
    graph_unavailable_reason: detail,
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
